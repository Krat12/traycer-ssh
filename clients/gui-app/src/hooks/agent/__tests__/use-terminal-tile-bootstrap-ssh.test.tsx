import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { CanonicalTerminalSessionInfoWithLifecycleOwner } from "@traycer/protocol/host/terminal/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

const state = vi.hoisted(
  (): {
    entry: HostDirectoryEntry | null;
    client: HostClient<HostRpcRegistry> | null;
  } => ({ entry: null, client: null }),
);

function getClient(): HostClient<HostRpcRegistry> {
  if (state.client === null) throw new Error("test client not configured");
  return state.client;
}

vi.mock("@/lib/host", () => ({
  useHostClient: getClient,
  useHostBinding: () => ({ hostClient: getClient(), hostId: null }),
}));
vi.mock("@/lib/host/runtime", () => ({ useHostRuntimeClient: getClient }));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => state.entry,
}));
const unusedTransport = vi.hoisted(() => () => {
  throw new Error("test supplies the terminal stream boundary");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => unusedTransport,
}));

import { useTerminalTileBootstrap } from "../use-terminal-tile-bootstrap";
import {
  __setTerminalStreamClientFactoryForTests,
  disposeAllTerminalSessions,
} from "@/lib/registries/terminal-session-registry";

const HOST_ID = "ssh-linux";
const initialEntry: HostDirectoryEntry = {
  hostId: HOST_ID,
  label: "Linux",
  kind: "ssh",
  websocketUrl: "ws://127.0.0.1:44001/rpc",
  version: "1.3.1",
  transportDialability: "dialable",
};
const listedSession: CanonicalTerminalSessionInfoWithLifecycleOwner = {
  sessionId: "existing-pty",
  scope: { kind: "epic", epicId: "epic-1" },
  sessionKind: "terminal",
  cwd: "/repo",
  currentCwd: "/repo",
  shellCommand: "bash",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  createdAt: 1,
  title: null,
  lifecycleOwner: "registry",
};

const queryClients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  disposeAllTerminalSessions();
  __setTerminalStreamClientFactoryForTests(null);
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  state.entry = null;
  state.client = null;
});

describe("terminal bootstrap over SSH", () => {
  it("retains the existing PTY through an endpoint outage without creating another session", async () => {
    state.entry = initialEntry;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClients.push(queryClient);
    const list = vi.fn(() => ({ sessions: [listedSession], homeCwd: "/home" }));
    const create = vi.fn(() => ({ session: listedSession }));
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "ssh-bootstrap-request",
      handlers: { "terminal.list": list, "terminal.create": create },
    });
    state.client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
      findHostById: (hostId) => (hostId === HOST_ID ? state.entry : null),
    });
    state.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "test-bearer",
      }),
    );
    const close = vi.fn();
    __setTerminalStreamClientFactoryForTests(() => ({
      sendAction: () => undefined,
      close,
    }));
    const prepare = vi.fn(() => Promise.resolve(null));
    function wrapper(props: { readonly children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
    }
    const { result, rerender } = renderHook(
      () =>
        useTerminalTileBootstrap({
          hostId: HOST_ID,
          scope: { kind: "epic", epicId: "epic-1" },
          sessionId: "existing-pty",
          instanceId: "ssh-bootstrap",
          sessionKind: "terminal",
          preparePayload: prepare,
        }),
      { wrapper },
    );
    act(() => {
      result.current.reportMeasuredGrid(100, 40);
    });
    await waitFor(() => {
      expect(result.current.handle).not.toBeNull();
    });
    const firstHandle = result.current.handle;
    expect(result.current.hostHasSession).toBe(true);
    expect(result.current.createIsSuccess).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);

    state.entry = {
      ...initialEntry,
      websocketUrl: null,
      transportDialability: "not-dialable",
    };
    rerender();
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(result.current.hostHasSession).toBe(true);
    expect(result.current.handle).toBe(firstHandle);
    expect(close).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);

    state.entry = { ...initialEntry, websocketUrl: "ws://127.0.0.1:44002/rpc" };
    rerender();
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
    expect(result.current.handle).toBe(firstHandle);
    expect(close).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
