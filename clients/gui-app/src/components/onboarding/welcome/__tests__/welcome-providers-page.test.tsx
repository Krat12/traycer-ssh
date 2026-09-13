import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The page over a fixture `providers.list` and a recording `setEnabled`:
 * what renders for each row, what a switch flip sends, and when Continue is
 * on offer. Tooltips are Radix, so their text is asserted by opening them
 * with a pointer move / focus rather than by reading a `title`.
 */
const fixtures = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  resolved: true,
  isError: false,
  isFetching: false,
  /** A refetch is paused (offline): neither idle nor fetching. */
  paused: false,
  refetch: vi.fn(),
  /** The host the list is keyed on; toggles name theirs in `onMutate`. */
  hostId: "host-a",
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: fixtures.resolved ? { providers: fixtures.providers } : undefined,
    isPending: !fixtures.resolved && !fixtures.isError,
    isError: fixtures.isError,
    isFetching: fixtures.isFetching,
    fetchStatus: fixtures.isFetching
      ? "fetching"
      : fixtures.paused
        ? "paused"
        : "idle",
    status: fixtures.isError
      ? "error"
      : fixtures.resolved
        ? "success"
        : "pending",
    refetch: fixtures.refetch,
  }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => fixtures.hostId,
}));

/**
 * A REAL mutation under the hook's own key, with a controllable request:
 * the page's Continue gate reads the mutation cache (`useWelcomeRoster`),
 * so a stub returning `{ mutate, isPending }` would leave that cache empty
 * and the gate vacuous. `deferred` holds the in-flight request's resolvers.
 */
const setEnabledFixture = vi.hoisted(() => ({
  requests: [] as unknown[],
  deferred: null as {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null,
  /** The host the toggle is aimed at - what `useHostScopedMutation` captures. */
  hostId: "host-a",
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  const { providersMutationKeys } = await import("@/lib/query-keys");
  return {
    useProvidersSetEnabled: () =>
      useMutation({
        mutationKey: providersMutationKeys.setEnabled(),
        // The shape `useHostScopedMutation` captures at `onMutate`.
        onMutate: () => ({
          hostId: setEnabledFixture.hostId,
          captured: undefined,
        }),
        mutationFn: (variables: unknown) => {
          setEnabledFixture.requests.push(variables);
          return new Promise<void>((resolve, reject) => {
            setEnabledFixture.deferred = { resolve, reject };
          });
        },
      }),
  };
});

import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { WelcomeProvidersPage } from "@/components/onboarding/welcome/welcome-providers-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ORDERED_PROVIDERS } from "@/lib/provider-ordering";
import { useWelcomeRosterFreshnessStore } from "@/stores/onboarding/welcome-roster-freshness-store";

const UNKNOWN_AUTH: ProviderAuth = {
  status: "unknown",
  badgeText: null,
  label: null,
  detail: null,
};

function providerState(input: {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly auth: ProviderAuth;
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: input.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: input.installed
      ? [
          {
            kind: "path",
            path: "/usr/bin/x",
            available: true,
            version: "1.0.0",
            versionPending: false,
          },
        ]
      : [],
    auth: input.auth,
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

function defaultProviders(): ProviderCliState[] {
  return [
    providerState({
      providerId: "claude-code",
      enabled: true,
      installed: true,
      auth: {
        status: "authenticated",
        badgeText: null,
        label: "jane@example.com",
        detail: "Signed in as jane@example.com",
      },
    }),
    providerState({
      providerId: "codex",
      enabled: true,
      installed: true,
      auth: { ...UNKNOWN_AUTH, status: "unauthenticated" },
    }),
    providerState({
      providerId: "cursor",
      enabled: false,
      installed: false,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "grok",
      enabled: false,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "opencode",
      enabled: true,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "traycer",
      enabled: false,
      installed: false,
      auth: UNKNOWN_AUTH,
    }),
    providerState({
      providerId: "kimi",
      enabled: false,
      installed: true,
      auth: UNKNOWN_AUTH,
    }),
  ];
}

let rerenderMounted: ((ui: ReactElement) => void) | null = null;
const onContinueMock = vi.fn();
const onSkipMock = vi.fn();

function pageElement(): ReactElement {
  return (
    <TooltipProvider delayDuration={0}>
      <WelcomeProvidersPage onContinue={onContinueMock} onSkip={onSkipMock} />
    </TooltipProvider>
  );
}

function renderPage(): { onContinue: Mock; onSkip: Mock } {
  rerenderMounted = render(pageElement(), {
    wrapper: WithTestQueryClient,
  }).rerender;
  return { onContinue: onContinueMock, onSkip: onSkipMock };
}

/** The variables of the n-th `providers.setEnabled` request, once it is sent. */
async function sentRequest(index: number): Promise<unknown> {
  await waitFor(() => {
    expect(setEnabledFixture.requests.length).toBeGreaterThan(index);
  });
  return setEnabledFixture.requests[index];
}

async function settleRequest(outcome: "success" | "failure"): Promise<void> {
  await waitFor(() => {
    expect(setEnabledFixture.deferred).not.toBeNull();
  });
  const deferred = setEnabledFixture.deferred;
  if (deferred === null) throw new Error("no request in flight");
  setEnabledFixture.deferred = null;
  await act(async () => {
    if (outcome === "success") deferred.resolve();
    else deferred.reject(new Error("host refused"));
    await Promise.resolve();
  });
}

/** Re-render with the fixtures' current values (the mocks read them live). */
function rerenderPage(): void {
  if (rerenderMounted === null) throw new Error("page not rendered");
  rerenderMounted(pageElement());
}

function tile(providerId: ProviderId): HTMLElement {
  const match = screen
    .getAllByTestId("welcome-provider-tile")
    .find((element) => element.dataset.providerId === providerId);
  if (match === undefined) throw new Error(`no tile for ${providerId}`);
  return match;
}

function switchFor(name: string): HTMLElement {
  return screen.getByRole("switch", { name: `Enable ${name}` });
}

describe("<WelcomeProvidersPage />", () => {
  beforeEach(() => {
    fixtures.providers = defaultProviders();
    fixtures.resolved = true;
    fixtures.isError = false;
    fixtures.isFetching = false;
    fixtures.paused = false;
    fixtures.hostId = "host-a";
    fixtures.refetch.mockReset();
    setEnabledFixture.requests.length = 0;
    setEnabledFixture.deferred = null;
    setEnabledFixture.hostId = "host-a";
    useWelcomeRosterFreshnessStore.getState().reset();
    onContinueMock.mockReset();
    onSkipMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    rerenderMounted = null;
  });

  it("renders the six major tiles in order, then a disclosure for the rest", () => {
    renderPage();
    expect(
      screen
        .getAllByTestId("welcome-provider-tile")
        .map((element) => element.dataset.providerId),
    ).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "traycer",
    ]);
    const minorCount = ORDERED_PROVIDERS.length - 6;
    const more = screen.getByRole("button", {
      name: `${minorCount} more providers`,
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("welcome-provider-row")).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getAllByTestId("welcome-provider-row");
    expect(rows).toHaveLength(minorCount);
    // Minors keep the catalogue order; Kimi is in there with its live badge.
    expect(rows.map((element) => element.dataset.providerId)).toEqual(
      ORDERED_PROVIDERS.map((provider) => provider.providerId).filter(
        (providerId) =>
          ![
            "claude-code",
            "codex",
            "cursor",
            "grok",
            "opencode",
            "traycer",
          ].includes(providerId),
      ),
    );
    const kimi = rows.find((element) => element.dataset.providerId === "kimi");
    if (kimi === undefined) throw new Error("no kimi row");
    expect(within(kimi).getByTestId("welcome-provider-badge").textContent).toBe(
      "Installed",
    );
  });

  it("shows the badge, subtitle and switch state per tile", () => {
    renderPage();
    const claude = tile("claude-code");
    expect(
      within(claude).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Installed");
    expect(
      within(claude).getByTestId("welcome-provider-subtitle").textContent,
    ).toBe("jane@example.com");
    expect(switchFor("Claude Code").getAttribute("aria-checked")).toBe("true");

    // Unauthenticated: enabled, no subtitle (the state lives in the tooltip).
    const codex = tile("codex");
    expect(within(codex).queryByTestId("welcome-provider-subtitle")).toBeNull();
    expect(switchFor("Codex").getAttribute("aria-checked")).toBe("true");

    // Not found: info-only.
    const cursor = tile("cursor");
    expect(
      within(cursor).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Not found");
    expect(switchFor("Cursor").hasAttribute("disabled")).toBe(true);

    // Built in, off: connected (the ready line stays) with the switch off.
    const traycer = tile("traycer");
    expect(
      within(traycer).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Built in");
    expect(
      within(traycer).getByTestId("welcome-provider-subtitle").textContent,
    ).toBe("Ready with your Traycer subscription");
    expect(switchFor("Traycer Inference").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(switchFor("Traycer Inference").hasAttribute("disabled")).toBe(false);
  });

  it("flipping a switch calls providers.setEnabled with no profile action", async () => {
    renderPage();
    fireEvent.click(switchFor("Grok"));
    expect(await sentRequest(0)).toEqual({
      providerId: "grok",
      enabled: true,
      profileAction: null,
    });
    await settleRequest("success");
    await waitFor(() => {
      expect(switchFor("Traycer Inference").hasAttribute("disabled")).toBe(
        false,
      );
    });
    fireEvent.click(switchFor("Traycer Inference"));
    expect(await sentRequest(1)).toEqual({
      providerId: "traycer",
      enabled: true,
      profileAction: null,
    });
  });

  it("disables every switch while the shared mutation is in flight", async () => {
    renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      for (const element of screen.getAllByRole("switch")) {
        expect(element.hasAttribute("disabled")).toBe(true);
      }
    });
    fireEvent.click(switchFor("Codex"));
    expect(setEnabledFixture.requests).toHaveLength(1);
  });

  it("refuses to turn off the last enabled provider and says why", async () => {
    fixtures.providers = [
      providerState({
        providerId: "claude-code",
        enabled: true,
        installed: true,
        auth: UNKNOWN_AUTH,
      }),
      providerState({
        providerId: "grok",
        enabled: false,
        installed: true,
        auth: UNKNOWN_AUTH,
      }),
    ];
    renderPage();
    const claude = switchFor("Claude Code");
    expect(claude.hasAttribute("disabled")).toBe(true);
    expect(switchFor("Grok").hasAttribute("disabled")).toBe(false);
    const guard = claude.parentElement;
    if (guard === null) throw new Error("no guard span");
    fireEvent.pointerMove(guard);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "At least one provider must stay enabled.",
    );
  });

  it("explains a missing install on hover", async () => {
    renderPage();
    fireEvent.pointerMove(
      within(tile("cursor")).getByTestId("welcome-provider-identity"),
    );
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "Install Cursor on this machine to use it.",
    );
  });

  it("offers no sign-in anywhere on the page", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  it("Continue and Skip setup call the props", () => {
    const { onContinue, onSkip } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("withholds Continue until providers.list resolves, showing Detecting… tiles meanwhile", () => {
    fixtures.resolved = false;
    fixtures.isFetching = true;
    const { onContinue } = renderPage();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton);
    expect(onContinue).not.toHaveBeenCalled();
    expect(
      within(tile("claude-code")).getByTestId("welcome-provider-badge")
        .textContent,
    ).toBe("Detecting…");
    for (const element of screen.getAllByRole("switch")) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }
  });

  const continueButton = (): HTMLElement =>
    screen.getByRole("button", { name: "Continue" });

  const grokEnabled = (): ProviderCliState[] =>
    defaultProviders().map((provider) =>
      provider.providerId === "grok"
        ? { ...provider, enabled: true }
        : provider,
    );

  it("withholds Continue through a toggle in flight AND until a fetch that started after its success completes", async () => {
    const { onContinue } = renderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(false);

    // The toggle is sent; the mutation is pending.
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // The refetch the toggle's success invalidates into starts BEFORE the
    // mutation reports success (the invalidation runs inside its
    // onSuccess), so this fetch began under the old generation.
    fixtures.isFetching = true;
    rerenderPage();
    await settleRequest("success");
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();

    // It lands. It is not the receipt - it was not stamped after the toggle
    // - so the hook asks for one more fetch and Continue stays withheld.
    fixtures.isFetching = false;
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    await waitFor(() => {
      expect(fixtures.refetch).toHaveBeenCalledTimes(1);
    });
    // Asked for once, not on every render.
    rerenderPage();
    expect(fixtures.refetch).toHaveBeenCalledTimes(1);

    // That fetch starts under the new generation and lands the new roster.
    fixtures.isFetching = true;
    rerenderPage();
    fixtures.isFetching = false;
    fixtures.providers = grokEnabled();
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(false);
    expect(switchFor("Grok").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh after a successful toggle keeps Continue withheld and offers Retry, until a retry lands the new roster", async () => {
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await settleRequest("success");
    // The refetch starts after the success this time, and fails: TanStack
    // keeps the OLD data and drops isFetching.
    fixtures.isFetching = true;
    rerenderPage();
    fixtures.isFetching = false;
    fixtures.isError = true;
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
    // Cached data or not, the way forward is the retry - the hook does not
    // fetch on its own over an error.
    expect(screen.getByTestId("welcome-providers-error")).not.toBeNull();
    expect(switchFor("Grok").getAttribute("aria-checked")).toBe("false");
    expect(fixtures.refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fixtures.refetch).toHaveBeenCalledTimes(1);

    // The retry succeeds with the post-toggle roster.
    fixtures.isError = false;
    fixtures.isFetching = true;
    rerenderPage();
    fixtures.isFetching = false;
    fixtures.providers = grokEnabled();
    rerenderPage();
    expect(screen.queryByTestId("welcome-providers-error")).toBeNull();
    expect(continueButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a paused refresh is not a receipt", async () => {
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await settleRequest("success");
    fixtures.isFetching = true;
    rerenderPage();
    // Offline: the fetch is paused, neither reading nor failing.
    fixtures.isFetching = false;
    fixtures.paused = true;
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton());
    expect(onContinue).not.toHaveBeenCalled();
    expect(fixtures.refetch).not.toHaveBeenCalled();
    // Back online: it resumes and lands.
    fixtures.paused = false;
    fixtures.isFetching = true;
    rerenderPage();
    fixtures.isFetching = false;
    fixtures.providers = grokEnabled();
    rerenderPage();
    expect(continueButton().hasAttribute("disabled")).toBe(false);
  });

  it("a toggle aimed at ANOTHER host is not this roster's business", async () => {
    setEnabledFixture.hostId = "host-b";
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(true);
    });
    await settleRequest("success");
    // No refresh of host A's list is owed, and none is asked for.
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    expect(fixtures.refetch).not.toHaveBeenCalled();
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a FAILED toggle requires no refresh: Continue returns once the mutation settles", async () => {
    const { onContinue } = renderPage();
    fireEvent.click(switchFor("Grok"));
    await sentRequest(0);
    await settleRequest("failure");
    await waitFor(() => {
      expect(continueButton().hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("on a list error with no data: Unavailable tiles, an inline retry, and no Continue", () => {
    fixtures.resolved = false;
    fixtures.isError = true;
    const { onContinue } = renderPage();
    expect(screen.getByTestId("welcome-providers-error")).not.toBeNull();
    expect(
      within(tile("codex")).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Unavailable");
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fixtures.refetch).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });
});
