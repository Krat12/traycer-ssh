import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserMirrorParams,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsDesktopServerFrame } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import {
  createElectronTabs,
  type ElectronTabs,
} from "../browser-sessions-electron-tabs";
import {
  createMirrorRecorder,
  createTabRecorder,
  type MirrorRecorder,
} from "./browser-sessions-stream-fixture";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const PARAMS: BrowserMirrorParams = {
  maxWidth: 900,
  maxHeight: 1600,
  quality: 55,
  everyNthFrame: 1,
};

const CREATE: Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "createElectronTab" }
> = {
  kind: "createElectronTab",
  hasBinaryPayload: false,
  requestId: "request-1",
  sessionId: "session-1",
  tabId: "tab-1",
  requestedUrl: "https://example.com/",
  reason: "agent-open",
  profile: "primary",
  seedStorageState: null,
};

type MirrorRequestFrame = Extract<
  BrowserSessionsDesktopServerFrame,
  { readonly kind: "mirrorRequest" }
>;

function mirrorRequest(
  overrides: Partial<MirrorRequestFrame>,
): MirrorRequestFrame {
  return {
    kind: "mirrorRequest",
    hasBinaryPayload: false,
    mirrorId: "mirror-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    params: PARAMS,
    ...overrides,
  };
}

const activeElectronTabs = new Set<ElectronTabs>();

interface Harness {
  readonly electronTabs: ElectronTabs;
  readonly mirror: MirrorRecorder;
  readonly sent: BrowserSessionsClientFrame[];
}

/** An accepted native tab on a desktop whose mirror seam records everything. */
async function acceptedTab(): Promise<Harness> {
  const tabs = createTabRecorder();
  const mirror = createMirrorRecorder();
  const sent: BrowserSessionsClientFrame[] = [];
  const electronTabs = createElectronTabs({
    hostId: "host-1",
    windowId: "window-1",
    tabs: tabs.port,
    connectionId: () => "connection-1",
    sendFrame: (frame) => sent.push(frame),
    onTabBound: () => undefined,
    onTabReleased: () => undefined,
    mirror: mirror.deps,
  });
  activeElectronTabs.add(electronTabs);
  electronTabs.handleFrame(CREATE);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  electronTabs.handleFrame({
    kind: "electronTabAccepted",
    hasBinaryPayload: false,
    requestId: CREATE.requestId,
    sessionId: CREATE.sessionId,
    tabId: CREATE.tabId,
    registrationId: "registration-1",
  });
  sent.length = 0;
  return { electronTabs, mirror, sent };
}

/**
 * The desktop half of `browser.mirror` (D04/D05), driven from the frame that
 * asks for it.
 *
 * The stream is the desktop's own - it rides the same `WsStreamClient` as the
 * sessions stream but is a separate logical session, so a fatal error on a
 * mirror is terminal for that mirror and for nothing else.
 */
describe("browser.mirror source", () => {
  afterEach(() => {
    for (const tabs of activeElectronTabs) tabs.dispose();
    activeElectronTabs.clear();
  });

  it("opens exactly one stream per mirrorRequest and echoes the open request", async () => {
    const harness = await acceptedTab();

    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.handles).toHaveLength(1));

    // The four echoed fields let the host bind the stream to the same
    // registration without trusting the host-minted id alone.
    expect(harness.mirror.opens).toEqual([
      {
        mirrorId: "mirror-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
    ]);
    expect(harness.mirror.sessions).toHaveLength(1);
    expect(harness.mirror.starts).toEqual([
      {
        tab: {
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-1",
        },
        params: PARAMS,
      },
    ]);
  });

  it("carries ack, setParams and dialogResponse to the capture, and forwards page signals to the capture", async () => {
    const harness = await acceptedTab();
    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.handles).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    const handle = harness.mirror.handles[0];
    if (session === undefined || handle === undefined)
      throw new Error("expected an open mirror");

    session.emit({ kind: "ack", hasBinaryPayload: false, sequence: 3 }, null);
    session.emit(
      {
        kind: "setParams",
        hasBinaryPayload: false,
        maxWidth: 450,
        maxHeight: 800,
        quality: 30,
        everyNthFrame: 2,
      },
      null,
    );
    session.emit(
      {
        kind: "dialogResponse",
        hasBinaryPayload: false,
        dialogId: "dialog-1",
        accept: true,
        promptText: "typed",
      },
      null,
    );
    // T10's half of the stream: all seven page-signal kinds are handed
    // straight to the capture, in the order the host sent them, with no
    // frame correlation of its own to get in the way.
    session.emit(
      {
        kind: "describePoint",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
        requestId: "request-a",
        x: 10,
        y: 20,
      },
      null,
    );
    session.emit(
      {
        kind: "selectAt",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
        x: 11,
        y: 21,
      },
      null,
    );
    session.emit(
      {
        kind: "expandSelection",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
        unit: "paragraph",
      },
      null,
    );
    session.emit(
      {
        kind: "readSelection",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
        requestId: "request-b",
      },
      null,
    );
    session.emit(
      {
        kind: "clearSelection",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
      },
      null,
    );
    session.emit(
      {
        kind: "blurEditable",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
      },
      null,
    );
    session.emit(
      {
        kind: "setZoom",
        hasBinaryPayload: false,
        subscriberId: "subscriber-1",
        factor: 2,
      },
      null,
    );
    // A frame no arm of the union accepts: `sequence` must be non-negative.
    session.emit({ kind: "ack", hasBinaryPayload: false, sequence: -1 }, null);

    expect(handle.acks).toEqual([3]);
    expect(handle.params).toEqual([
      { maxWidth: 450, maxHeight: 800, quality: 30, everyNthFrame: 2 },
    ]);
    expect(handle.dialogs).toEqual([
      { dialogId: "dialog-1", accept: true, promptText: "typed" },
    ]);
    expect(handle.signals.map((signal) => signal.kind)).toEqual([
      "describePoint",
      "selectAt",
      "expandSelection",
      "readSelection",
      "clearSelection",
      "blurEditable",
      "setZoom",
    ]);

    // The capture's answer to one of those signals goes out on the mirror's
    // own stream, not the sessions stream it shares no channel with.
    handle.sink.event({
      kind: "pointDescribed",
      hasBinaryPayload: false,
      subscriberId: "subscriber-1",
      requestId: "request-a",
      link: null,
      image: null,
      text: "hello",
    });
    expect(session.sentFrames.map((frame) => frame.kind)).toContain(
      "pointDescribed",
    );
    expect(harness.sent).toEqual([]);
  });

  it("puts the capture's frames and events on its own stream", async () => {
    const harness = await acceptedTab();
    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.handles).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    const handle = harness.mirror.handles[0];
    if (session === undefined || handle === undefined)
      throw new Error("expected an open mirror");

    handle.sink.frame(
      {
        kind: "frame",
        hasBinaryPayload: true,
        sequence: 0,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 390,
          deviceHeight: 844,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 1,
        },
        applied: { width: 390, height: 844, dpr: 3 },
      },
      Uint8Array.from([1, 2, 3]),
    );
    handle.sink.event({
      kind: "navState",
      hasBinaryPayload: false,
      url: "https://example.com/next",
      canGoBack: true,
      canGoForward: false,
      loading: false,
    });

    expect(session.sentFrames.map((frame) => frame.kind)).toEqual([
      "frame",
      "navState",
    ]);
    // Nothing travels on the sessions stream: the mirror is its own channel.
    expect(harness.sent).toEqual([]);
  });

  it("closes the stream and the capture on mirrorRelease, and stays closed on a replay", async () => {
    const harness = await acceptedTab();
    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.handles).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    const handle = harness.mirror.handles[0];
    if (session === undefined || handle === undefined)
      throw new Error("expected an open mirror");

    harness.electronTabs.handleFrame({
      kind: "mirrorRelease",
      hasBinaryPayload: false,
      mirrorId: "mirror-1",
    });

    expect(session.closed).toBe(true);
    expect(handle.stopped).toBe(1);

    harness.electronTabs.handleFrame({
      kind: "mirrorRelease",
      hasBinaryPayload: false,
      mirrorId: "mirror-1",
    });
    expect(handle.stopped).toBe(1);
  });

  it("opens no stream for an incarnation this desktop is not running", async () => {
    const harness = await acceptedTab();

    // Right tab, wrong registration - the host still believes in an incarnation
    // this desktop has replaced.
    harness.electronTabs.handleFrame(
      mirrorRequest({ mirrorId: "mirror-a", registrationId: "registration-9" }),
    );
    harness.electronTabs.handleFrame(
      mirrorRequest({ mirrorId: "mirror-b", sessionId: "session-9" }),
    );
    harness.electronTabs.handleFrame(
      mirrorRequest({ mirrorId: "mirror-c", tabId: "tab-9" }),
    );
    await Promise.resolve();

    // Refused before a stream exists, so there is nowhere to send a `failed`:
    // the host's own request timeout is the answer, and it counts that.
    expect(harness.mirror.opens).toEqual([]);
    expect(harness.mirror.starts).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("sends failed { mirror-tab-not-active } and closes when the capture cannot start", async () => {
    const harness = await acceptedTab();
    harness.mirror.refuseStart = true;

    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.sessions).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    if (session === undefined) throw new Error("expected an open mirror");
    await vi.waitFor(() => expect(session.closed).toBe(true));

    // The stream is opened FIRST and the capture started behind it, so this
    // refusal DOES have somewhere to go - and the host counts it toward that
    // tab's refusal latch.
    expect(session.sentFrames).toEqual([
      {
        kind: "failed",
        hasBinaryPayload: false,
        reason: "mirror-tab-not-active",
      },
    ]);
  });

  it("closes without a frame when the capture start throws", async () => {
    const harness = await acceptedTab();
    harness.mirror.throwOnStart = true;

    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.sessions).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    if (session === undefined) throw new Error("expected an open mirror");
    await vi.waitFor(() => expect(session.closed).toBe(true));

    expect(session.sentFrames).toEqual([]);
  });

  it("stops the capture on a fatal close and never re-subscribes", async () => {
    const harness = await acceptedTab();
    harness.electronTabs.handleFrame(mirrorRequest({}));
    await vi.waitFor(() => expect(harness.mirror.handles).toHaveLength(1));
    const session = harness.mirror.sessions[0];
    const handle = harness.mirror.handles[0];
    if (session === undefined || handle === undefined)
      throw new Error("expected an open mirror");

    session.emitFatal("host refused the mirror");

    // A refusal of the open request and the host's own release both arrive this
    // way, and neither is something to retry: only a fresh `mirrorRequest`
    // asks again.
    expect(handle.stopped).toBe(1);
    expect(session.closed).toBe(true);
    expect(harness.mirror.opens).toHaveLength(1);
    expect(harness.mirror.sessions).toHaveLength(1);
  });
});
