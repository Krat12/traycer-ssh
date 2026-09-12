import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserMirrorParams,
  BrowserViewportGeometry,
} from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_DESCRIBE_POINT_GLOBAL,
  BROWSER_DESCRIBE_POINT_SCRIPT,
  BROWSER_EDITABLE_FOCUS_BINDING,
  BROWSER_EDITABLE_FOCUS_SCRIPT,
  BROWSER_SELECTION_GLOBAL,
  BROWSER_SELECTION_SCRIPT,
} from "@traycer/protocol/host/browser/page-scripts";
import type { RecordedCommand } from "../../debug/__tests__/browser-debug-session-test-support";
import { ANNOTATION_BINDING_NAME } from "../../annotation/browser-annotation-overlay-script";
import type { BrowserViewEntry } from "../browser-view-entry";
import { BrowserViewAnnotationHost } from "../browser-view-annotation-host";
import { BrowserViewEntryRegistry } from "../browser-view-entry-registry";
import { BrowserViewDebugSessions } from "../debug-session-for";
import { BrowserViewViewport } from "../browser-view-viewport";
import {
  BrowserViewMirrorCapture,
  type BrowserMirrorEventFrame,
  type BrowserViewMirrorHandle,
  type BrowserViewMirrorSink,
} from "../browser-view-mirror-capture";
import type { BrowserMirrorPageSignalFrame } from "../browser-view-mirror-page-signals";
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

const PAGE_SCRIPTS: readonly string[] = [
  BROWSER_EDITABLE_FOCUS_SCRIPT,
  BROWSER_DESCRIBE_POINT_SCRIPT,
  BROWSER_SELECTION_SCRIPT,
];

interface Harness {
  readonly entry: BrowserViewEntry;
  readonly webContents: ReadbackWebContents;
  readonly events: BrowserMirrorEventFrame[];
  /**
   * The identifier minted for each `Page.addScriptToEvaluateOnNewDocument`
   * call, in call order - the fake answers a fresh one per call so a
   * reattach's NEW registrations are distinguishable from the ones they
   * replaced.
   */
  readonly scriptIds: string[];
  start(): Promise<BrowserViewMirrorHandle | null>;
  commandsOf(method: string): readonly RecordedCommand[];
  eventsOfKind(kind: BrowserMirrorEventFrame["kind"]): readonly unknown[];
}

/**
 * The same wiring `browser-view-mirror-capture.test.ts` builds its harness
 * with: a real `BrowserDebugSession` over a fake debugger, assembled the way
 * the manager assembles it. Page signals are a sub-object of the capture
 * (`ActiveMirror.signals`), never constructed standalone in production, so a
 * unit test of them rides the same capture rather than a hand-rolled
 * stand-in that could drift from how `install`/`dispose` are actually driven
 * (start, detach/reattach, stop).
 */
function createHarness(): Harness {
  const webContents = new ReadbackWebContents(GEOMETRY);
  let scriptCounter = 0;
  const scriptIds: string[] = [];
  webContents.debugger.onSendCommand = (command) => {
    if (command.method !== "Page.addScriptToEvaluateOnNewDocument") return;
    scriptCounter += 1;
    const identifier = `script-${scriptCounter}`;
    scriptIds.push(identifier);
    webContents.debugger.responses.set(
      "Page.addScriptToEvaluateOnNewDocument",
      { identifier },
    );
  };
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
  const events: BrowserMirrorEventFrame[] = [];
  const sink: BrowserViewMirrorSink = {
    frame: () => undefined,
    event: (frame) => {
      events.push(frame);
    },
  };
  const mirrorCapture = capture;
  return {
    entry,
    webContents,
    events,
    scriptIds,
    start: () => mirrorCapture.start(entry, PARAMS, sink),
    commandsOf: (method) =>
      webContents.debugger.commands.filter(
        (command) => command.method === method,
      ),
    eventsOfKind: (kind) => events.filter((event) => event.kind === kind),
  };
}

/** Drains every pending microtask, the way the capture suite does. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function startedHarness(): Promise<{
  readonly harness: Harness;
  readonly handle: BrowserViewMirrorHandle;
}> {
  const harness = createHarness();
  const handle = await harness.start();
  if (handle === null) throw new Error("expected the mirror to start");
  return { harness, handle };
}

function emitBindingCalled(
  webContents: ReadbackWebContents,
  name: string,
  payload: string,
): void {
  webContents.debugger.emitMessage(
    "Runtime.bindingCalled",
    { name, payload },
    undefined,
  );
}

describe("BrowserViewMirrorPageSignals", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the binding listener before addBinding is sent, then installs the binding and all three scripts pre-evaluated", async () => {
    const harness = createHarness();
    harness.webContents.debugger.deferResponse("Runtime.addBinding", undefined);

    const startPromise = harness.start();
    await flush();

    // Sent, but not yet answered.
    expect(harness.commandsOf("Runtime.addBinding")).toHaveLength(1);
    expect(harness.commandsOf("Runtime.addBinding")[0]?.params).toEqual({
      name: BROWSER_EDITABLE_FOCUS_BINDING,
    });

    // Proof of ordering: the focus binding already works while addBinding's
    // own reply is still pending, which is only possible if the listener was
    // registered before that command was sent (both happen synchronously, in
    // that order, inside `install`).
    emitBindingCalled(
      harness.webContents,
      BROWSER_EDITABLE_FOCUS_BINDING,
      JSON.stringify({
        focused: false,
        inputMode: null,
        multiline: false,
        rect: null,
      }),
    );
    expect(harness.eventsOfKind("editableFocus")).toHaveLength(1);

    harness.webContents.debugger.resolveResponse(
      "Runtime.addBinding",
      undefined,
      {},
    );
    const handle = await startPromise;
    if (handle === null) throw new Error("expected the mirror to start");

    // Each script registered, then evaluated once inline (for a document
    // already loaded before this viewer arrived) - interleaved, not batched.
    const installSequence = harness.webContents.debugger.commands
      .filter(
        (command) =>
          command.method === "Page.addScriptToEvaluateOnNewDocument" ||
          (command.method === "Runtime.evaluate" &&
            typeof command.params.expression === "string" &&
            PAGE_SCRIPTS.includes(command.params.expression)),
      )
      .map((command) =>
        command.method === "Page.addScriptToEvaluateOnNewDocument"
          ? `add:${String(command.params.source)}`
          : `eval:${String(command.params.expression)}`,
      );
    expect(installSequence).toEqual([
      `add:${BROWSER_EDITABLE_FOCUS_SCRIPT}`,
      `eval:${BROWSER_EDITABLE_FOCUS_SCRIPT}`,
      `add:${BROWSER_DESCRIBE_POINT_SCRIPT}`,
      `eval:${BROWSER_DESCRIBE_POINT_SCRIPT}`,
      `add:${BROWSER_SELECTION_SCRIPT}`,
      `eval:${BROWSER_SELECTION_SCRIPT}`,
    ]);

    handle.stop();
  });

  it("emits editableFocus for a valid focus-binding call and drops everything else", async () => {
    const { harness } = await startedHarness();

    emitBindingCalled(
      harness.webContents,
      BROWSER_EDITABLE_FOCUS_BINDING,
      JSON.stringify({
        focused: true,
        inputMode: "email",
        multiline: false,
        rect: { x: 1, y: 2, width: 3, height: 4 },
      }),
    );

    expect(harness.eventsOfKind("editableFocus")).toEqual([
      {
        kind: "editableFocus",
        hasBinaryPayload: false,
        subscriberId: "",
        focused: true,
        inputMode: "email",
        multiline: false,
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
    ]);

    // The annotation overlay's own binding on the same attachment, an
    // over-1024-char payload, non-JSON, and a payload missing required
    // fields: none of these are ours.
    emitBindingCalled(
      harness.webContents,
      ANNOTATION_BINDING_NAME,
      JSON.stringify({
        focused: true,
        inputMode: null,
        multiline: false,
        rect: null,
      }),
    );
    emitBindingCalled(
      harness.webContents,
      BROWSER_EDITABLE_FOCUS_BINDING,
      JSON.stringify({
        focused: true,
        inputMode: null,
        multiline: false,
        rect: null,
        padding: "x".repeat(1024),
      }),
    );
    emitBindingCalled(
      harness.webContents,
      BROWSER_EDITABLE_FOCUS_BINDING,
      "not json",
    );
    emitBindingCalled(
      harness.webContents,
      BROWSER_EDITABLE_FOCUS_BINDING,
      JSON.stringify({ focused: true }),
    );

    expect(harness.eventsOfKind("editableFocus")).toHaveLength(1);
  });

  it("answers describePoint from the page global with rounded CSS pixels", async () => {
    const { harness, handle } = await startedHarness();
    harness.webContents.debugger.responses.set("Runtime.evaluate", {
      result: {
        value: { link: "https://example.test/", image: null, text: "hello" },
      },
    });

    const frame: BrowserMirrorPageSignalFrame = {
      kind: "describePoint",
      hasBinaryPayload: false,
      subscriberId: "s1",
      requestId: "r1",
      x: 12.345,
      y: 20,
    };
    handle.pageSignal(frame);
    await flush();

    const evaluateCommands = harness.commandsOf("Runtime.evaluate");
    expect(evaluateCommands.at(-1)?.params.expression).toBe(
      `window.${BROWSER_DESCRIBE_POINT_GLOBAL}(12.35, 20)`,
    );
    expect(harness.eventsOfKind("pointDescribed")).toEqual([
      {
        kind: "pointDescribed",
        hasBinaryPayload: false,
        subscriberId: "s1",
        requestId: "r1",
        link: "https://example.test/",
        image: null,
        text: "hello",
      },
    ]);
  });

  it("answers describePoint with all-nulls on a thrown evaluate or a too-long link, keeping the ids", async () => {
    const { harness, handle } = await startedHarness();

    harness.webContents.debugger.responses.set("Runtime.evaluate", {
      exceptionDetails: { text: "page threw" },
    });
    const thrown: BrowserMirrorPageSignalFrame = {
      kind: "describePoint",
      hasBinaryPayload: false,
      subscriberId: "s1",
      requestId: "r-exception",
      x: 1,
      y: 1,
    };
    handle.pageSignal(thrown);
    await flush();

    harness.webContents.debugger.responses.set("Runtime.evaluate", {
      result: {
        value: { link: "a".repeat(2049), image: null, text: null },
      },
    });
    const tooLong: BrowserMirrorPageSignalFrame = {
      kind: "describePoint",
      hasBinaryPayload: false,
      subscriberId: "s2",
      requestId: "r-too-long",
      x: 1,
      y: 1,
    };
    handle.pageSignal(tooLong);
    await flush();

    expect(harness.eventsOfKind("pointDescribed")).toEqual([
      {
        kind: "pointDescribed",
        hasBinaryPayload: false,
        subscriberId: "s1",
        requestId: "r-exception",
        link: null,
        image: null,
        text: null,
      },
      {
        kind: "pointDescribed",
        hasBinaryPayload: false,
        subscriberId: "s2",
        requestId: "r-too-long",
        link: null,
        image: null,
        text: null,
      },
    ]);
  });

  it("answers readSelection with the page's text, and empty on a non-string reply", async () => {
    const { harness, handle } = await startedHarness();

    harness.webContents.debugger.responses.set("Runtime.evaluate", {
      result: { value: "hello world" },
    });
    const good: BrowserMirrorPageSignalFrame = {
      kind: "readSelection",
      hasBinaryPayload: false,
      subscriberId: "s1",
      requestId: "r1",
    };
    handle.pageSignal(good);
    await flush();

    harness.webContents.debugger.responses.set("Runtime.evaluate", {
      result: { value: 42 },
    });
    const bad: BrowserMirrorPageSignalFrame = {
      kind: "readSelection",
      hasBinaryPayload: false,
      subscriberId: "s2",
      requestId: "r2",
    };
    handle.pageSignal(bad);
    await flush();

    expect(harness.eventsOfKind("selectionText")).toEqual([
      {
        kind: "selectionText",
        hasBinaryPayload: false,
        subscriberId: "s1",
        requestId: "r1",
        text: "hello world",
      },
      {
        kind: "selectionText",
        hasBinaryPayload: false,
        subscriberId: "s2",
        requestId: "r2",
        text: "",
      },
    ]);
  });

  it("answers readSelection with empty text once the page signal deadline passes without a reply", async () => {
    const { harness, handle } = await startedHarness();
    harness.webContents.debugger.deferResponse("Runtime.evaluate", undefined);

    const frame: BrowserMirrorPageSignalFrame = {
      kind: "readSelection",
      hasBinaryPayload: false,
      subscriberId: "s1",
      requestId: "r1",
    };
    handle.pageSignal(frame);

    expect(harness.eventsOfKind("selectionText")).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.eventsOfKind("selectionText")).toEqual([
      {
        kind: "selectionText",
        hasBinaryPayload: false,
        subscriberId: "s1",
        requestId: "r1",
        text: "",
      },
    ]);
  });

  it("applies pinch zoom via Emulation.setPageScaleFactor, never the desktop's own layout zoom, and mints one viewport epoch", async () => {
    const { harness, handle } = await startedHarness();
    const setZoomFactorSpy = vi.spyOn(harness.webContents, "setZoomFactor");
    const epochsBefore = harness.eventsOfKind("viewportEpoch").length;

    const frame: BrowserMirrorPageSignalFrame = {
      kind: "setZoom",
      hasBinaryPayload: false,
      subscriberId: "s1",
      factor: 1.5,
    };
    handle.pageSignal(frame);
    await flush();

    expect(
      harness.commandsOf("Emulation.setPageScaleFactor").map((c) => c.params),
    ).toEqual([{ pageScaleFactor: 1.5 }]);
    expect(setZoomFactorSpy).not.toHaveBeenCalled();

    const epochs = harness.eventsOfKind("viewportEpoch");
    expect(epochs).toHaveLength(epochsBefore + 1);
    expect(epochs.at(-1)).toEqual({
      kind: "viewportEpoch",
      hasBinaryPayload: false,
      epoch: epochsBefore + 1,
      logicalViewport: GEOMETRY,
    });
  });

  it("mints no viewport epoch when the zoom command is refused", async () => {
    const { harness, handle } = await startedHarness();
    harness.webContents.debugger.failures.set(
      "Emulation.setPageScaleFactor",
      new Error("refused"),
    );
    const epochsBefore = harness.eventsOfKind("viewportEpoch").length;

    const frame: BrowserMirrorPageSignalFrame = {
      kind: "setZoom",
      hasBinaryPayload: false,
      subscriberId: "s1",
      factor: 2,
    };
    handle.pageSignal(frame);
    await flush();

    expect(harness.eventsOfKind("viewportEpoch")).toHaveLength(epochsBefore);
  });

  it("evaluates the expected expression for selectAt, expandSelection, clearSelection and blurEditable, emitting nothing", async () => {
    const { harness, handle } = await startedHarness();
    const evaluateCountBefore = harness.commandsOf("Runtime.evaluate").length;
    const eventCountBefore = harness.events.length;

    const selectAt: BrowserMirrorPageSignalFrame = {
      kind: "selectAt",
      hasBinaryPayload: false,
      subscriberId: "s1",
      x: 5,
      y: 6,
    };
    handle.pageSignal(selectAt);
    await flush();

    const expandSelection: BrowserMirrorPageSignalFrame = {
      kind: "expandSelection",
      hasBinaryPayload: false,
      subscriberId: "s1",
      unit: "paragraph",
    };
    handle.pageSignal(expandSelection);
    await flush();

    const clearSelection: BrowserMirrorPageSignalFrame = {
      kind: "clearSelection",
      hasBinaryPayload: false,
      subscriberId: "s1",
    };
    handle.pageSignal(clearSelection);
    await flush();

    const blurEditable: BrowserMirrorPageSignalFrame = {
      kind: "blurEditable",
      hasBinaryPayload: false,
      subscriberId: "s1",
    };
    handle.pageSignal(blurEditable);
    await flush();

    const expressions = harness
      .commandsOf("Runtime.evaluate")
      .slice(evaluateCountBefore)
      .map((command) => command.params.expression);
    expect(expressions).toEqual([
      `window.${BROWSER_SELECTION_GLOBAL}.selectAt(5, 6)`,
      `window.${BROWSER_SELECTION_GLOBAL}.expand(${JSON.stringify("paragraph")})`,
      `window.${BROWSER_SELECTION_GLOBAL}.clear()`,
      "document.activeElement?.blur?.()",
    ]);
    expect(harness.events).toHaveLength(eventCountBefore);
  });

  it("removes all three page scripts by identifier and the focus binding by name on stop", async () => {
    const { harness, handle } = await startedHarness();
    const [id1, id2, id3] = harness.scriptIds;
    expect([id1, id2, id3]).toEqual(["script-1", "script-2", "script-3"]);

    handle.stop();
    await flush();

    expect(
      harness
        .commandsOf("Page.removeScriptToEvaluateOnNewDocument")
        .map((command) => command.params.identifier),
    ).toEqual([id1, id2, id3]);
    expect(
      harness
        .commandsOf("Runtime.removeBinding")
        .map((command) => command.params),
    ).toEqual([{ name: BROWSER_EDITABLE_FOCUS_BINDING }]);
  });

  it("re-installs the binding and scripts on a debugger reattach, and a later stop removes the NEW identifiers", async () => {
    const { harness, handle } = await startedHarness();
    const firstIds = [...harness.scriptIds];
    expect(firstIds).toEqual(["script-1", "script-2", "script-3"]);
    const addBindingCountBefore =
      harness.commandsOf("Runtime.addBinding").length;

    harness.webContents.debugger.emitDetach("target closed");
    await flush();
    await flush();

    expect(harness.commandsOf("Runtime.addBinding")).toHaveLength(
      addBindingCountBefore + 1,
    );
    const secondIds = harness.scriptIds.slice(firstIds.length);
    expect(secondIds).toEqual(["script-4", "script-5", "script-6"]);

    handle.stop();
    await flush();

    expect(
      harness
        .commandsOf("Page.removeScriptToEvaluateOnNewDocument")
        .map((command) => command.params.identifier),
    ).toEqual(secondIds);
  });
});
