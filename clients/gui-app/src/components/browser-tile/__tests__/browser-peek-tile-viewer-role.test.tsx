import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/browser-tile/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearScreencastOwner,
  FakeStreamClient,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  PEEK_NODE,
  runnerOpenExternalLinkModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  type FakeStreamSession,
} from "@/components/browser-tile/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";

const toast = vi.hoisted(() => vi.fn());

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
  // D01 retired the read-only tier, so `useScreencastSession` no longer reads
  // `browserView` at all - it hardcodes `role: "tile"` for every shell. This
  // stays `null` throughout the file (the web bundle / `MobileRunnerHost`
  // shape) specifically to prove that fact: nothing here should still branch
  // on it. `useRunnerHostOrNull` is mocked only because
  // `BrowserTileToolbar`'s unrelated "open in default browser" affordance
  // still reads it (see the fixture's docstring).
  browserView: null as object | null,
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: hookState.browserView }),
}));

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

function renderTile(): void {
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
}

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function subscribedRole(): unknown {
  const subscribe = hookState.streamClient?.subscribes.at(-1);
  if (subscribe === undefined) throw new Error("expected a subscribe");
  const params = subscribe.params;
  if (typeof params !== "object" || params === null) {
    throw new Error("expected subscribe params");
  }
  return Reflect.get(params, "role");
}

describe("BrowserPeekTile on a shell with no native browser of its own (mobile / plain web)", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.browserView = null;
    hookState.streamClient = new FakeStreamClient(true);
    toast.mockClear();
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("subscribes as a `tile` and renders the interactive surface, not the retired read-only one", () => {
    renderTile();

    // The subscription itself declares the controller tier - this is the
    // wire-level half of D01, mirrored at the hook level by
    // `use-screencast-session-role.test.ts`.
    expect(subscribedRole()).toBe("tile");

    // The interactive affordances render unconditionally now: no shell gets
    // the pixels-only presentation that used to gate on `browserView`.
    expect(
      screen.getByRole("button", { name: "Browser screencast controls" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Browser IME input" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Browser address" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Reload" })).toHaveProperty(
      "disabled",
      false,
    );

    // The two markers of the retired tier: the badge, and the `role="img"`
    // surface `ScreencastPeekSurface` used to render in its place. Neither
    // has anywhere left to come from - `session.readOnly` no longer exists on
    // the hook's return value - but a regression that resurrected the branch
    // would make both of these reappear.
    expect(screen.queryByText("View only")).toBeNull();
    expect(screen.queryByTestId("browser-screencast-view")).toBeNull();
  });

  it("arms and its overlay gesture reaches the stream, same as a shell with a native browser", () => {
    renderTile();
    const stream = liveStream();
    const overlay = screen.getByRole("button", {
      name: "Browser screencast controls",
    });

    fireEvent.focus(overlay);

    expect(
      stream.sentFrames.filter((frame) => frame.kind === "arm"),
    ).toHaveLength(1);
  });
});
