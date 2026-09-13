import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  SessionImportCandidate,
  SessionImportCandidateState,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportScanTotals } from "@traycer/protocol/host/session-import/scan";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import type {
  SessionImportScanCallbacks,
  SessionImportScanClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-scan-client";
import type { SessionImportRunRequest } from "@/components/session-import/session-import-run-handle";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

/**
 * The real page over the real `useWelcomeScan` → `useSessionImportScan` →
 * reducer chain, so every click lands in the wizard reducer and comes back
 * through the page's own projection. Faked: the scan stream client (frames
 * are played in by hand), the run handle, the status query, the stream
 * binding, and analytics.
 */
interface ScanClientHarness {
  callbacks: SessionImportScanCallbacks | null;
  readonly close: Mock<() => void>;
}

const scanClient = vi.hoisted((): ScanClientHarness => ({
  callbacks: null,
  close: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-scan-client",
  () => ({
    SessionImportScanClient: class {
      constructor(options: SessionImportScanClientOptions) {
        scanClient.callbacks = options.callbacks;
      }

      close(): void {
        scanClient.close();
      }
    },
  }),
);

interface StreamHarness {
  client: object;
  hostId: string;
  /**
   * One object per test, as the real binding is one object per transport:
   * the page's attach effect keys on its identity, and a binding minted per
   * render would re-attach on every commit.
   */
  binding: { wsStreamClient: object; hostId: string; retain: null };
  support: "supported" | "unsupported" | "unknown";
}

const stream = vi.hoisted((): StreamHarness => {
  const client = { stream: "test" };
  return {
    client,
    hostId: "host-1",
    binding: { wsStreamClient: client, hostId: "host-1", retain: null },
    support: "supported",
  };
});

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => stream.client,
  useStreamHostId: () => stream.hostId,
  useStreamRuntimeBinding: () => stream.binding,
  useStreamMethodSupportFor: () => stream.support,
}));

const startSessionImportRunMock = vi.hoisted(() =>
  vi.fn<
    (
      request: SessionImportRunRequest,
      binding: StreamRuntimeBinding | null,
    ) => void
  >(),
);
const attachSessionImportRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/session-import/session-import-run-handle", () => ({
  attachSessionImportRun: attachSessionImportRunMock,
  startSessionImportRun: startSessionImportRunMock,
}));

const statusQuery = vi.hoisted(() => ({
  data: {
    active: null,
    lastCompleted: null,
  } as SessionImportStatusResponse | undefined,
  isError: false,
  isFetching: false,
  isPending: false,
  isSuccess: true,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/session-import/use-session-import-check-status-query", () => ({
  useSessionImportCheckStatus: () => statusQuery,
}));

const analyticsTrack = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: analyticsTrack }) },
  AnalyticsEvent: {
    SessionImportStarted: "session_import_started",
    OnboardingModalContinued: "onboarding_modal_continued",
  },
}));

import { useWelcomeScan } from "@/components/onboarding/welcome/use-welcome-scan";
import { WelcomeSessionsPage } from "@/components/onboarding/welcome/welcome-sessions-page";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

interface PageCallbacks {
  readonly onImportStarted: Mock<() => void>;
  readonly onSkipImport: Mock<() => void>;
  readonly onNoSessions: Mock<() => void>;
  readonly onAlreadyRunningContinue: Mock<() => void>;
}

function TestPage(props: {
  readonly enabledProviderIds: ReadonlyArray<ProviderId>;
  readonly callbacks: PageCallbacks;
}) {
  const welcomeScan = useWelcomeScan({
    open: true,
    enabledProviderIds: props.enabledProviderIds,
  });
  return <WelcomeSessionsPage welcomeScan={welcomeScan} {...props.callbacks} />;
}

function renderPage(
  enabledProviderIds: ReadonlyArray<ProviderId> = ["claude-code", "codex"],
): PageCallbacks {
  const callbacks: PageCallbacks = {
    onImportStarted: vi.fn(),
    onSkipImport: vi.fn(),
    onNoSessions: vi.fn(),
    onAlreadyRunningContinue: vi.fn(),
  };
  render(
    <TestPage enabledProviderIds={enabledProviderIds} callbacks={callbacks} />,
  );
  return callbacks;
}

const ZERO_TOTALS: SessionImportScanTotals = {
  groups: 0,
  sessions: 0,
  importable: 0,
  alreadyInTraycer: 0,
  unreadable: 0,
};

const IMPORTABLE: SessionImportCandidateState = { kind: "importable" };

function importable(
  harness: GuiHarnessId,
  id: string,
  title: string,
): SessionImportCandidate {
  return {
    harness,
    nativeSessionId: id,
    title,
    firstPrompt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: null,
    hasSubagents: false,
    state: IMPORTABLE,
  };
}

function folder(
  path: string,
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return {
    location: { kind: "folder", path, workspaceId: null },
    gitBacked: true,
    sessions: [...sessions],
  };
}

function callbacks(): SessionImportScanCallbacks {
  const value = scanClient.callbacks;
  if (value === null) throw new Error("no scan client was opened");
  return value;
}

/** Folder A is shared: two Claude rows and one Codex row. Folder B is Codex only. */
function playSharedFolders(): void {
  act(() => {
    callbacks().onStarted(["claude", "codex"]);
    callbacks().onGroup(
      folder("/repo/a", [
        importable("claude", "c1", "Claude one"),
        importable("codex", "x1", "Codex one"),
        importable("claude", "c2", "Claude two"),
      ]),
    );
    callbacks().onGroup(folder("/repo/b", [importable("codex", "x2", "Codex two")]));
    callbacks().onComplete(ZERO_TOTALS);
  });
}

function section(harness: GuiHarnessId): HTMLElement {
  const match = screen
    .getAllByTestId("welcome-sessions-section")
    .find((element) => element.getAttribute("data-harness") === harness);
  if (match === undefined) throw new Error(`no section for ${harness}`);
  return match;
}

function sectionCheckbox(harness: GuiHarnessId): HTMLElement {
  return within(section(harness)).getByTestId("welcome-sessions-section-select");
}

function folderGroup(harness: GuiHarnessId, path: string): HTMLElement {
  const match = within(section(harness))
    .getAllByTestId("session-import-group")
    .find(
      (element) =>
        element.getAttribute("data-group-key") === `${harness}|folder:${path}`,
    );
  if (match === undefined) throw new Error(`no group ${harness}|${path}`);
  return match;
}

function importButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Import \d+ tasks?$/ });
}

beforeEach(() => {
  scanClient.callbacks = null;
  scanClient.close.mockReset();
  stream.client = { stream: "test" };
  stream.hostId = "host-1";
  stream.binding = {
    wsStreamClient: stream.client,
    hostId: "host-1",
    retain: null,
  };
  stream.support = "supported";
  startSessionImportRunMock.mockReset();
  attachSessionImportRunMock.mockReset();
  statusQuery.data = { active: null, lastCompleted: null };
  statusQuery.isError = false;
  statusQuery.isFetching = false;
  statusQuery.isPending = false;
  statusQuery.isSuccess = true;
  analyticsTrack.mockReset();
  useSessionImportRunStore.setState({ runs: new Map() });
  useFeatureAnnouncementsStore.setState({ consumed: {} });
});

afterEach(() => {
  cleanup();
});

describe("<WelcomeSessionsPage />", () => {
  it("consumes the session-import announcement on mount", () => {
    renderPage();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["session-import"],
    ).toBeTypeOf("number");
  });

  it("shows the spinner with Import disabled while scanning, then the count once complete", () => {
    renderPage();
    expect(screen.getByTestId("welcome-sessions-scan-spinner")).not.toBeNull();
    expect(importButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Skip import" })).not.toBeNull();

    playSharedFolders();
    expect(screen.queryByTestId("welcome-sessions-scan-spinner")).toBeNull();
    const button = importButton();
    expect(button.textContent).toBe("Import 4 tasks");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByTestId("welcome-sessions-selection-count").textContent,
    ).toBe("4 tasks selected");
  });

  it("toggles at provider, folder and row level without crossing providers", () => {
    renderPage();
    playSharedFolders();

    // Provider header: all Claude rows off, Codex untouched.
    expect(sectionCheckbox("claude").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sectionCheckbox("claude"));
    expect(sectionCheckbox("claude").getAttribute("aria-checked")).toBe("false");
    expect(sectionCheckbox("codex").getAttribute("aria-checked")).toBe("true");
    expect(importButton().textContent).toBe("Import 2 tasks");

    // Codex's folder A header: only Codex's key in that folder moves, even
    // though the two Claude rows share the folder.
    fireEvent.click(
      within(folderGroup("codex", "/repo/a")).getByTestId(
        "session-import-group-select",
      ),
    );
    expect(sectionCheckbox("codex").getAttribute("aria-checked")).toBe("mixed");
    expect(sectionCheckbox("claude").getAttribute("aria-checked")).toBe("false");
    expect(importButton().textContent).toBe("Import 1 task");

    // A row: expand Claude's folder A and tick one row back on.
    fireEvent.click(
      within(folderGroup("claude", "/repo/a")).getByTestId(
        "session-import-group-toggle",
      ),
    );
    const rows = within(folderGroup("claude", "/repo/a")).getAllByTestId(
      "session-import-row",
    );
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error("no first row");
    fireEvent.click(firstRow);
    expect(sectionCheckbox("claude").getAttribute("aria-checked")).toBe("mixed");
    expect(importButton().textContent).toBe("Import 2 tasks");
    // Expansion is per provider: Codex's slice of the same folder stays shut.
    expect(
      within(folderGroup("codex", "/repo/a")).queryAllByTestId(
        "session-import-row",
      ),
    ).toHaveLength(0);
  });

  it("ends in the empty state when the scan completes with nothing importable", () => {
    const page = renderPage(["claude-code"]);
    act(() => {
      callbacks().onStarted(["claude"]);
      callbacks().onComplete(ZERO_TOTALS);
    });
    expect(screen.getByTestId("welcome-sessions-empty").textContent).toBe(
      "No work from Claude Code in the last 7 days. Pick a longer window to look further back.",
    );
    expect(screen.queryByRole("button", { name: "Skip import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(page.onNoSessions).toHaveBeenCalledTimes(1);
  });

  it("shows a failed provider's banner in its section while the others stay importable", () => {
    renderPage();
    act(() => {
      callbacks().onStarted(["claude", "codex"]);
      callbacks().onGroup(
        folder("/repo/a", [importable("claude", "c1", "Claude one")]),
      );
      callbacks().onProviderFailed({
        harness: "codex",
        reason: "source_unreadable",
        detail: "~/.codex is unreadable",
      });
      callbacks().onComplete(ZERO_TOTALS);
    });
    const banner = within(section("codex")).getByTestId(
      "welcome-sessions-provider-failure",
    );
    expect(banner.textContent).toBe(
      "Your Codex work could not be read. ~/.codex is unreadable",
    );
    expect(sectionCheckbox("codex").hasAttribute("disabled")).toBe(true);
    expect(sectionCheckbox("claude").getAttribute("aria-checked")).toBe("true");
    expect(importButton().textContent).toBe("Import 1 task");
    expect(importButton().hasAttribute("disabled")).toBe(false);
  });

  it("starts the run on the stream binding with the welcome-modal surface and reports", () => {
    const page = renderPage();
    playSharedFolders();
    fireEvent.click(sectionCheckbox("claude"));
    fireEvent.click(importButton());

    expect(startSessionImportRunMock).toHaveBeenCalledTimes(1);
    const [request, target] = startSessionImportRunMock.mock.calls[0] ?? [];
    expect(request?.selections).toEqual([
      { harness: "codex", nativeSessionId: "x1" },
      { harness: "codex", nativeSessionId: "x2" },
    ]);
    expect(request?.titles.get("codex:x1")).toBe("Codex one");
    expect(target?.hostId).toBe("host-1");
    expect(analyticsTrack.mock.calls).toEqual([
      [
        "session_import_started",
        { surface: "welcome-modal", session_count: 2, group_count: 2 },
      ],
      [
        "onboarding_modal_continued",
        { page: "2", enabled_provider_count: 2, session_count: 2 },
      ],
    ]);
    expect(page.onImportStarted).toHaveBeenCalledTimes(1);
    expect(page.onSkipImport).not.toHaveBeenCalled();
  });

  it("reports Skip import without starting anything", () => {
    const page = renderPage();
    playSharedFolders();
    fireEvent.click(screen.getByRole("button", { name: "Skip import" }));
    expect(page.onSkipImport).toHaveBeenCalledTimes(1);
    expect(startSessionImportRunMock).not.toHaveBeenCalled();
  });

  it("attaches to a run already active on the host and offers only Continue", () => {
    const active: NonNullable<SessionImportStatusResponse["active"]> = {
      runId: "run-1",
      done: 1,
      total: 3,
    };
    statusQuery.data = { active, lastCompleted: null };
    const page = renderPage();
    playSharedFolders();

    expect(attachSessionImportRunMock).toHaveBeenCalledTimes(1);
    expect(attachSessionImportRunMock.mock.calls[0]?.[1]).toBe(active);
    expect(
      screen.getByTestId("welcome-sessions-already-running").textContent,
    ).toContain("An import is already running on this machine.");
    expect(screen.queryAllByTestId("welcome-sessions-section")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Skip import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(page.onAlreadyRunningContinue).toHaveBeenCalledTimes(1);
    expect(startSessionImportRunMock).not.toHaveBeenCalled();
  });

  it("says the host cannot import when the scan method is unsupported", () => {
    stream.support = "unsupported";
    const page = renderPage();
    expect(scanClient.callbacks).toBeNull();
    expect(
      screen.getByTestId("welcome-sessions-unsupported").textContent,
    ).toBe("This machine can't import sessions.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(page.onNoSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps what landed and allows Import when the scan stream fails", () => {
    renderPage();
    act(() => {
      callbacks().onStarted(["claude", "codex"]);
      callbacks().onGroup(
        folder("/repo/a", [importable("claude", "c1", "Claude one")]),
      );
      callbacks().onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INTERNAL",
          reason: "The host stopped answering mid-scan.",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    });
    expect(screen.getByTestId("welcome-sessions-scan-error").textContent).toBe(
      "The scan stopped before it finished. The host stopped answering mid-scan.",
    );
    expect(importButton().textContent).toBe("Import 1 task");
    expect(importButton().hasAttribute("disabled")).toBe(false);
  });
});
