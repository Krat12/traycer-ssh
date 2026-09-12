import "../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/browser-tile/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEditableInputMode } from "@traycer/protocol/host/browser/contracts";
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

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function imeInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: "Browser IME input",
  });
}

function touchInit(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
}): Record<string, unknown> {
  return {
    pointerId: 3,
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
  // `blurEditable` is a 2.2 client frame, and the transport drops one whose
  // SESSION did not negotiate 2.2 - so a suite asserting it was sent has to
  // negotiate it here.
  stream.getNegotiatedSchemaVersion = () => ({ major: 2, minor: 2 });
  presentLiveFrame(stream);
  return stream;
}

/** A tap close enough (and still enough) to survive as a click, not a scroll. */
function tap(x: number, y: number): void {
  const button = overlayButton();
  fireEvent.pointerDown(
    button,
    touchInit({ clientX: x, clientY: y, buttons: 1 }),
  );
  fireEvent.pointerUp(
    button,
    touchInit({ clientX: x, clientY: y, buttons: 0 }),
  );
}

/** The page's `editableFocus` page signal (D13). `rect` is unread by the client. */
function emitEditableFocus(
  stream: FakeStreamSession,
  focus: {
    readonly focused: boolean;
    readonly inputMode?: BrowserEditableInputMode | null;
    readonly multiline?: boolean;
  },
): void {
  act(() => {
    stream.emit(
      {
        kind: "editableFocus",
        hasBinaryPayload: false,
        focused: focus.focused,
        inputMode: focus.inputMode ?? null,
        multiline: focus.multiline ?? false,
        rect: null,
      },
      null,
    );
  });
}

function blurFrames(stream: FakeStreamSession): number {
  return stream.sentFrames.filter((frame) => frame.kind === "blurEditable")
    .length;
}

describe("BrowserPeekTile mobile keyboard (D13)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setMobileApp(false);
  });

  describe("on the installed mobile app", () => {
    beforeEach(() => {
      hookState.visible = true;
      hookState.streamClient = new FakeStreamClient(true);
      setMobileApp(true);
    });

    it("leaves a touch tap's focus off the hidden IME input", () => {
      renderTile();
      tap(400, 300);
      expect(document.activeElement).not.toBe(imeInput());
    });

    it("focuses the IME input for a page-reported editable focus", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "email",
        multiline: false,
      });
      const input = imeInput();
      expect(document.activeElement).toBe(input);
      expect(input.inputMode).toBe("email");
      expect(input.enterKeyHint).toBe("done");
    });

    it("asks for the enter key on a multiline field", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "email",
        multiline: true,
      });
      expect(imeInput().enterKeyHint).toBe("enter");
    });

    it("asks for search on a search field, whatever the multiline flag says", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "search",
        multiline: false,
      });
      expect(imeInput().enterKeyHint).toBe("search");
    });

    it("asks for go on a url field", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "url",
        multiline: false,
      });
      expect(imeInput().enterKeyHint).toBe("go");
    });

    it("blurs the IME input when the page reports the focus gone", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "text",
        multiline: false,
      });
      expect(document.activeElement).toBe(imeInput());

      emitEditableFocus(stream, { focused: false });

      expect(document.activeElement).not.toBe(imeInput());
    });

    it("sends exactly one blurEditable for a local dismiss, and none for the page's own echo", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "text",
        multiline: false,
      });
      const input = imeInput();

      // The iOS "done" bar, or a tap elsewhere: the keyboard goes away while
      // the page still believes a field is focused.
      fireEvent.blur(input, { relatedTarget: document.body });
      expect(blurFrames(stream)).toBe(1);

      // The page's own `editableFocus { focused: false }` answering that must
      // not bounce a second one back at it.
      emitEditableFocus(stream, { focused: false });
      expect(blurFrames(stream)).toBe(1);
    });
  });

  describe("off the mobile app", () => {
    beforeEach(() => {
      hookState.visible = true;
      hookState.streamClient = new FakeStreamClient(true);
      setMobileApp(false);
    });

    it("focuses the IME input from the tap itself", () => {
      renderTile();
      tap(400, 300);
      expect(document.activeElement).toBe(imeInput());
    });

    it("writes no inputmode from a page's editableFocus frame", () => {
      const stream = renderTile();
      emitEditableFocus(stream, {
        focused: true,
        inputMode: "email",
        multiline: false,
      });
      // Desktop/web ignores the page signal entirely (D13): today's
      // click-to-focus keeps deciding, and the frame writes nothing here.
      expect(imeInput().inputMode).toBe("");
      expect(document.activeElement).not.toBe(imeInput());
    });
  });
});
