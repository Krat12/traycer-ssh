import "../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/browser-tile/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  PEEK_NODE,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  runnerOpenExternalLinkModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
} from "@/components/browser-tile/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";
import { setMobileApp } from "@/lib/mobile-app";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

const JPEG_SEQ_7 = new Uint8Array([1, 2, 3]);
/**
 * The negotiated `browser.screencast` minor for the render under test. It is
 * stubbed in TWO places because the production gate is in two places: the
 * controller reads the CLIENT's version (whether the gesture arms at all) and
 * `BrowserScreencastStreamClient` reads the SESSION's (whether a 2.2 frame may
 * leave). A stub on only one of them silently drops every frame.
 */
let negotiatedMinor = 2;
const LONG_PRESS_MS = 500;
const DESCRIBE_POINT_TIMEOUT_MS = 3_000;

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function touchInit(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
  readonly pointerId?: number;
}): Record<string, unknown> {
  return {
    pointerId: input.pointerId ?? 3,
    pointerType: "touch",
    clientX: input.clientX,
    clientY: input.clientY,
    button: 0,
    buttons: input.buttons,
    detail: 0,
  };
}

function presentLiveFrame(stream: FakeStreamSession): void {
  act(() => {
    stream.emit(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: 800,
        frameHeight: 600,
        deviceScaleFactor: 1,
      },
      null,
    );
    stream.emit(
      {
        kind: "frame",
        hasBinaryPayload: true,
        sequence: 7,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 800,
          deviceHeight: 600,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 1,
        },
      },
      JPEG_SEQ_7,
    );
  });
  const image = screen.getByAltText<HTMLImageElement>("Browser screencast");
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  fireEvent.load(image);
}

function renderTile(): FakeStreamSession {
  renderPeekTile(
    <BrowserPeekTile
      scope={{ kind: "epic", epicId: "epic-1" }}
      visible={hookState.visible}
      onConvertToPip={() => {}}
      onRequestNewTab={null}
      onRequestCloseTab={null}
      node={PEEK_NODE}
      completeMeans="ended"
    />,
  );
  const stream = liveStream();
  stream.getNegotiatedSchemaVersion = () => ({
    major: 2,
    minor: negotiatedMinor,
  });
  presentLiveFrame(stream);
  return stream;
}

function touchDown(x: number, y: number, pointerId?: number): void {
  fireEvent.pointerDown(
    overlayButton(),
    touchInit({ clientX: x, clientY: y, buttons: 1, pointerId }),
  );
}

function touchMove(x: number, y: number, pointerId?: number): void {
  fireEvent.pointerMove(
    overlayButton(),
    touchInit({ clientX: x, clientY: y, buttons: 1, pointerId }),
  );
}

function touchUp(x: number, y: number, pointerId?: number): void {
  fireEvent.pointerUp(
    overlayButton(),
    touchInit({ clientX: x, clientY: y, buttons: 0, pointerId }),
  );
}

function emitArmed(stream: FakeStreamSession, armEpoch: number): void {
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch }, null);
  });
}

function framesOfKind(
  stream: FakeStreamSession,
  kind: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === kind);
}

function pointerFrames(
  stream: FakeStreamSession,
  type: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter(
    (frame) => frame.kind === "pointer" && frame.type === type,
  );
}

function emitPointDescribed(
  stream: FakeStreamSession,
  requestId: string,
  answer: {
    readonly link?: string | null;
    readonly image?: string | null;
    readonly text?: string | null;
  },
): void {
  act(() => {
    stream.emit(
      {
        kind: "pointDescribed",
        hasBinaryPayload: false,
        requestId,
        link: answer.link ?? null,
        image: answer.image ?? null,
        text: answer.text ?? null,
      },
      null,
    );
  });
}

function emitSelectionText(
  stream: FakeStreamSession,
  requestId: string,
  text: string,
): void {
  act(() => {
    stream.emit(
      { kind: "selectionText", hasBinaryPayload: false, requestId, text },
      null,
    );
  });
}

function lastRequestId(stream: FakeStreamSession, kind: string): string {
  const frames = framesOfKind(stream, kind);
  const last = frames.at(-1);
  const requestId = last?.requestId;
  if (typeof requestId !== "string") {
    throw new Error(`expected a ${kind} frame carrying a requestId`);
  }
  return requestId;
}

interface ClipboardSpy {
  readonly calls: string[];
  readonly restore: () => void;
}

function installClipboardSpy(): ClipboardSpy {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const calls: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: {
      writeText: (value: string): Promise<void> => {
        calls.push(value);
        return Promise.resolve();
      },
    },
  });
  return {
    calls,
    restore: () => {
      if (descriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
        return;
      }
      Object.defineProperty(navigator, "clipboard", descriptor);
    },
  };
}

describe("BrowserPeekTile long press context sheet (D14)", () => {
  let clipboard: ClipboardSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    negotiatedMinor = 2;
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    setMobileApp(true);
    clipboard = installClipboardSpy();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setMobileApp(false);
    clipboard.restore();
  });

  describe("negotiated at 2.2", () => {
    beforeEach(() => {
      const client = hookState.streamClient;
      if (client === null) throw new Error("expected a stream client");
      client.getMethodSchemaVersion = () => ({ major: 2, minor: 2 });
    });

    it("sends one describePoint carrying the painted frame and a normalized point after a 500ms hold", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });

      const describes = framesOfKind(stream, "describePoint");
      expect(describes).toHaveLength(1);
      expect(describes[0].castSequence).toBe(7);
      expect(describes[0].x).toBeGreaterThanOrEqual(0);
      expect(describes[0].x).toBeLessThanOrEqual(1);
      expect(describes[0].y).toBeGreaterThanOrEqual(0);
      expect(describes[0].y).toBeLessThanOrEqual(1);
    });

    it("does not fire on more than 10px of travel before the hold completes", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      touchMove(415, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });

      expect(framesOfKind(stream, "describePoint")).toHaveLength(0);
    });

    it("sends no describePoint on release before the hold completes, but still delivers the tap", () => {
      const stream = renderTile();
      touchDown(400, 300);
      const armEpoch = framesOfKind(stream, "arm").at(0)?.armEpoch;
      if (typeof armEpoch !== "number")
        throw new Error("expected an arm request");
      emitArmed(stream, armEpoch);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      touchUp(400, 300);

      expect(framesOfKind(stream, "describePoint")).toHaveLength(0);
      expect(pointerFrames(stream, "down")).toHaveLength(1);
      expect(pointerFrames(stream, "up")).toHaveLength(1);
    });

    it("sends no pointer pair on release once the long press has fired", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      touchUp(400, 300);

      expect(pointerFrames(stream, "down")).toHaveLength(0);
      expect(pointerFrames(stream, "up")).toHaveLength(0);
    });

    it("opens a link sheet with new tab / share / copy link and no image or text row", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const requestId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, requestId, {
        link: "https://example.com/path",
      });

      expect(
        screen.getByRole("button", { name: "Open in new tab" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Open in browser" }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Copy link" })).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Copy image address" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
      expect(screen.getByText("example.com")).not.toBeNull();
    });

    it("opens a text sheet with Copy text and Select more, and sends one selectAt", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const requestId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, requestId, { text: "a page paragraph" });

      expect(screen.getByRole("button", { name: "Copy text" })).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Select more" }),
      ).not.toBeNull();
      expect(framesOfKind(stream, "selectAt")).toHaveLength(1);
    });

    it("Copy text reads the selection instead of re-selecting, and writes the answer to the clipboard", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const describeId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, describeId, { text: "a page paragraph" });

      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

      expect(framesOfKind(stream, "selectAt")).toHaveLength(1);
      expect(framesOfKind(stream, "readSelection")).toHaveLength(1);

      const readId = lastRequestId(stream, "readSelection");
      emitSelectionText(stream, readId, "a page paragraph");

      expect(clipboard.calls).toEqual(["a page paragraph"]);
    });

    it("Select more expands sentence to paragraph to all, each followed by a readSelection, then disappears", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const describeId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, describeId, { text: "a page paragraph" });

      const selectMore = () =>
        fireEvent.click(screen.getByRole("button", { name: "Select more" }));

      selectMore();
      selectMore();
      selectMore();

      const units = stream.sentFrames
        .filter((frame) => frame.kind === "expandSelection")
        .map((frame) => frame.unit);
      expect(units).toEqual(["sentence", "paragraph", "all"]);
      expect(framesOfKind(stream, "readSelection")).toHaveLength(3);
      expect(screen.queryByRole("button", { name: "Select more" })).toBeNull();
    });

    it("sends clearSelection when the sheet is dismissed", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const describeId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, describeId, { text: "a page paragraph" });

      act(() => {
        fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      });

      expect(framesOfKind(stream, "clearSelection")).toHaveLength(1);
    });

    it("opens no sheet when nothing answers within 3s", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const requestId = lastRequestId(stream, "describePoint");
      act(() => {
        vi.advanceTimersByTime(DESCRIBE_POINT_TIMEOUT_MS);
      });
      emitPointDescribed(stream, requestId, { text: "too late" });

      expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    });

    it("ignores a pointDescribed carrying an unknown requestId", () => {
      const stream = renderTile();
      emitPointDescribed(stream, "pg-not-a-real-request", {
        text: "should not open",
      });

      expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    });

    it("opens nothing for an all-null pointDescribed", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      const requestId = lastRequestId(stream, "describePoint");
      emitPointDescribed(stream, requestId, {});

      expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    });

    it("cancels the hold when a second finger comes down", () => {
      const stream = renderTile();
      touchDown(400, 300, 3);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      touchDown(100, 100, 9);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });

      expect(framesOfKind(stream, "describePoint")).toHaveLength(0);
    });
  });

  describe("negotiated at 2.1", () => {
    beforeEach(() => {
      const client = hookState.streamClient;
      if (client === null) throw new Error("expected a stream client");
      client.getMethodSchemaVersion = () => ({ major: 2, minor: 1 });
      negotiatedMinor = 1;
    });

    it("never arms the hold, so no 2.2 client frame is ever sent", () => {
      const stream = renderTile();
      touchDown(400, 300);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });

      const v22Kinds = new Set([
        "describePoint",
        "selectAt",
        "readSelection",
        "expandSelection",
        "clearSelection",
        "blurEditable",
        "setZoom",
      ]);
      expect(stream.sentFrames.some((frame) => v22Kinds.has(frame.kind))).toBe(
        false,
      );
    });
  });
});
