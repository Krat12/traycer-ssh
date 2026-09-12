import { randomUUID } from "node:crypto";
import type {
  BrowserMirrorParams,
  BrowserScreencastMetadata,
  BrowserScreencastUnsupportedFeature,
  BrowserViewportGeometry,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserMirrorClientFrame } from "@traycer/protocol/host/browser/mirror-contracts";
import type {
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";
import type {
  BrowserDebugCdpEvent,
  BrowserDebugSession,
} from "../debug/browser-debug-session";
import { boundedString, numberValue, recordValue } from "../guards";
import {
  BrowserViewMirrorPageSignals,
  type BrowserMirrorPageSignalFrame,
} from "./browser-view-mirror-page-signals";
import type { BrowserViewEntry } from "./browser-view-entry";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import {
  readGuestViewportGeometry,
  type BrowserViewViewport,
} from "./browser-view-viewport";

/** The one binary arm of the mirror's client union, minus its payload. */
export type BrowserMirrorFrameEnvelope = Extract<
  BrowserMirrorClientFrame,
  { readonly kind: "frame" }
>;

/** Everything else the desktop sends on a mirror: text frames only. */
export type BrowserMirrorEventFrame = Exclude<
  BrowserMirrorClientFrame,
  { readonly kind: "frame" }
>;

/**
 * Where a capture's output goes. Implemented by the `browser.mirror` stream
 * source, which is the only thing that knows the socket; this module knows the
 * guest and nothing about the wire beyond the frame shapes.
 */
export interface BrowserViewMirrorSink {
  frame(envelope: BrowserMirrorFrameEnvelope, jpeg: Uint8Array): void;
  event(frame: BrowserMirrorEventFrame): void;
}

/** What the stream source may ask of a running capture. */
export interface BrowserViewMirrorHandle {
  /** Cumulative and monotonic: the host's fastest subscriber decides it. */
  ack(sequence: number): void;
  setParams(params: BrowserMirrorParams): void;
  answerDialog(
    dialogId: string,
    accept: boolean,
    promptText: string | null,
  ): void;
  /**
   * One host page-signal request (D13-D15). The answer, where there is one,
   * leaves on the same sink the frames do, carrying the requesting
   * subscriber's id back.
   */
  pageSignal(frame: BrowserMirrorPageSignalFrame): void;
  stop(): void;
}

/**
 * The native half of a `browser.mirror`: `Page.startScreencast` on one guest,
 * with a `capturePage` poller behind it for the states a screencast does not
 * survive.
 */
export interface BrowserViewMirrorPort {
  /** `null` when that exact incarnation is not live on this desktop. */
  startTabMirror(
    tab: BrowserViewNativeTabCapability,
    params: BrowserMirrorParams,
    sink: BrowserViewMirrorSink,
  ): Promise<BrowserViewMirrorHandle | null>;
}

/**
 * Poll interval for the hidden-window fallback - 5 fps, the same ceiling PiP
 * capture settled on for the same reason: a full-frame `capturePage` is not
 * cheap and a mirror of a window nobody is looking at does not need more.
 */
const MIRROR_POLL_INTERVAL_MS = 200;

/**
 * How long the screencast may go quiet before the poller takes over. One second
 * is long enough that an idle page (which produces no frames because nothing
 * changed) costs at most one polled frame, and short enough that a viewer who
 * minimized the window sees motion resume rather than a freeze.
 */
const MIRROR_SCREENCAST_SILENCE_MS = 1_000;

/** No frame of ANY kind for this long is reported as a stall, once per gap. */
const MIRROR_STALL_MS = 3_000;

/**
 * Chromium's own screencast window: at most two frames may be unacked. The
 * poller honours the same bound against the HOST's ack, so a slow viewer slows
 * the poller instead of filling a queue it cannot drain.
 */
const MIRROR_MAX_UNACKED_FRAMES = 2;

interface PendingCdpAck {
  readonly sequence: number;
  readonly cdpSessionId: number;
}

interface ActiveMirror {
  readonly entry: BrowserViewEntry;
  readonly sink: BrowserViewMirrorSink;
  readonly debug: BrowserDebugSession;
  readonly signals: BrowserViewMirrorPageSignals;
  params: BrowserMirrorParams;
  offCdpEvent: () => void;
  /** The mirror's own sequence space; the host re-sequences per subscriber. */
  nextSequence: number;
  ackedThrough: number;
  /** CDP acks held back until the host has acked the frame they belong to. */
  pendingCdpAcks: PendingCdpAck[];
  applied: BrowserViewportGeometry;
  /** Last polled JPEG, so an unchanging page costs no wire traffic. */
  lastPolledJpeg: Uint8Array | null;
  epoch: number;
  lastFrameAt: number;
  watchdog: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  geometryRefreshInFlight: boolean;
  openDialogId: string | null;
  stalledReported: boolean;
  terminalSent: boolean;
  stopped: boolean;
}

interface BrowserViewMirrorCaptureOptions {
  readonly debugSessions: BrowserViewDebugSessions;
  readonly viewport: BrowserViewViewport;
  readonly now: () => number;
}

/**
 * One capture per mirrored guest, fanned out host-side.
 *
 * A CDP session carries exactly one `Page.startScreencast`, so this is the
 * whole producer for every remote viewer of a tab - the host gives each
 * subscriber its own sequence space, ack book and quality ladder on top of the
 * single stream this pumps.
 */
export class BrowserViewMirrorCapture {
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly viewport: BrowserViewViewport;
  private readonly now: () => number;
  private readonly active = new Map<BrowserViewEntry, ActiveMirror>();

  constructor(options: BrowserViewMirrorCaptureOptions) {
    this.debugSessions = options.debugSessions;
    this.viewport = options.viewport;
    this.now = options.now;
  }

  async start(
    entry: BrowserViewEntry,
    params: BrowserMirrorParams,
    sink: BrowserViewMirrorSink,
  ): Promise<BrowserViewMirrorHandle | null> {
    this.stop(entry);
    // For the mirror's whole life, restored on every exit path below - the
    // discipline PiP capture already keeps. Without it a minimized or occluded
    // window stops painting and there is nothing to capture by either route.
    entry.webContents.setBackgroundThrottling(false);
    const debug = this.debugSessions.ensure(entry);
    const mirror: ActiveMirror = {
      entry,
      sink,
      debug,
      signals: new BrowserViewMirrorPageSignals({
        debug,
        guestKey: entry.guestKey,
        emit: (frame) => {
          sink.event(frame);
        },
        onZoomApplied: () => {
          // The frames already carry the new `pageScaleFactor`; the epoch is
          // what tells every viewer its hit testing has to be re-derived.
          this.mintViewportEpoch(mirror);
        },
      }),
      params,
      offCdpEvent: () => undefined,
      nextSequence: 0,
      ackedThrough: -1,
      pendingCdpAcks: [],
      applied: { width: 1, height: 1, dpr: 1 },
      lastPolledJpeg: null,
      epoch: 0,
      lastFrameAt: this.now(),
      watchdog: null,
      pollTimer: null,
      polling: false,
      geometryRefreshInFlight: false,
      openDialogId: null,
      stalledReported: false,
      terminalSent: false,
      stopped: false,
    };
    this.active.set(entry, mirror);
    try {
      await debug.enableAfterCommit();
      mirror.offCdpEvent = debug.onCdpEvent((event) => {
        this.handleCdpEvent(mirror, event);
      });
      // BEFORE the first frame: `applied` is per-frame and the host sizes its
      // hit testing with it, so a frame carrying the placeholder would be a
      // frame the viewer cannot click accurately. It swallows its own failure -
      // an unreadable viewport is not a reason to have no pixels at all.
      await this.refreshGeometry(mirror);
      await this.startScreencast(mirror);
      // After the pixels, and it never throws: a mirror whose page signals
      // could not be installed is still a mirror.
      await mirror.signals.install();
    } catch (error) {
      log.warn("[browser-view] mirror capture could not start", {
        guestKey: entry.guestKey,
        error: describeLogError(error),
      });
      this.stop(entry);
      return null;
    }
    if (mirror.stopped) return null;
    mirror.watchdog = setInterval(() => {
      this.checkLiveness(mirror);
    }, MIRROR_SCREENCAST_SILENCE_MS);
    mirror.watchdog.unref();
    return {
      ack: (sequence) => {
        this.handleAck(mirror, sequence);
      },
      setParams: (next) => {
        mirror.params = next;
        void this.startScreencast(mirror).catch((error: unknown) => {
          this.failMirror(mirror, "screencast-restart-failed", error);
        });
      },
      answerDialog: (dialogId, accept, promptText) => {
        this.answerDialog(mirror, dialogId, accept, promptText);
      },
      pageSignal: (frame) => {
        mirror.signals.handle(frame);
      },
      stop: () => {
        this.stop(entry);
      },
    };
  }

  /**
   * A detach is not recoverable by itself: `resetDetachedState` clears the
   * enabled flag and the re-enable list is Page/Runtime/Log/Network/DOM only,
   * so the domains come back after a reattach and the screencast does not.
   */
  handleDetached(entry: BrowserViewEntry): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    void this.restartAfterDetach(mirror);
  }

  /** The status reading the tab already publishes, as the mirror's `navState`. */
  notifyStatus(
    entry: BrowserViewEntry,
    change: BrowserViewNativeTabStatusChange,
  ): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    mirror.sink.event({
      kind: "navState",
      hasBinaryPayload: false,
      url: change.url,
      canGoBack: change.canGoBack,
      canGoForward: change.canGoForward,
      loading: change.status === "loading",
    });
    if (change.status !== "dead") return;
    this.sendTerminal(mirror, { kind: "crashed", hasBinaryPayload: false });
  }

  /** A guest interaction a remote viewer cannot be shown (D19). */
  notifyUnsupported(
    entry: BrowserViewEntry,
    feature: BrowserScreencastUnsupportedFeature,
  ): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    mirror.sink.event({
      kind: "unsupportedInteraction",
      hasBinaryPayload: false,
      feature,
    });
  }

  /**
   * The guest is going away. Terminal for THIS mirror only - the durable tab
   * may well be re-materialized later; the host ends the stream either way.
   */
  notifyClosed(entry: BrowserViewEntry): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    this.sendTerminal(mirror, { kind: "tabClosed", hasBinaryPayload: false });
    this.stop(entry);
  }

  /** A viewport apply landed: re-measure and mint the next epoch. */
  notifyViewportApplied(entry: BrowserViewEntry): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    void this.refreshGeometry(mirror);
  }

  stop(entry: BrowserViewEntry): void {
    const mirror = this.active.get(entry);
    if (mirror === undefined) return;
    this.active.delete(entry);
    mirror.stopped = true;
    if (mirror.watchdog !== null) clearInterval(mirror.watchdog);
    if (mirror.pollTimer !== null) clearTimeout(mirror.pollTimer);
    mirror.offCdpEvent();
    // The last mirror of this tab takes the scripts and the binding with it;
    // the annotation overlay's own binding on the same attachment is untouched.
    mirror.signals.dispose();
    if (mirror.debug.isReady()) {
      void mirror.debug
        .sendCommand("Page.stopScreencast", {}, undefined)
        .catch(() => undefined);
    }
    // ponytail: one boolean shared with PiP capture, so a mirror release
    // re-enables throttling under a live PiP on the same guest. Pre-existing
    // shape; a per-consumer suppression count is the fix if both ever run at
    // once on one tab.
    if (!entry.webContents.isDestroyed()) {
      entry.webContents.setBackgroundThrottling(true);
    }
  }

  private startScreencast(mirror: ActiveMirror): Promise<unknown> {
    return mirror.debug.sendCommand(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: mirror.params.quality,
        maxWidth: mirror.params.maxWidth,
        maxHeight: mirror.params.maxHeight,
        everyNthFrame: mirror.params.everyNthFrame,
      },
      undefined,
    );
  }

  private async restartAfterDetach(mirror: ActiveMirror): Promise<void> {
    // A detach whose cause is the guest going away is a CLOSE, not a failure:
    // `failed` is retryable and the host would spend its refusal latch asking
    // for a mirror of a tab that no longer exists.
    if (mirror.entry.webContents.isDestroyed()) {
      this.notifyClosed(mirror.entry);
      return;
    }
    try {
      await mirror.debug.enableAfterCommit();
      if (mirror.stopped) return;
      await this.startScreencast(mirror);
    } catch (error) {
      this.failMirror(mirror, "debugger-detached", error);
      return;
    }
    // The reattached target has a fresh ack space; nothing held for the old
    // one can be acked, and holding it would stall the new stream forever.
    mirror.pendingCdpAcks = [];
    void this.refreshGeometry(mirror);
    // Neither the binding nor the on-new-document scripts survive a reattach:
    // `resetDetachedState` clears the enabled flag and the re-enable list is
    // domains only.
    void mirror.signals.install();
  }

  private handleCdpEvent(
    mirror: ActiveMirror,
    event: BrowserDebugCdpEvent,
  ): void {
    // Child (OOPIF) targets get their own session id. The screencast, the
    // dialogs and the resize this cares about are all the main target's.
    if (event.sessionId !== undefined) return;
    if (event.method === "Page.screencastFrame") {
      this.handleScreencastFrame(mirror, event.params);
      return;
    }
    if (event.method === "Page.javascriptDialogOpening") {
      this.handleDialogOpening(mirror, event.params);
      return;
    }
    if (event.method === "Page.javascriptDialogClosed") {
      this.handleDialogClosed(mirror);
      return;
    }
    if (event.method === "Page.frameResized") {
      void this.refreshGeometry(mirror);
      return;
    }
    // Main frame only: a page full of iframes fires this per subframe, and a
    // re-measure per iframe is both a JS eval each and - without the
    // did-it-change guard in `refreshGeometry` - an epoch bump that would
    // invalidate input a viewer had already correlated.
    if (
      event.method === "Page.frameNavigated" &&
      recordValue(event.params.frame)?.parentId === undefined
    ) {
      void this.refreshGeometry(mirror);
    }
  }

  private handleScreencastFrame(
    mirror: ActiveMirror,
    params: Record<string, unknown>,
  ): void {
    const data = params.data;
    const cdpSessionId = numberValue(params.sessionId);
    if (typeof data !== "string" || cdpSessionId === null) return;
    // A real frame arrived, so whatever the window's visibility is doing, the
    // screencast is alive: the poller has nothing to add.
    this.stopPolling(mirror);
    mirror.lastFrameAt = this.now();
    mirror.stalledReported = false;
    const sequence = this.emitFrame(
      mirror,
      screencastMetadata(params.metadata),
      Buffer.from(data, "base64"),
    );
    mirror.pendingCdpAcks.push({ sequence, cdpSessionId });
    this.flushCdpAcks(mirror);
  }

  private emitFrame(
    mirror: ActiveMirror,
    metadata: BrowserScreencastMetadata,
    jpeg: Uint8Array,
  ): number {
    const sequence = mirror.nextSequence;
    mirror.nextSequence += 1;
    mirror.sink.frame(
      {
        kind: "frame",
        hasBinaryPayload: true,
        sequence,
        metadata,
        applied: mirror.applied,
      },
      jpeg,
    );
    return sequence;
  }

  private handleAck(mirror: ActiveMirror, sequence: number): void {
    // Cumulative and monotonic, and a higher ack may skip sequences the fastest
    // viewer never reported individually - so this is a floor, never a match.
    if (sequence <= mirror.ackedThrough) return;
    mirror.ackedThrough = sequence;
    this.flushCdpAcks(mirror);
  }

  /**
   * Chromium stops producing after two unacked frames, so the CDP ack is the
   * brake: held until the HOST has acked the frame it belongs to, which makes
   * the slowest link in the chain the one that sets the rate.
   */
  private flushCdpAcks(mirror: ActiveMirror): void {
    while (mirror.pendingCdpAcks.length > 0) {
      const pending = mirror.pendingCdpAcks[0];
      if (pending.sequence > mirror.ackedThrough) return;
      mirror.pendingCdpAcks.shift();
      void mirror.debug
        .sendCommand(
          "Page.screencastFrameAck",
          { sessionId: pending.cdpSessionId },
          undefined,
        )
        .catch(() => undefined);
    }
  }

  private handleDialogOpening(
    mirror: ActiveMirror,
    params: Record<string, unknown>,
  ): void {
    const dialogId = randomUUID();
    mirror.openDialogId = dialogId;
    mirror.sink.event({
      kind: "dialogOpened",
      hasBinaryPayload: false,
      dialogId,
      type: dialogType(params.type),
      message: boundedString(params.message, 4096, ""),
      defaultPrompt: boundedString(params.defaultPrompt, 4096, ""),
    });
  }

  /**
   * Its own frame rather than an ack of `dialogResponse`, because the person at
   * the Mac can answer the native sheet themselves and the viewer has to be
   * told either way.
   */
  private handleDialogClosed(mirror: ActiveMirror): void {
    const dialogId = mirror.openDialogId;
    if (dialogId === null) return;
    mirror.openDialogId = null;
    mirror.sink.event({
      kind: "dialogSettled",
      hasBinaryPayload: false,
      dialogId,
    });
  }

  private answerDialog(
    mirror: ActiveMirror,
    dialogId: string,
    accept: boolean,
    promptText: string | null,
  ): void {
    // A `dialogResponse` races the sheet the user may have just answered
    // themselves, so a stale id is an ordinary outcome, not an error.
    if (mirror.openDialogId !== dialogId) return;
    void mirror.debug
      .sendCommand(
        "Page.handleJavaScriptDialog",
        promptText === null ? { accept } : { accept, promptText },
        undefined,
      )
      .catch(() => undefined);
  }

  private checkLiveness(mirror: ActiveMirror): void {
    const silentFor = this.now() - mirror.lastFrameAt;
    if (silentFor < MIRROR_SCREENCAST_SILENCE_MS) return;
    this.startPolling(mirror);
    if (silentFor < MIRROR_STALL_MS || mirror.stalledReported) return;
    mirror.stalledReported = true;
    mirror.sink.event({ kind: "stalled", hasBinaryPayload: false });
  }

  private startPolling(mirror: ActiveMirror): void {
    if (mirror.polling || mirror.stopped) return;
    mirror.polling = true;
    void this.pollFrame(mirror);
  }

  private stopPolling(mirror: ActiveMirror): void {
    mirror.polling = false;
    if (mirror.pollTimer !== null) {
      clearTimeout(mirror.pollTimer);
      mirror.pollTimer = null;
    }
  }

  /**
   * The D09 fallback: a window Chromium has stopped screencasting still answers
   * `capturePage`, which forces a paint of the hidden page.
   */
  private async pollFrame(mirror: ActiveMirror): Promise<void> {
    if (!mirror.polling || mirror.stopped) return;
    const entry = mirror.entry;
    if (entry.webContents.isDestroyed()) return;
    // ponytail: a polled frame is not resized to `maxWidth`/`maxHeight` -
    // the captured-image port has `crop` and no `resize`, and the screencast
    // (which Chromium scales itself) is the path that carries the pixels
    // whenever the window is producing any. Add a resize to the port if a
    // retina desktop's fallback frames measure too large on a phone.
    try {
      const metadata = await this.polledMetadata(mirror);
      if (!mirror.polling || mirror.stopped) return;
      if (
        mirror.nextSequence - mirror.ackedThrough <=
        MIRROR_MAX_UNACKED_FRAMES
      ) {
        const image = await entry.webContents.capturePage();
        if (!mirror.polling || mirror.stopped) return;
        if (!image.isEmpty()) {
          const jpeg = image.toJPEG(mirror.params.quality);
          if (jpeg.byteLength > 0) {
            // A capture that SUCCEEDED is the liveness evidence, whether or not
            // it is worth sending: an idle page produces identical bytes, and
            // reporting that as a stall would put a spinner over a page that is
            // simply not changing.
            mirror.lastFrameAt = this.now();
            mirror.stalledReported = false;
            if (!sameBytes(mirror.lastPolledJpeg, jpeg)) {
              mirror.lastPolledJpeg = jpeg;
              this.emitFrame(mirror, metadata, jpeg);
            }
          }
        }
      }
    } catch (error) {
      log.warn("[browser-view] mirror fallback capture failed", {
        guestKey: entry.guestKey,
        error: describeLogError(error),
      });
    }
    if (!mirror.polling || mirror.stopped) return;
    mirror.pollTimer = setTimeout(() => {
      mirror.pollTimer = null;
      void this.pollFrame(mirror);
    }, MIRROR_POLL_INTERVAL_MS);
  }

  /**
   * Synthesized, because a polled frame has no CDP metadata: the scroll offset
   * and page scale come from `Page.getLayoutMetrics` and `offsetTop` is 0 (a
   * `capturePage` never carries the top chrome a screencast can).
   */
  private async polledMetadata(
    mirror: ActiveMirror,
  ): Promise<BrowserScreencastMetadata> {
    const fallback: BrowserScreencastMetadata = {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: mirror.applied.width,
      deviceHeight: mirror.applied.height,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: this.now() / 1_000,
    };
    if (!mirror.debug.isReady()) return fallback;
    const metrics = await mirror.debug
      .sendCommand("Page.getLayoutMetrics", {}, undefined)
      .catch(() => null);
    const viewport = recordValue(recordValue(metrics)?.cssVisualViewport);
    if (viewport === null) return fallback;
    return {
      ...fallback,
      pageScaleFactor: numberValue(viewport.scale) ?? 1,
      deviceWidth: numberValue(viewport.clientWidth) ?? fallback.deviceWidth,
      deviceHeight: numberValue(viewport.clientHeight) ?? fallback.deviceHeight,
      scrollOffsetX: numberValue(viewport.pageX) ?? 0,
      scrollOffsetY: numberValue(viewport.pageY) ?? 0,
    };
  }

  /**
   * Re-measures the guest and mints the next viewport epoch. Every frame after
   * it carries the new `applied`, which is what a viewer correlates its input
   * against; a resize that did not mint one would have the host hit-testing
   * against a layout that no longer exists.
   */
  private async refreshGeometry(mirror: ActiveMirror): Promise<void> {
    if (mirror.geometryRefreshInFlight || mirror.stopped) return;
    mirror.geometryRefreshInFlight = true;
    try {
      const geometry = await readGuestViewportGeometry(
        mirror.entry.webContents,
        this.viewport.emulation(mirror.entry)?.mobile === true,
        AbortSignal.timeout(4_000),
      );
      if (mirror.stopped) return;
      // An epoch is what a viewer's input is correlated against, so it is minted
      // only when the layout ACTUALLY moved. A re-measure that reads the same
      // numbers (a navigation, a same-size apply) must not invalidate input
      // that is already in flight.
      if (sameGeometry(mirror.applied, geometry)) return;
      mirror.applied = geometry;
      this.mintViewportEpoch(mirror);
    } catch (error) {
      log.warn("[browser-view] mirror could not read its viewport", {
        guestKey: mirror.entry.guestKey,
        error: describeLogError(error),
      });
    } finally {
      mirror.geometryRefreshInFlight = false;
    }
  }

  /**
   * The next epoch for the geometry currently in `applied`. A page-scale change
   * mints one too: the layout did not move, but what a viewer's input has to be
   * divided by did.
   */
  private mintViewportEpoch(mirror: ActiveMirror): void {
    if (mirror.stopped) return;
    mirror.epoch += 1;
    mirror.sink.event({
      kind: "viewportEpoch",
      hasBinaryPayload: false,
      epoch: mirror.epoch,
      logicalViewport: mirror.applied,
    });
  }

  private failMirror(
    mirror: ActiveMirror,
    reason: string,
    error: unknown,
  ): void {
    log.warn("[browser-view] mirror failed", {
      guestKey: mirror.entry.guestKey,
      reason,
      error: describeLogError(error),
    });
    this.sendTerminal(mirror, {
      kind: "failed",
      hasBinaryPayload: false,
      reason,
    });
    this.stop(mirror.entry);
  }

  /**
   * At most one terminal frame per mirror: the host counts a `failed` toward
   * its per-tab refusal latch, and a crash that also destroys the guest must
   * not be counted twice.
   */
  private sendTerminal(
    mirror: ActiveMirror,
    frame: BrowserMirrorEventFrame,
  ): void {
    if (mirror.terminalSent) return;
    mirror.terminalSent = true;
    mirror.sink.event(frame);
  }
}

function sameGeometry(
  left: BrowserViewportGeometry,
  right: BrowserViewportGeometry,
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.dpr === right.dpr
  );
}

/**
 * Whether two polled frames are the same image. An unchanging page is the
 * common case for a mirror of a minimized window, and the alternative to this
 * check is 5 identical JPEGs a second on the wire.
 */
function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false;
  // In place, because these are whole JPEG frames and this runs 5 times a
  // second: wrapping them in Buffers to compare would copy both.
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type DialogType = Extract<
  BrowserMirrorClientFrame,
  { readonly kind: "dialogOpened" }
>["type"];

function dialogType(value: unknown): DialogType {
  if (value === "beforeunload") return "beforeunload";
  if (value === "confirm") return "confirm";
  if (value === "prompt") return "prompt";
  return "alert";
}

/**
 * CDP's own metadata, read field by field rather than parsed: `timestamp` is
 * optional there and required on the wire, and the protocol's schema is
 * `.strict()`, so a future Chromium field would drop the whole frame.
 */
function screencastMetadata(value: unknown): BrowserScreencastMetadata {
  const metadata = recordValue(value);
  return {
    offsetTop: numberValue(metadata?.offsetTop) ?? 0,
    pageScaleFactor: numberValue(metadata?.pageScaleFactor) ?? 1,
    deviceWidth: numberValue(metadata?.deviceWidth) ?? 0,
    deviceHeight: numberValue(metadata?.deviceHeight) ?? 0,
    scrollOffsetX: numberValue(metadata?.scrollOffsetX) ?? 0,
    scrollOffsetY: numberValue(metadata?.scrollOffsetY) ?? 0,
    timestamp: numberValue(metadata?.timestamp) ?? Date.now() / 1_000,
  };
}
