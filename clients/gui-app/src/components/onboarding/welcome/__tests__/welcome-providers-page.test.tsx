import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  refetch: vi.fn(),
  setEnabledMutate: vi.fn(),
  setEnabledPending: false,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: fixtures.resolved ? { providers: fixtures.providers } : undefined,
    isPending: !fixtures.resolved && !fixtures.isError,
    isError: fixtures.isError,
    isFetching: fixtures.isFetching,
    fetchStatus: fixtures.isFetching ? "fetching" : "idle",
    refetch: fixtures.refetch,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({
    mutate: fixtures.setEnabledMutate,
    isPending: fixtures.setEnabledPending,
  }),
}));

import { WelcomeProvidersPage } from "@/components/onboarding/welcome/welcome-providers-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ORDERED_PROVIDERS } from "@/lib/provider-ordering";

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

function renderPage(): { onContinue: () => void; onSkip: () => void } {
  const onContinue = vi.fn();
  const onSkip = vi.fn();
  render(
    <TooltipProvider delayDuration={0}>
      <WelcomeProvidersPage onContinue={onContinue} onSkip={onSkip} />
    </TooltipProvider>,
  );
  return { onContinue, onSkip };
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
    fixtures.refetch.mockReset();
    fixtures.setEnabledMutate.mockReset();
    fixtures.setEnabledPending = false;
  });

  afterEach(() => {
    cleanup();
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

    // Built in, off: badge only, no subtitle, switch live.
    const traycer = tile("traycer");
    expect(
      within(traycer).getByTestId("welcome-provider-badge").textContent,
    ).toBe("Built in");
    expect(
      within(traycer).queryByTestId("welcome-provider-subtitle"),
    ).toBeNull();
    expect(switchFor("Traycer Inference").hasAttribute("disabled")).toBe(false);
  });

  it("flipping a switch calls providers.setEnabled with no profile action", () => {
    renderPage();
    fireEvent.click(switchFor("Grok"));
    expect(fixtures.setEnabledMutate).toHaveBeenCalledWith({
      providerId: "grok",
      enabled: true,
      profileAction: null,
    });
    fireEvent.click(switchFor("Traycer Inference"));
    expect(fixtures.setEnabledMutate).toHaveBeenLastCalledWith({
      providerId: "traycer",
      enabled: true,
      profileAction: null,
    });
  });

  it("disables every switch while the shared mutation is in flight", () => {
    fixtures.setEnabledPending = true;
    renderPage();
    for (const element of screen.getAllByRole("switch")) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }
    fireEvent.click(switchFor("Grok"));
    expect(fixtures.setEnabledMutate).not.toHaveBeenCalled();
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
