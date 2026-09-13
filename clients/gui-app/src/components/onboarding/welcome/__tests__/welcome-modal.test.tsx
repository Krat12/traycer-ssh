import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  SessionImportCandidate,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportScanTotals } from "@traycer/protocol/host/session-import/scan";
import type {
  SessionImportScanCallbacks,
  SessionImportScanClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-scan-client";
import type { SurfaceReadiness } from "@/components/layout/host-readiness-controller-context";

/**
 * The real flow host, modal, scan hook and reducer, over four faked
 * boundaries: the scan stream client (frames are played in by hand), the
 * `providers.list` query, the app-wide stream binding, and the default-host
 * readiness verdict. Stores are the real ones, reset per test.
 */
interface ScanClientHarness {
  callbacks: SessionImportScanCallbacks | null;
  providers: ReadonlyArray<GuiHarnessId> | null | undefined;
  constructed: number;
  readonly close: Mock<() => void>;
}

const scanClient = vi.hoisted((): ScanClientHarness => ({
  callbacks: null,
  providers: undefined,
  constructed: 0,
  close: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-scan-client",
  () => ({
    SessionImportScanClient: class {
      constructor(options: SessionImportScanClientOptions) {
        scanClient.callbacks = options.callbacks;
        scanClient.providers = options.providers;
        scanClient.constructed += 1;
      }

      close(): void {
        scanClient.close();
      }
    },
  }),
);

const providersFixture = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  /** `false` = the list query has not answered yet. */
  resolved: true,
  /** A refresh of an already-resolved list is in flight. */
  refreshing: false,
  /** When the list last read successfully; the roster's freshness stamp. */
  dataUpdatedAt: 1_000,
  /** The last read of an already-resolved list failed (data is kept). */
  errored: false,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () =>
    providersFixture.resolved
      ? {
          data: { providers: providersFixture.providers },
          isPending: false,
          isError: providersFixture.errored,
          isFetching: providersFixture.refreshing,
          fetchStatus: providersFixture.refreshing ? "fetching" : "idle",
          dataUpdatedAt: providersFixture.dataUpdatedAt,
          refetch: providersFixture.refetch,
        }
      : {
          data: undefined,
          isPending: true,
          isError: false,
          isFetching: true,
          fetchStatus: "fetching",
          dataUpdatedAt: 0,
          refetch: providersFixture.refetch,
        },
}));

/**
 * A REAL mutation under the hook's own key with a controllable request: the
 * Continue gate reads the mutation cache (`useWelcomeRoster`), so a stub
 * returning `{ mutate, isPending }` would leave that cache empty and the
 * gate vacuous.
 */
const setEnabled = vi.hoisted(() => ({
  requests: [] as unknown[],
  resolve: null as (() => void) | null,
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  const { providersMutationKeys } = await import("@/lib/query-keys");
  return {
    useProvidersSetEnabled: () =>
      useMutation({
        mutationKey: providersMutationKeys.setEnabled(),
        mutationFn: (variables: unknown) => {
          setEnabled.requests.push(variables);
          return new Promise<void>((resolve) => {
            setEnabled.resolve = resolve;
          });
        },
      }),
  };
});

interface StreamHarness {
  client: object;
  hostId: string | null;
  support: "supported" | "unsupported" | "unknown";
}

const stream = vi.hoisted((): StreamHarness => ({
  client: { stream: "test" },
  hostId: "host-a",
  support: "supported",
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => stream.client,
  useStreamHostId: () => stream.hostId,
  useStreamRuntimeBinding: () =>
    stream.hostId === null
      ? null
      : { wsStreamClient: stream.client, hostId: stream.hostId, retain: null },
  useStreamMethodSupportFor: () => stream.support,
}));

const readinessHarness = vi.hoisted(() => ({
  readiness: { kind: "ready" } as SurfaceReadiness,
}));

vi.mock(
  "@/components/layout/host-readiness-controller-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/layout/host-readiness-controller-context")
    >()),
    useSurfaceReadiness: () => readinessHarness.readiness,
  }),
);

const analyticsTrack = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: analyticsTrack }) },
  AnalyticsEvent: {
    OnboardingModalShown: "onboarding_modal_shown",
    OnboardingModalContinued: "onboarding_modal_continued",
    OnboardingModalSkipped: "onboarding_modal_skipped",
  },
}));

function trackedEvents(): ReadonlyArray<[string, unknown]> {
  return analyticsTrack.mock.calls.map((call): [string, unknown] => [
    call[0],
    call[1],
  ]);
}

import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { OnboardingFlowHost } from "@/components/onboarding/welcome/onboarding-flow-host";
import { setMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";

function providerState(
  providerId: ProviderId,
  enabled: boolean,
): ProviderCliState {
  return {
    providerId,
    enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    // Installed, so page 1 offers the switch (a missing install is info-only).
    candidates: [
      {
        kind: "path",
        path: "/usr/bin/x",
        available: true,
        version: "1.0.0",
        versionPending: false,
      },
    ],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function importableCandidate(
  harness: GuiHarnessId,
  nativeSessionId: string,
): SessionImportCandidate {
  return {
    harness,
    nativeSessionId,
    title: `Session ${nativeSessionId}`,
    firstPrompt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: null,
    hasSubagents: false,
    state: { kind: "importable" },
  };
}

function folderGroup(
  path: string,
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return {
    location: { kind: "folder", path, workspaceId: null },
    gitBacked: false,
    sessions: [...sessions],
  };
}

const ZERO_TOTALS: SessionImportScanTotals = {
  groups: 0,
  sessions: 0,
  importable: 0,
  alreadyInTraycer: 0,
  unreadable: 0,
};

function callbacks(): SessionImportScanCallbacks {
  const current = scanClient.callbacks;
  if (current === null) throw new Error("scan client was never constructed");
  return current;
}

function signIn(): void {
  useAuthStore.setState({ status: "signed-in" });
}

function flow() {
  return useOnboardingFlowStore.getState();
}

describe("<OnboardingFlowHost /> + <WelcomeModal />", () => {
  beforeEach(() => {
    scanClient.callbacks = null;
    scanClient.providers = undefined;
    scanClient.constructed = 0;
    scanClient.close.mockReset();
    providersFixture.providers = [
      providerState("claude-code", true),
      providerState("cursor", false),
    ];
    providersFixture.resolved = true;
    providersFixture.refreshing = false;
    providersFixture.dataUpdatedAt = 1_000;
    providersFixture.errored = false;
    providersFixture.refetch.mockReset();
    setEnabled.requests.length = 0;
    setEnabled.resolve = null;
    stream.hostId = "host-a";
    stream.support = "supported";
    readinessHarness.readiness = { kind: "ready" };
    analyticsTrack.mockReset();
    setMobileApp(false);
    useAuthStore.setState({ status: "signed-out" });
    useOnboardingFlowStore.setState(INITIAL_FLOW);
    useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("renders nothing while signed out", () => {
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(flow().modal).toBe("pending");
  });

  it("renders nothing in the installed mobile app", () => {
    setMobileApp(true);
    signIn();
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(flow().modal).toBe("pending");
  });

  it("opens on sign-in when the modal is pending: starts the flow, publishes presence, reports page 1 shown", () => {
    signIn();
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    expect(screen.getByTestId("welcome-modal")).not.toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Welcome to Traycer" }),
    ).not.toBeNull();
    expect(flow().modal).toBe("in-progress");
    expect(flow().modalPage).toBe(1);
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(true);
    expect(screen.getByTestId("welcome-providers-page")).not.toBeNull();
    expect(trackedEvents()).toEqual([
      ["onboarding_modal_shown", { page: "1" }],
    ]);
    // No close X anywhere on the frame.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("reopens a rehydrated in-progress modal on its saved page without restarting the flow", () => {
    signIn();
    useOnboardingFlowStore.setState({ modal: "in-progress", modalPage: 2 });
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    expect(screen.getByTestId("welcome-sessions-page")).not.toBeNull();
    expect(flow().modalPage).toBe(2);
    expect(trackedEvents()).toEqual([
      ["onboarding_modal_shown", { page: "2" }],
    ]);
  });

  it("shows the connecting body until the default host is ready AND the stream names a host", () => {
    signIn();
    readinessHarness.readiness = { kind: "loading-host" };
    const view = render(<OnboardingFlowHost />, {
      wrapper: WithTestQueryClient,
    });
    expect(screen.getByTestId("welcome-connecting")).not.toBeNull();
    expect(screen.queryByTestId("welcome-providers-page")).toBeNull();
    expect(analyticsTrack).not.toHaveBeenCalled();
    // Only Skip is on offer while connecting.
    expect(screen.getByRole("button", { name: "Skip" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    // Ready verdict, but no stream host yet: still connecting.
    readinessHarness.readiness = { kind: "ready" };
    stream.hostId = null;
    view.rerender(<OnboardingFlowHost />);
    expect(screen.getByTestId("welcome-connecting")).not.toBeNull();

    stream.hostId = "host-a";
    view.rerender(<OnboardingFlowHost />);
    expect(screen.queryByTestId("welcome-connecting")).toBeNull();
    expect(screen.getByTestId("welcome-providers-page")).not.toBeNull();
    expect(trackedEvents()).toEqual([
      ["onboarding_modal_shown", { page: "1" }],
    ]);
  });

  it("Skip while connecting skips the modal", () => {
    signIn();
    readinessHarness.readiness = { kind: "loading-host" };
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(flow().modal).toBe("skipped");
    expect(flow().branch).toBe("no-sessions");
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("add-folder");
    expect(trackedEvents()).toEqual([
      ["onboarding_modal_skipped", { page: "1" }],
    ]);
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(false);
  });

  it("Escape pauses: the modal hides for this session, the flow stays in progress, and only `pending` brings it back", () => {
    signIn();
    const view = render(<OnboardingFlowHost />, {
      wrapper: WithTestQueryClient,
    });
    expect(screen.getByTestId("welcome-modal")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(flow().modal).toBe("in-progress");
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(false);

    // A re-render of the host does not reopen it.
    view.rerender(<OnboardingFlowHost />);
    expect(screen.queryByTestId("welcome-modal")).toBeNull();

    // Settings' "show again" does.
    act(() => {
      flow().showWelcomeModalAgain();
    });
    expect(screen.getByTestId("welcome-modal")).not.toBeNull();
    expect(flow().modal).toBe("in-progress");
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(true);
  });

  it("an outside pointer-down leaves the modal open", () => {
    // jsdom cannot drive Radix's outside-dismiss path against this repo's
    // dialog wrapper (see `quit-intercept-bridge.test.tsx`), so this pins the
    // observable half only: the frame is still there afterwards. The
    // `onInteractOutside` preventDefault is the other half.
    signIn();
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    expect(screen.getByTestId("welcome-modal")).not.toBeNull();
    expect(flow().modal).toBe("in-progress");
  });

  it("Skip setup on page 1 skips the modal", () => {
    signIn();
    render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(flow().modal).toBe("skipped");
    expect(flow().activeTourId).toBe("add-folder");
    expect(trackedEvents()).toContainEqual([
      "onboarding_modal_skipped",
      { page: "1" },
    ]);
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
  });

  describe("Continue from page 1", () => {
    it("is withheld until providers.list resolves, so an unread roster cannot finish the modal", () => {
      providersFixture.resolved = false;
      signIn();
      const view = render(<OnboardingFlowHost />, {
        wrapper: WithTestQueryClient,
      });
      const continueButton = screen.getByRole("button", { name: "Continue" });
      expect(continueButton.hasAttribute("disabled")).toBe(true);
      fireEvent.click(continueButton);
      expect(flow().modal).toBe("in-progress");
      expect(flow().modalPage).toBe(1);
      expect(scanClient.constructed).toBe(0);

      providersFixture.resolved = true;
      view.rerender(<OnboardingFlowHost />);
      expect(
        screen
          .getByRole("button", { name: "Continue" })
          .hasAttribute("disabled"),
      ).toBe(false);
      // The roster arrived, and the scan it names started.
      expect(scanClient.providers).toEqual(["claude"]);
    });

    it("finishes as no-sessions when no session-capable provider is enabled (no scan ever starts)", () => {
      providersFixture.providers = [
        providerState("cursor", true),
        providerState("traycer", true),
        providerState("claude-code", false),
      ];
      signIn();
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      expect(scanClient.constructed).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(flow().modal).toBe("done");
      expect(flow().branch).toBe("no-sessions");
      expect(flow().activeTourId).toBe("add-folder");
      expect(trackedEvents()).toContainEqual([
        "onboarding_modal_continued",
        { page: "1", enabled_provider_count: 2, session_count: 0 },
      ]);
      expect(screen.queryByTestId("welcome-modal")).toBeNull();
    });

    it("branches on the roster AFTER a toggle and its refresh, not the one before", async () => {
      providersFixture.providers = [
        providerState("cursor", true),
        providerState("claude-code", false),
      ];
      signIn();
      const view = render(<OnboardingFlowHost />, {
        wrapper: WithTestQueryClient,
      });
      expect(scanClient.constructed).toBe(0);

      fireEvent.click(
        screen.getByRole("switch", { name: "Enable Claude Code" }),
      );
      await waitFor(() => {
        expect(setEnabled.requests).toEqual([
          { providerId: "claude-code", enabled: true, profileAction: null },
        ]);
      });
      const continueButton = (): HTMLElement =>
        screen.getByRole("button", { name: "Continue" });
      await waitFor(() => {
        expect(continueButton().hasAttribute("disabled")).toBe(true);
      });

      // Mutation settled; the list it invalidated is refetching.
      providersFixture.refreshing = true;
      const resolve = setEnabled.resolve;
      if (resolve === null) throw new Error("no toggle in flight");
      await act(async () => {
        resolve();
        await Promise.resolve();
      });
      view.rerender(<OnboardingFlowHost />);
      expect(continueButton().hasAttribute("disabled")).toBe(true);
      fireEvent.click(continueButton());
      expect(flow().modal).toBe("in-progress");
      expect(flow().modalPage).toBe(1);

      // The refresh FAILED and left the pre-toggle roster: still withheld,
      // and the retry is on offer even though data is cached.
      providersFixture.refreshing = false;
      providersFixture.errored = true;
      view.rerender(<OnboardingFlowHost />);
      expect(continueButton().hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();

      // The refreshed roster: Claude is on, and the scan for it starts.
      providersFixture.errored = false;
      providersFixture.dataUpdatedAt = Date.now() + 1;
      providersFixture.providers = [
        providerState("cursor", true),
        providerState("claude-code", true),
      ];
      view.rerender(<OnboardingFlowHost />);
      expect(scanClient.providers).toEqual(["claude"]);
      act(() => {
        callbacks().onStarted(["claude"]);
      });
      fireEvent.click(continueButton());
      expect(flow().modal).toBe("in-progress");
      expect(flow().modalPage).toBe(2);
      expect(trackedEvents()).toContainEqual([
        "onboarding_modal_continued",
        { page: "1", enabled_provider_count: 2, session_count: 0 },
      ]);
    });

    it("finishes as no-sessions when the host cannot scan", () => {
      stream.support = "unsupported";
      signIn();
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      expect(scanClient.constructed).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(flow().branch).toBe("no-sessions");
    });

    it("finishes as no-sessions when the scan completed with nothing importable", () => {
      signIn();
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      expect(scanClient.providers).toEqual(["claude"]);
      act(() => {
        callbacks().onStarted(["claude"]);
        callbacks().onComplete(ZERO_TOTALS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(flow().modal).toBe("done");
      expect(flow().branch).toBe("no-sessions");
    });

    it("moves to page 2 while the scan is still running", () => {
      signIn();
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      act(() => {
        callbacks().onStarted(["claude"]);
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(flow().modal).toBe("in-progress");
      expect(flow().modalPage).toBe(2);
      expect(screen.getByTestId("welcome-sessions-page")).not.toBeNull();
      expect(
        screen.getByRole("dialog", { name: "Bring your recent work" }),
      ).not.toBeNull();
      expect(trackedEvents().at(-1)).toEqual([
        "onboarding_modal_shown",
        { page: "2" },
      ]);
      // The scan started on open survives the page switch.
      expect(scanClient.constructed).toBe(1);
      expect(scanClient.close).not.toHaveBeenCalled();
    });

    it("moves to page 2 when the scan found importable rows", () => {
      signIn();
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      act(() => {
        callbacks().onStarted(["claude"]);
        callbacks().onGroup(
          folderGroup("/repo/a", [
            importableCandidate("claude", "s1"),
            importableCandidate("claude", "s2"),
          ]),
        );
        callbacks().onComplete({
          ...ZERO_TOTALS,
          groups: 1,
          sessions: 2,
          importable: 2,
        });
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(flow().modalPage).toBe(2);
      expect(trackedEvents()).toContainEqual([
        "onboarding_modal_continued",
        { page: "1", enabled_provider_count: 1, session_count: 2 },
      ]);
    });
  });

  describe("page 2 exits", () => {
    beforeEach(() => {
      signIn();
      useOnboardingFlowStore.setState({ modal: "in-progress", modalPage: 2 });
    });

    it("Skip import finishes as no-sessions", () => {
      render(<OnboardingFlowHost />, { wrapper: WithTestQueryClient });
      fireEvent.click(screen.getByRole("button", { name: "Skip import" }));
      expect(flow().modal).toBe("done");
      expect(flow().branch).toBe("no-sessions");
      expect(flow().activeTourId).toBe("add-folder");
      expect(screen.queryByTestId("welcome-modal")).toBeNull();
    });
  });
});
