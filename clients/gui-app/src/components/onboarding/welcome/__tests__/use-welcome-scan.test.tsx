import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  SessionImportScanCallbacks,
  SessionImportScanClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-scan-client";

/**
 * The real `useWelcomeScan` → `useSessionImportScan` → reducer chain over a
 * recording scan client: what matters is WHICH roster each client is opened
 * with, and when one is opened at all.
 */
interface ScanClientHarness {
  readonly opened: Array<ReadonlyArray<GuiHarnessId> | null>;
  callbacks: SessionImportScanCallbacks | null;
  readonly close: ReturnType<typeof vi.fn>;
}

const scanClient = vi.hoisted((): ScanClientHarness => ({
  opened: [],
  callbacks: null,
  close: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-scan-client",
  () => ({
    SessionImportScanClient: class {
      constructor(options: SessionImportScanClientOptions) {
        scanClient.opened.push(options.providers);
        scanClient.callbacks = options.callbacks;
      }

      close(): void {
        scanClient.close();
      }
    },
  }),
);

const stream = vi.hoisted(() => ({
  client: { stream: "test" } as object | null,
  hostId: "host-a" as string | null,
  support: "supported" as "supported" | "unsupported" | "unknown" | null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => stream.client,
  useStreamHostId: () => stream.hostId,
  useStreamMethodSupportFor: () => stream.support,
}));

import { useWelcomeScan } from "@/components/onboarding/welcome/use-welcome-scan";

function renderScan(initial: ReadonlyArray<ProviderId>) {
  return renderHook(
    (props: { readonly enabledProviderIds: ReadonlyArray<ProviderId> }) =>
      useWelcomeScan({
        open: true,
        enabledProviderIds: props.enabledProviderIds,
      }),
    { initialProps: { enabledProviderIds: initial } },
  );
}

describe("useWelcomeScan", () => {
  beforeEach(() => {
    scanClient.opened.length = 0;
    scanClient.callbacks = null;
    scanClient.close.mockReset();
    stream.client = { stream: "test" };
    stream.hostId = "host-a";
    stream.support = "supported";
  });

  afterEach(() => {
    cleanup();
  });

  it("scans the session-capable subset of the enabled providers, sorted", () => {
    const { result } = renderScan(["traycer", "claude-code", "cursor"]);
    expect(result.current.providers).toEqual(["claude"]);
    expect(result.current.eligible).toBe(true);
    expect(result.current.support).toBe("supported");
    expect(scanClient.opened).toEqual([["claude"]]);
  });

  it("restarts the scan on a roster change, and keeps it across an unchanged one", () => {
    const { result, rerender } = renderScan(["claude-code"]);
    expect(scanClient.opened).toEqual([["claude"]]);

    // Same roster, new array identity: no restart.
    rerender({ enabledProviderIds: ["claude-code"] });
    expect(scanClient.opened).toHaveLength(1);
    expect(scanClient.close).not.toHaveBeenCalled();

    // Codex toggled on: the old client closes and a new one opens with both,
    // in sorted order whatever order enablement listed them in.
    rerender({ enabledProviderIds: ["codex", "claude-code"] });
    expect(scanClient.close).toHaveBeenCalledTimes(1);
    expect(scanClient.opened).toEqual([["claude"], ["claude", "codex"]]);
    expect(result.current.providers).toEqual(["claude", "codex"]);
    // A roster change is a fresh scan, not a reconnect.
    expect(result.current.scan.state.phase).toBe("scanning");
  });

  it("opens no client when the host cannot scan", () => {
    stream.support = "unsupported";
    const { result } = renderScan(["claude-code"]);
    expect(result.current.eligible).toBe(false);
    expect(result.current.support).toBe("unsupported");
    expect(scanClient.opened).toHaveLength(0);
  });

  it("opens no client while support is unknown, but stays eligible", () => {
    stream.support = "unknown";
    const { result } = renderScan(["claude-code"]);
    expect(result.current.eligible).toBe(true);
    expect(scanClient.opened).toHaveLength(0);
  });

  it("reads a null client as unknown support", () => {
    stream.client = null;
    stream.support = null;
    const { result } = renderScan(["claude-code"]);
    expect(result.current.support).toBe("unknown");
    expect(scanClient.opened).toHaveLength(0);
  });

  it("never opens a client over an empty roster", () => {
    const { result, rerender } = renderScan(["cursor", "traycer"]);
    expect(result.current.providers).toEqual([]);
    expect(result.current.eligible).toBe(false);
    expect(scanClient.opened).toHaveLength(0);

    rerender({ enabledProviderIds: [] });
    expect(scanClient.opened).toHaveLength(0);
  });

  it("counts importable rows across every group the scan produced", () => {
    const { result } = renderScan(["claude-code", "codex"]);
    expect(result.current.importableCount).toBe(0);
    const callbacks = scanClient.callbacks;
    if (callbacks === null) throw new Error("no scan client");
    act(() => {
      callbacks.onStarted(["claude", "codex"]);
      callbacks.onGroup({
        location: { kind: "folder", path: "/repo/a", workspaceId: null },
        gitBacked: true,
        sessions: [
          {
            harness: "claude",
            nativeSessionId: "s1",
            title: "One",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "importable" },
          },
          {
            harness: "codex",
            nativeSessionId: "s2",
            title: "Two",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "already_in_traycer", epicId: "e", chatId: "c" },
          },
        ],
      });
      callbacks.onGroup({
        location: { kind: "missing_folder", path: "/gone" },
        gitBacked: false,
        sessions: [
          {
            harness: "claude",
            nativeSessionId: "s3",
            title: "Three",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "importable" },
          },
        ],
      });
    });
    expect(result.current.importableCount).toBe(2);
  });
});
