import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserMirrorParams,
  BrowserViewportGeometry,
} from "@traycer/protocol/host/browser/contracts";
import type { RecordedCommand } from "../../debug/__tests__/browser-debug-session-test-support";
import type { BrowserViewEntry } from "../browser-view-entry";
import { BrowserViewAnnotationHost } from "../browser-view-annotation-host";
import { BrowserViewEntryRegistry } from "../browser-view-entry-registry";
import { BrowserViewDebugSessions } from "../debug-session-for";
import { BrowserViewViewport } from "../browser-view-viewport";
import {
  BrowserViewMirrorCapture,
  type BrowserMirrorEventFrame,
  type BrowserMirrorFrameEnvelope,
  type BrowserViewMirrorHandle,
  type BrowserViewMirrorSink,
} from "../browser-view-mirror-capture";
import {
  createTestEntry,
  ReadbackWebContents,
} from "./browser-view-entry-test-support";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const PARAMS: BrowserMirrorParams = {
  maxWidth: 900,
  maxHeight: 1600,
  quality: 55,
  everyNthFrame: 1,
};

const GEOMETRY: BrowserViewportGeometry = { width: 390, height: 844, dpr: 3 };

/** 5 fps, and the screencast's own silence window before the poller takes over. */
const POLL_INTERVAL_MS = 200;
const SILENCE_MS = 1_000;

/** A guest that records the throttling calls and can be told it is destroyed. */
class MirrorWebContents extends ReadbackWebContents {
  readonly throttling: boolean[] = [];
  destroyed = false;

  setBackgroundThrottling(allowed: boolean): void {
    this.throttling.push(allowed);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface SentFrame {
  readonly envelope: BrowserMirrorFrameEnvelope;
  readonly jpeg: Uint8Array;
}

interface MirrorHarness {
  readonly capture: BrowserViewMirrorCapture;
  readonly entry: BrowserViewEntry;
  readonly webContents: MirrorWebContents;
  readonly frames: SentFrame[];
  readonly events: BrowserMirrorEventFrame[];
  readonly sink: BrowserViewMirrorSink;
  start(params: BrowserMirrorParams): Promise<BrowserViewMirrorHandle | null>;
  commandsOf(method: string): readonly RecordedCommand[];
  /** One `Page.screencastFrame` off the shared attachment. */
  emitScreencastFrame(cdpSessionId: number, data: string): void;
  eventsOfKind(kind: BrowserMirrorEventFrame["kind"]): readonly unknown[];
}

/**
 * A real `BrowserDebugSession` over a fake debugger, wired the way the manager
 * wires it: a debugger detach reaches the capture, which is the ONLY thing that
 * restarts a screencast a reattach does not restore.
 */
function createMirrorHarness(): MirrorHarness {
  const webContents = new MirrorWebContents(GEOMETRY);
  const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  let capture: BrowserViewMirrorCapture | null = null;
  const debugSessions = new BrowserViewDebugSessions({
    onDetached: (detached) => {
      capture?.handleDetached(detached);
    },
  });
  const annotations = new BrowserViewAnnotationHost({
    entries,
    debugSessions,
    send: () => false,
  });
  const viewport = new BrowserViewViewport(
    entries,
    annotations,
    debugSessions,
    () => false,
  );
  const entry = createTestEntry(webContents);
  entries.register(entry);
  capture = new BrowserViewMirrorCapture({
    debugSessions,
    viewport,
    now: () => Date.now(),
  });
  const frames: SentFrame[] = [];
  const events: BrowserMirrorEventFrame[] = [];
  const sink: BrowserViewMirrorSink = {
    frame: (envelope, jpeg) => {
      frames.push({ envelope, jpeg });
    },
    event: (frame) => {
      events.push(frame);
    },
  };
  const mirrorCapture = capture;
  return {
    capture: mirrorCapture,
    entry,
    webContents,
    frames,
    events,
    sink,
    start: (params) => mirrorCapture.start(entry, params, sink),
    commandsOf: (method) =>
      webContents.debugger.commands.filter(
        (command) => command.method === method,
      ),
    emitScreencastFrame: (cdpSessionId, data) => {
      webContents.debugger.emitMessage(
        "Page.screencastFrame",
        {
          data: Buffer.from(data).toString("base64"),
          sessionId: cdpSessionId,
          metadata: {
            offsetTop: 24,
            pageScaleFactor: 1,
            deviceWidth: 390,
            deviceHeight: 844,
            scrollOffsetX: 0,
            scrollOffsetY: 120,
            timestamp: 1_700_000,
          },
        },
        undefined,
      );
    },
    eventsOfKind: (kind) => events.filter((event) => event.kind === kind),
  };
}

/**
 * Drains every pending microtask. One real macrotask does it, and every chain
 * these tests wait on (`enableAfterCommit`, a poll, a restart) is promises all
 * the way down.
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function startedHarness(): Promise<{
  readonly harness: MirrorHarness;
  readonly handle: BrowserViewMirrorHandle;
}> {
  const harness = createMirrorHarness();
  const handle = await harness.start(PARAMS);
  if (handle === null) throw new Error("expected the mirror to start");
  return { harness, handle };
}

describe("BrowserViewMirrorCapture", () => {
  beforeEach(() => {
    // From zero rather than the wall clock: the poller synthesizes a frame
    // `timestamp` out of the injected clock, and a real epoch there is not
    // something a test can name.
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the screencast with the host's params and mints the first viewport epoch", async () => {
    const { harness } = await startedHarness();

    expect(
      harness.commandsOf("Page.startScreencast").map((c) => c.params),
    ).toEqual([
      {
        format: "jpeg",
        quality: 55,
        maxWidth: 900,
        maxHeight: 1600,
        everyNthFrame: 1,
      },
    ]);
    // Read BEFORE the first frame: the host sizes its hit testing with
    // `applied`, so a frame carrying the placeholder geometry would be a frame
    // the viewer cannot click accurately.
    expect(harness.events).toEqual([
      {
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: 1,
        logicalViewport: GEOMETRY,
      },
    ]);
    expect(harness.webContents.throttling).toEqual([false]);
  });

  it("turns a screencast frame into one binary frame carrying metadata verbatim and the applied geometry", async () => {
    const { harness } = await startedHarness();

    harness.emitScreencastFrame(7, "jpeg-one");

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]?.envelope).toEqual({
      kind: "frame",
      hasBinaryPayload: true,
      sequence: 0,
      metadata: {
        // Forwarded onto `browser.screencast` unchanged, `offsetTop` included.
        offsetTop: 24,
        pageScaleFactor: 1,
        deviceWidth: 390,
        deviceHeight: 844,
        scrollOffsetX: 0,
        scrollOffsetY: 120,
        timestamp: 1_700_000,
      },
      applied: GEOMETRY,
    });
    expect(
      Buffer.from(harness.frames[0]?.jpeg ?? new Uint8Array()).toString(),
    ).toBe("jpeg-one");
  });

  it("withholds the CDP ack until the host acks that sequence, and a skipping ack flushes every held one", async () => {
    const { harness, handle } = await startedHarness();

    harness.emitScreencastFrame(7, "one");
    // Chromium stops producing after two unacked frames, so this ack IS the
    // brake: held until the host has acked the frame it belongs to.
    expect(harness.commandsOf("Page.screencastFrameAck")).toEqual([]);

    handle.ack(0);
    expect(
      harness.commandsOf("Page.screencastFrameAck").map((c) => c.params),
    ).toEqual([{ sessionId: 7 }]);

    harness.emitScreencastFrame(8, "two");
    harness.emitScreencastFrame(9, "three");
    expect(harness.commandsOf("Page.screencastFrameAck")).toHaveLength(1);

    // Cumulative and monotonic, and the fastest subscriber may never have
    // reported 1 individually - so an ack of 2 is a floor, not a match.
    handle.ack(2);
    expect(
      harness.commandsOf("Page.screencastFrameAck").map((c) => c.params),
    ).toEqual([{ sessionId: 7 }, { sessionId: 8 }, { sessionId: 9 }]);

    handle.ack(1);
    expect(harness.commandsOf("Page.screencastFrameAck")).toHaveLength(3);
  });

  it("restarts the screencast with the new params on setParams", async () => {
    const { harness, handle } = await startedHarness();

    handle.setParams({
      maxWidth: 450,
      maxHeight: 800,
      quality: 30,
      everyNthFrame: 2,
    });
    await flush();

    expect(
      harness.commandsOf("Page.startScreencast").map((c) => c.params),
    ).toEqual([
      {
        format: "jpeg",
        quality: 55,
        maxWidth: 900,
        maxHeight: 1600,
        everyNthFrame: 1,
      },
      {
        format: "jpeg",
        quality: 30,
        maxWidth: 450,
        maxHeight: 800,
        everyNthFrame: 2,
      },
    ]);
  });

  it("restores background throttling on stop, and on a screencast that never started", async () => {
    const { harness, handle } = await startedHarness();

    handle.stop();

    expect(harness.commandsOf("Page.stopScreencast")).toHaveLength(1);
    expect(harness.webContents.throttling).toEqual([false, true]);

    const failing = createMirrorHarness();
    failing.webContents.debugger.failures.set(
      "Page.startScreencast",
      new Error("screencast refused"),
    );
    await expect(failing.start(PARAMS)).resolves.toBeNull();
    // The didn't-start path restores it too - the discipline PiP capture keeps.
    expect(failing.webContents.throttling).toEqual([false, true]);
  });

  it("polls capturePage at 5 fps once the screencast has gone quiet, skipping identical bytes", async () => {
    const { harness, handle } = await startedHarness();
    harness.webContents.debugger.responses.set("Page.getLayoutMetrics", {
      cssVisualViewport: {
        scale: 1,
        clientWidth: 390,
        clientHeight: 844,
        pageX: 0,
        pageY: 120,
      },
    });

    await vi.advanceTimersByTimeAsync(SILENCE_MS);

    expect(harness.webContents.captureCount).toBe(1);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]?.envelope.metadata).toEqual({
      // A `capturePage` never carries the top chrome a screencast can, and the
      // rest is synthesized from `Page.getLayoutMetrics`.
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 390,
      deviceHeight: 844,
      scrollOffsetX: 0,
      scrollOffsetY: 120,
      timestamp: SILENCE_MS / 1_000,
    });
    expect(harness.webContents.qualities).toEqual([55]);

    await vi.advanceTimersByTimeAsync(SILENCE_MS);

    // 5 more polls in the next second, and not one frame on the wire: an
    // unchanging page is the common case for a minimized window.
    expect(harness.webContents.captureCount).toBe(6);
    expect(harness.frames).toHaveLength(1);
    expect(harness.eventsOfKind("stalled")).toEqual([]);

    harness.webContents.setCaptureBytes(Uint8Array.from([9, 9, 9, 9]));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(harness.frames).toHaveLength(2);

    // Reopens the two-unacked window, so the poller is free to keep capturing
    // and "it stopped" can only mean the real frame stopped it.
    handle.ack(1);
    harness.emitScreencastFrame(7, "real");
    const capturedWhenLive = harness.webContents.captureCount;
    await vi.advanceTimersByTimeAsync(SILENCE_MS - POLL_INTERVAL_MS);

    expect(harness.webContents.captureCount).toBe(capturedWhenLive);
    expect(harness.frames).toHaveLength(3);
  });

  it("reports a stall once per silent gap", async () => {
    const { harness } = await startedHarness();
    // An empty capture is a poll that produced nothing, so the silence the
    // watchdog measures keeps growing and the gap becomes a real stall.
    harness.webContents.setCaptureBytes(new Uint8Array());

    await vi.advanceTimersByTimeAsync(4 * SILENCE_MS);

    expect(harness.eventsOfKind("stalled")).toHaveLength(1);
  });

  it("relays a JS dialog both ways and ignores a stale answer", async () => {
    const { harness, handle } = await startedHarness();

    harness.webContents.debugger.emitMessage(
      "Page.javascriptDialogOpening",
      { type: "prompt", message: "Your name?", defaultPrompt: "anon" },
      undefined,
    );

    const opened = harness.events.at(-1);
    expect(opened).toMatchObject({
      kind: "dialogOpened",
      hasBinaryPayload: false,
      type: "prompt",
      message: "Your name?",
      defaultPrompt: "anon",
    });
    const dialogId =
      opened !== undefined && opened.kind === "dialogOpened"
        ? opened.dialogId
        : "";
    expect(dialogId).not.toBe("");

    handle.answerDialog("some-other-dialog", true, null);
    expect(harness.commandsOf("Page.handleJavaScriptDialog")).toEqual([]);

    handle.answerDialog(dialogId, true, "typed");
    expect(
      harness.commandsOf("Page.handleJavaScriptDialog").map((c) => c.params),
    ).toEqual([{ accept: true, promptText: "typed" }]);

    // Its own frame rather than an ack, because the person at the Mac can
    // answer the native sheet themselves and the viewer has to be told anyway.
    harness.webContents.debugger.emitMessage(
      "Page.javascriptDialogClosed",
      { result: true },
      undefined,
    );
    expect(harness.events.at(-1)).toEqual({
      kind: "dialogSettled",
      hasBinaryPayload: false,
      dialogId,
    });

    // A `dialogResponse` races the sheet the user may have just answered, so a
    // stale id is an ordinary outcome rather than an error.
    handle.answerDialog(dialogId, false, null);
    expect(harness.commandsOf("Page.handleJavaScriptDialog")).toHaveLength(1);
  });

  it("restarts the screencast after a detach and drops the old target's held acks", async () => {
    const { harness, handle } = await startedHarness();
    harness.emitScreencastFrame(7, "before-detach");

    harness.webContents.debugger.emitDetach("target closed");
    await flush();

    // A reattach restores Page/Runtime/Log/Network/DOM and NOT the screencast.
    expect(harness.commandsOf("Page.enable")).toHaveLength(2);
    expect(harness.commandsOf("Page.startScreencast")).toHaveLength(2);

    // The reattached target has a fresh ack space; the held ack belongs to a
    // session that no longer exists, and holding it would stall forever.
    handle.ack(0);
    expect(harness.commandsOf("Page.screencastFrameAck")).toEqual([]);
  });

  it("treats a detach on a destroyed guest as a close, not a retryable failure", async () => {
    const { harness } = await startedHarness();
    harness.webContents.destroyed = true;

    harness.webContents.debugger.emitDetach("target destroyed");
    await flush();

    // `failed` is retryable and the host would spend its refusal latch asking
    // for a mirror of a tab that no longer exists.
    expect(harness.eventsOfKind("failed")).toEqual([]);
    expect(harness.eventsOfKind("tabClosed")).toEqual([
      { kind: "tabClosed", hasBinaryPayload: false },
    ]);
    // Nothing is written to a destroyed guest, throttling included.
    expect(harness.webContents.throttling).toEqual([false]);
  });

  it("fails the mirror exactly once when the restart cannot get the screencast going", async () => {
    const { harness } = await startedHarness();
    harness.webContents.debugger.failures.set(
      "Page.startScreencast",
      new Error("screencast refused"),
    );

    harness.webContents.debugger.emitDetach("target closed");
    await flush();
    harness.webContents.debugger.emitDetach("target closed again");
    await flush();

    // The host counts a `failed` toward that tab's three-failure refusal latch,
    // so one detach storm must not spend the whole latch.
    expect(harness.eventsOfKind("failed")).toEqual([
      { kind: "failed", hasBinaryPayload: false, reason: "debugger-detached" },
    ]);
    expect(harness.webContents.throttling).toEqual([false, true]);
  });

  it("mints a viewport epoch only when the layout actually moved", async () => {
    const { harness } = await startedHarness();

    harness.capture.notifyViewportApplied(harness.entry);
    await flush();

    // A re-measure that reads the same numbers must not invalidate input a
    // viewer has already correlated against the current epoch.
    expect(harness.eventsOfKind("viewportEpoch")).toHaveLength(1);

    harness.webContents.setReadbackGeometry({
      width: 412,
      height: 732,
      dpr: 2,
    });
    harness.capture.notifyViewportApplied(harness.entry);
    await flush();

    expect(harness.eventsOfKind("viewportEpoch")).toEqual([
      {
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: 1,
        logicalViewport: GEOMETRY,
      },
      {
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: 2,
        logicalViewport: { width: 412, height: 732, dpr: 2 },
      },
    ]);

    harness.emitScreencastFrame(7, "after-resize");
    expect(harness.frames.at(-1)?.envelope.applied).toEqual({
      width: 412,
      height: 732,
      dpr: 2,
    });
  });
});
