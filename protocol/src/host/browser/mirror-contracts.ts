/**
 * `browser.mirror@1.0` - the desktop's native tab as a frame SOURCE.
 *
 * The third `browser.*` stream, and the only one the desktop opens rather than
 * the GUI. When a tab is placed natively on a co-located desktop, the host has
 * no pixels of its own for it: the guest lives in the desktop's renderer.
 * Placement demotion used to solve that by tearing the native tab down and
 * re-opening it headless; this stream replaces that with a mirror - the desktop
 * runs `Page.startScreencast` on its own `<webview>` and pumps frames to the
 * host, which fans them out to every `browser.screencast` subscriber of that
 * tab. The tab never moves.
 *
 * Direction naming follows the framework, not the topology: the DESKTOP is the
 * stream's client here, so `clientFrameSchema` is desktop -> host (frames, tab
 * events, page-signal answers) and `serverFrameSchema` is host -> desktop (acks,
 * pump params, page-signal requests).
 *
 * It is exempt from the `browser.*` namespace freeze
 * (`host/__tests__/released-stream-surface-compat.test.ts`) because the freeze
 * exists to stop the GUI from feature-detecting browser support by a sibling
 * method name. This method is never in a GUI's capability check: only the
 * Electron main process opens it, and only after the host asked it to with a
 * `mirrorRequest`.
 *
 * The host ends a mirror by CLOSING the stream. There is no `stop` frame,
 * because a close is the one signal that cannot be lost.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  browserEditableFocusFields,
  browserMirrorParamsSchema,
  browserNavStateSchema,
  browserPointDescribedFields,
  browserScreencastMetadataSchema,
  browserScreencastUnsupportedFeatureSchema,
  browserSelectionTextFields,
  browserViewportGeometrySchema,
} from "@traycer/protocol/host/browser/contracts";

/**
 * Re-exported so either import path names the same schema. It is DEFINED in
 * `contracts.ts` because the `mirrorRequest` server frame there needs the
 * value, and this module needs `browserScreencastMetadataSchema` from there -
 * owning it here would make the two modules a value-level import cycle, in
 * which whichever zod const evaluated second would read `undefined`.
 */
export {
  browserMirrorParamsSchema,
  type BrowserMirrorParams,
} from "@traycer/protocol/host/browser/contracts";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

const binaryFrameFields = {
  hasBinaryPayload: z.literal(true),
} as const;

/**
 * `mirrorId` is the host-minted id from the `mirrorRequest` that asked for this
 * stream; a host refuses an id it did not mint, which is what keeps a stray or
 * replayed open from attaching to a tab nobody asked to mirror. The other three
 * are echoed so the host can bind the stream to the same registration without
 * trusting the id alone.
 */
export const browserMirrorOpenRequestSchema = z
  .object({
    mirrorId: z.string(),
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
  })
  .strict();
export type BrowserMirrorOpenRequest = z.infer<
  typeof browserMirrorOpenRequestSchema
>;

/**
 * Which subscriber a page signal belongs to.
 *
 * One mirror serves every viewer of the tab, but a `describePoint` is one
 * reader's question and its answer must not fan out to the others. The host
 * mints the id, stamps it on the request, and routes the answer back by it; the
 * desktop only echoes it.
 */
const mirrorSubscriberFields = {
  subscriberId: z.string(),
} as const;

/**
 * Desktop -> host.
 *
 * The tab-event arms exist because the host's own `handleDriverTabEvent` never
 * fires for an electron-placed session - there is no headless driver behind the
 * tab to emit them - so navigation, dialogs, closes and crashes have to travel
 * on this stream or they do not travel at all.
 */
export const browserMirrorClientFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      // One JPEG, binary payload. `metadata` is `browserScreencastMetadata`
      // VERBATIM - `offsetTop` included, every field required - because the
      // host forwards it onto `browser.screencast` unchanged, and a mirror that
      // omitted a field would fail that strict parse at fan-out rather than
      // here.
      kind: z.literal("frame"),
      ...binaryFrameFields,
      // The mirror's OWN sequence space. The host re-sequences per subscriber,
      // so this number is only ever compared against this stream's acks.
      sequence: z.number().int().nonnegative(),
      metadata: browserScreencastMetadataSchema,
      // The geometry this frame was actually captured at, which the guest's own
      // layout decides rather than the host's request. Fan-out needs it to size
      // hit testing, and it is per-frame because a `<webview>` resize commits
      // between frames.
      applied: browserViewportGeometrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("viewportEpoch"),
      ...textFrameFields,
      epoch: z.number().int().nonnegative(),
      logicalViewport: browserViewportGeometrySchema,
    })
    .strict(),
  z
    .object({
      // Full snapshot, from `Page.frameNavigated` plus
      // `Page.getNavigationHistory`; consumers never reconstruct deltas.
      kind: z.literal("navState"),
      ...textFrameFields,
      ...browserNavStateSchema.shape,
    })
    .strict(),
  z
    .object({
      // From `Page.javascriptDialogOpening`. `dialogId` is the desktop's own
      // token: the host relays a `dialogResponse` naming it, and the desktop
      // answers with `Page.handleJavaScriptDialog`, which is also what
      // dismisses the native sheet the guest put up.
      kind: z.literal("dialogOpened"),
      ...textFrameFields,
      dialogId: z.string(),
      type: z.enum(["alert", "beforeunload", "confirm", "prompt"]),
      message: z.string().max(4096),
      defaultPrompt: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      // From `Page.javascriptDialogClosed` - including a dialog the USER
      // settled in the desktop window, which is why this is its own frame and
      // not an ack of `dialogResponse`.
      kind: z.literal("dialogSettled"),
      ...textFrameFields,
      dialogId: z.string(),
    })
    .strict(),
  z
    .object({
      // A guest interaction the mirror cannot serve to a remote viewer.
      // `feature` rather than `kind`, which is the union's discriminator, and
      // the SAME closed vocabulary the screencast frame carries so the host
      // forwards it without a mapping table.
      kind: z.literal("unsupportedInteraction"),
      ...textFrameFields,
      feature: browserScreencastUnsupportedFeatureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tabClosed"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("crashed"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("editableFocus"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      ...browserEditableFocusFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pointDescribed"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      requestId: z.string(),
      ...browserPointDescribedFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selectionText"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      requestId: z.string(),
      ...browserSelectionTextFields,
    })
    .strict(),
  z
    .object({
      // The pump has produced nothing for long enough that the desktop knows
      // it, rather than the host inferring it from silence.
      kind: z.literal("stalled"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      ...textFrameFields,
      reason: z.string().max(256),
    })
    .strict(),
]);
export type BrowserMirrorClientFrame = z.infer<
  typeof browserMirrorClientFrameSchema
>;

/**
 * Host -> desktop.
 *
 * `ack` is the whole flow control: the desktop holds the next
 * `Page.screencastFrame` ack until the host acks the sequence, so a slow
 * consumer slows the producer instead of filling a queue. The host acks on the
 * FASTEST subscriber, so one stalled viewer cannot stop the pump for the rest.
 */
export const browserMirrorServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ack"),
      ...textFrameFields,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      // Re-size or re-quality the pump mid-stream: the host recomputes it as
      // subscribers come and go, since the params are the union of what they
      // need.
      kind: z.literal("setParams"),
      ...textFrameFields,
      ...browserMirrorParamsSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dialogResponse"),
      ...textFrameFields,
      dialogId: z.string(),
      accept: z.boolean(),
      promptText: z.string().max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      // Page CSS pixels, already resolved host-side from the requesting
      // subscriber's presented-frame geometry - the normalized point and its
      // `castSequence`/`viewportEpoch` correlation never leave the host, so the
      // desktop needs no frame bookkeeping of its own.
      kind: z.literal("describePoint"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      requestId: z.string(),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("selectAt"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("expandSelection"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      unit: z.enum(["sentence", "paragraph", "all"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("readSelection"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      requestId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clearSelection"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("blurEditable"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
    })
    .strict(),
  z
    .object({
      // Visual (pinch) scale via `Emulation.setPageScaleFactor`, not layout
      // zoom - the guest must not reflow, or every subscriber's hit testing
      // goes stale at once.
      kind: z.literal("setZoom"),
      ...textFrameFields,
      ...mirrorSubscriberFields,
      factor: z.number().min(0.25).max(5),
    })
    .strict(),
]);
export type BrowserMirrorServerFrame = z.infer<
  typeof browserMirrorServerFrameSchema
>;

export const browserMirrorV10 = defineStreamRpcContract({
  method: "browser.mirror",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserMirrorOpenRequestSchema,
  serverFrameSchema: browserMirrorServerFrameSchema,
  clientFrameSchema: browserMirrorClientFrameSchema,
});
