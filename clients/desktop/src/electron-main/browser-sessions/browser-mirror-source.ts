import {
  browserMirrorServerFrameSchema,
  type BrowserMirrorOpenRequest,
  type BrowserMirrorServerFrame,
} from "@traycer/protocol/host/browser/mirror-contracts";
import type { BrowserMirrorParams } from "@traycer/protocol/host/browser/contracts";
import type {
  IStreamSession,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { describeLogError, log } from "../app/logger";
import type {
  BrowserViewMirrorHandle,
  BrowserViewMirrorPort,
} from "../browser-view/manager/browser-view-mirror-capture";

export interface BrowserMirrorSourceDeps {
  readonly hostId: string;
  readonly tabs: BrowserViewMirrorPort;
  /**
   * Opens the `browser.mirror` subscription on the SAME stream client the
   * `browser.sessions` stream rides - one connection to the host, two logical
   * streams. Passed in rather than reached for so the suites can drive the
   * whole frame flow against a fake session.
   */
  readonly openStream: (request: BrowserMirrorOpenRequest) => IStreamSession;
}

export interface BrowserMirrorSource {
  /** Idempotent: stops the capture and closes the stream. */
  close(): void;
}

/**
 * One `browser.mirror` stream for one `mirrorRequest`.
 *
 * The stream is opened FIRST and the capture started behind it, because the
 * host allows ten seconds from the ask to the stream being open and a
 * `Page.startScreencast` can take a reattach to get going.
 *
 * The host ends a mirror by CLOSING this stream (there is no `stop` frame), so
 * a close - caller's or fatal - is the release path and the failure path at
 * once. It closes nothing else: this is its own `IStreamSession`, and the
 * sessions stream's session is untouched by a fatal error on this one.
 */
export function openBrowserMirrorSource(
  request: BrowserMirrorOpenRequest,
  params: BrowserMirrorParams,
  deps: BrowserMirrorSourceDeps,
  onClosed: () => void,
): BrowserMirrorSource {
  let handle: BrowserViewMirrorHandle | null = null;
  let closed = false;
  const session = deps.openStream(request);

  const close = (): void => {
    if (closed) return;
    closed = true;
    handle?.stop();
    handle = null;
    session.close();
    onClosed();
  };

  session.onServerFrame((envelope) => {
    if (closed) return;
    const frame = parseServerFrame(envelope);
    if (frame === null) return;
    handleServerFrame(frame, () => handle);
  });
  session.onStatusChange((status) => {
    // Terminal for this mirror however it ended: a refusal of the open request
    // and the host's own release both arrive as a fatal-error close, and
    // neither is something to retry - only a fresh `mirrorRequest` asks again.
    if (status === "closed") close();
  });

  void deps.tabs
    .startTabMirror(
      {
        hostId: deps.hostId,
        sessionId: request.sessionId,
        tabId: request.tabId,
        registrationId: request.registrationId,
      },
      params,
      {
        frame: (envelope, jpeg) => {
          if (closed) return;
          session.sendClientFrame(envelope, jpeg);
        },
        event: (frame) => {
          if (closed) return;
          session.sendClientFrame(frame, null);
        },
      },
    )
    .then((started) => {
      if (closed) {
        started?.stop();
        return;
      }
      if (started === null) {
        // A deliberate teardown never sends this; an incarnation the host still
        // believes in does, and the host counts it toward that tab's refusal
        // latch.
        session.sendClientFrame(
          {
            kind: "failed",
            hasBinaryPayload: false,
            reason: "mirror-tab-not-active",
          },
          null,
        );
        close();
        return;
      }
      handle = started;
    })
    .catch((cause: unknown) => {
      log.warn("[browser-sessions] mirror capture failed to start", {
        error: describeLogError(cause),
      });
      close();
    });

  return { close };
}

function parseServerFrame(
  envelope: StreamFrameEnvelope,
): BrowserMirrorServerFrame | null {
  const parsed = browserMirrorServerFrameSchema.safeParse(envelope);
  if (parsed.success) return parsed.data;
  // Issue paths only, never the envelope: a page-signal request carries page
  // coordinates and a dialog answer carries text the user typed.
  log.warn("[browser-sessions] mirror frame failed schema validation", {
    kind: envelope.kind,
    issues: parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)"))
      .join(", "),
  });
  return null;
}

function handleServerFrame(
  frame: BrowserMirrorServerFrame,
  currentHandle: () => BrowserViewMirrorHandle | null,
): void {
  const handle = currentHandle();
  switch (frame.kind) {
    case "ack":
      handle?.ack(frame.sequence);
      return;
    case "setParams":
      handle?.setParams({
        maxWidth: frame.maxWidth,
        maxHeight: frame.maxHeight,
        quality: frame.quality,
        everyNthFrame: frame.everyNthFrame,
      });
      return;
    case "dialogResponse":
      handle?.answerDialog(frame.dialogId, frame.accept, frame.promptText);
      return;
    case "describePoint":
    case "selectAt":
    case "expandSelection":
    case "readSelection":
    case "clearSelection":
    case "blurEditable":
    case "setZoom":
      handleMirrorPageSignal(frame);
      return;
  }
}

/**
 * TODO(T10): the page-signal half of the mirror.
 *
 * T10 installs the shared page scripts (`@traycer/protocol/host/browser/page-scripts`)
 * through `BrowserDebugSession.installScriptBeforeNavigation` plus a second
 * `Runtime.addBinding`, and answers these here - `describePoint` /
 * `readSelection` echoing `requestId` AND `subscriberId` back on
 * `pointDescribed` / `selectionText`, `editableFocus` arriving unsolicited with
 * a `subscriberId` and no request id, and `setZoom` going out as
 * `Emulation.setPageScaleFactor`. The coordinates arrive in raw page CSS px,
 * already resolved host-side, so nothing here has to correlate a frame.
 *
 * Until then a signal is logged and dropped: a viewer's long-press simply never
 * gets an answer, which is the same outcome as a host that never asked.
 */
function handleMirrorPageSignal(frame: BrowserMirrorServerFrame): void {
  log.debug("[browser-sessions] mirror page signal is not served yet", {
    kind: frame.kind,
  });
}
