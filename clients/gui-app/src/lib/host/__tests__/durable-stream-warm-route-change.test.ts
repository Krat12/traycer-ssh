import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { sshHostDirectoryEntry } from "@traycer-clients/shared/host-client/ssh-host-directory";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { createRemoteStreamHarness } from "@traycer-clients/shared/host-transport/__testing__/remote-stream-relay";
import {
  remoteSessionRefCountForTest,
  retireAllRemoteSessions,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { MuxFrameType } from "@traycer/protocol/host-transport/mux";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { ChatSessionRegistry } from "@/stores/chats/session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { openDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  dialableHostEndpoint,
  remoteAwareOwnerIdentity,
} from "@/lib/host/transport-key";

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("@/hooks/host/use-host-stream-client-for", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  buildHostStreamClient: mocks.build,
}));
vi.mock("@/lib/host/stream-wake-reconnect", () => ({
  subscribeStreamWakeReconnect: () => () => undefined,
}));
vi.mock("@/lib/persist/wipe", () => ({
  clearAllPersistedStores: () => undefined,
}));

const HOST_ID = "warm-linux";
const remote: RemoteHostDirectoryEntry = {
  hostId: HOST_ID,
  label: "Linux",
  kind: "remote",
  websocketUrl: "wss://relay.test/attach",
  version: "1.3.1",
  transportDialability: "dialable",
  publicKey: "registered-key",
  relayFuseGrace: false,
  recentHostCheckIn: false,
  planAllowsRemote: true,
  remoteStatus: {
    connectivity: "connectable",
    viewerReachability: "ok",
    clientCloud: "ok",
    updateState: "current",
    appVersion: "1.3.1",
    lastSeenAt: null,
  },
};
const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.test/sign-in",
  authnBaseUrl: "https://auth.test",
  localHost: null,
  hosts: [],
  hasLocalHost: false,
  workspaceFolderPickerPaths: undefined,
  traycerCli: undefined,
});
const registries: ChatSessionRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.disposeAll();
  retireAllRemoteSessions();
  mocks.build.mockReset();
});

describe("warm chat transport route changes without a React consumer", () => {
  it.each([
    { state: "connected", keepPeer: true },
    { state: "error", keepPeer: true },
    { state: "connected", keepPeer: false },
    { state: "error", keepPeer: false },
  ] as const)(
    "closes a warm relay chat for SSH $state with another holder=$keepPeer",
    async ({ state, keepPeer }) => {
      let current: HostDirectoryEntry = remote;
      const directoryListeners = new Set<() => void>();
      const harness = createRemoteStreamHarness(HOST_ID, hostStreamRpcRegistry);
      let peer = keepPeer ? harness.acquire() : null;
      const opened: Array<{
        readonly target: HostDirectoryEntry;
        readonly client: IHostStreamClient<HostStreamRpcRegistry>;
      }> = [];
      const typedClients: ChatStreamClient[] = [];
      mocks.build.mockImplementation(
        ({
          target,
          endpoint,
        }: {
          readonly target: HostDirectoryEntry;
          readonly endpoint: HostEndpointProvider;
        }) => {
          const client =
            target.kind === "remote"
              ? harness.acquire()
              : new WsStreamClient({
                  clientIdentity: TEST_CLIENT_IDENTITY,
                  registry: hostStreamRpcRegistry,
                  endpoint,
                  hostId: HOST_ID,
                  bearer: () => null,
                  auth: null,
                  clock: null,
                  hostCredentialMint: null,
                  onHostCredentialState: null,
                  evidence: NO_TRANSPORT_EVIDENCE,
                  webSocketFactory: {
                    create: () => ({
                      onopen: null,
                      onmessage: null,
                      onclose: null,
                      onerror: null,
                      send: () => undefined,
                      close: () => undefined,
                    }),
                  },
                  dialTimeoutMs: 1000,
                  openAckTimeoutMs: 1000,
                  pingIntervalMs: 25_000,
                  pongTimeoutMs: 50_000,
                  initialBackoffMs: 10,
                  maxBackoffMs: 1000,
                });
          opened.push({ target, client });
          return client;
        },
      );
      // The real registry, store, typed client and owned transport remain alive
      // after release, backed by real RemoteStreamClient/refcount cache/Noise.
      // The fake replaces only the external relay/Host and SSH wire.
      const registry = new ChatSessionRegistry({
        idleTtlMs: 600_000,
        maxWarmSessions: 8,
      });
      registries.push(registry);
      const openTransport = () =>
        openDurableStreamTransport({
          target: current,
          readTarget: () => current,
          userId: "user-a",
          endpoint: () => dialableHostEndpoint(current),
          bearer: () => null,
          auth: { revalidateForReconnect: () => Promise.resolve("rotated") },
          runnerHost,
          subscribeBearerRotation: () => () => undefined,
          subscribeCloudVerdictChange: () => () => undefined,
          subscribeEndpointChange: (listener) => {
            directoryListeners.add(listener);
            return () => {
              directoryListeners.delete(listener);
            };
          },
          notifyRecoveredForNamedHost: () => undefined,
        });
      const acquire = () =>
        registry.acquire(
          {
            hostId: HOST_ID,
            epicId: "epic-1",
            chatId: "chat-1",
            scopeKey: remoteAwareOwnerIdentity(current, "user-a"),
          },
          (epicId, chatId) =>
            createChatSessionStore({
              environment: CHAT_STORE_TEST_ENVIRONMENT,
              hostId: HOST_ID,
              epicId,
              chatId,
              userId: null,
              onAuthError: null,
              onProviderAuthError: null,
              wakeTransport: null,
              streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
              streamClientFactory: (
                factoryEpicId,
                factoryChatId,
                callbacks,
              ) => {
                const owned = openOwnedDurableStreamClient(
                  openTransport,
                  HOST_ID,
                  (wsStreamClient) => {
                    const client = new ChatStreamClient({
                      wsStreamClient,
                      epicId: factoryEpicId,
                      chatId: factoryChatId,
                      callbacks,
                    });
                    typedClients.push(client);
                    return client;
                  },
                  null,
                );
                return {
                  sendAction: (frame) => owned.client.sendAction(frame),
                  sameTurnSteeringProtocolSupported: () =>
                    owned.client.sameTurnSteeringProtocolSupported(),
                  requestTranscriptRange: (request) =>
                    owned.client.requestTranscriptRange(request),
                  requestResnapshot: () => owned.client.requestResnapshot(),
                  close: owned.close,
                };
              },
            }),
        );
      const first = acquire();
      const formerRelay = opened[0].client;
      harness.session.start();
      const subscribes = () =>
        harness.relay.messages.filter(
          (message) => message.type === MuxFrameType.SUBSCRIBE,
        );
      const inputs = () =>
        harness.relay.messages.filter(
          (message) => message.type === MuxFrameType.STREAM_FRAME,
        );
      await vi.waitFor(() => expect(subscribes()).toHaveLength(1), {
        timeout: 10_000,
      });
      const chatStreamId = subscribes()[0].streamId;
      const queueFrame = (status: "paused" | "running") => ({
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        queue: { status, items: [] },
      });
      await harness.relay.sendStreamFrame(chatStreamId, queueFrame("paused"));
      await vi.waitFor(() =>
        expect(first.store.getState().queue.status).toBe("paused"),
      );
      typedClients[0].requestResnapshot();
      await vi.waitFor(() => expect(inputs()).toHaveLength(1));
      registry.release("epic-1", "chat-1", HOST_ID);
      expect(registry.peek("epic-1", "chat-1", HOST_ID)).toBe(first);
      expect(formerRelay.isClosed()).toBe(false);

      current = sshHostDirectoryEntry(
        {
          profile: { hostId: HOST_ID, label: "Linux", target: "linux-dev" },
          state,
          websocketUrl:
            state === "connected" ? "ws://127.0.0.1:44001/rpc" : null,
          version: "1.3.1",
          message: state === "error" ? "SSH unavailable" : null,
        },
        remote,
      );
      for (const listener of [...directoryListeners]) listener();
      expect(formerRelay.isClosed()).toBe(true);
      expect(first.store.getState().connectionStatus).toBe("closed");
      expect(harness.session.isReady()).toBe(true);
      expect(harness.relay.liveSocketCount).toBe(1);
      expect(remoteSessionRefCountForTest(harness.identity)).toBe(
        keepPeer ? 1 : 0,
      );
      expect(directoryListeners.size).toBe(0);
      expect(opened).toHaveLength(1);
      await vi.waitFor(() =>
        expect(
          harness.relay.messages
            .filter((message) => message.type === MuxFrameType.CLOSE)
            .map((message) => message.streamId),
        ).toEqual([chatStreamId]),
      );

      // A real surviving holder (or one adopting the lingered socket) is the
      // wire-order barrier: its traffic succeeds while stale chat traffic dies.
      peer ??= harness.acquire();
      const peerStream = peer.subscribe("chat.subscribe", {
        epicId: "epic-1",
        chatId: "peer-chat",
      });
      const peerFrames = vi.fn();
      peerStream.onServerFrame(peerFrames);
      await vi.waitFor(() => expect(subscribes()).toHaveLength(2));
      const peerId = subscribes()[1].streamId;
      await harness.relay.sendStreamFrame(chatStreamId, queueFrame("running"));
      await harness.relay.sendStreamFrame(peerId, queueFrame("running"));
      await vi.waitFor(() => expect(peerFrames).toHaveBeenCalledTimes(1));
      expect(first.store.getState().queue.status).toBe("paused");
      typedClients[0].requestResnapshot();
      peerStream.sendClientFrame(
        {
          kind: "resnapshot",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "peer-chat",
        },
        null,
      );
      await vi.waitFor(() =>
        expect(inputs().map((message) => message.streamId)).toEqual([
          chatStreamId,
          peerId,
        ]),
      );

      const replacement = acquire();
      expect(replacement).not.toBe(first);
      expect(opened).toHaveLength(2);
      expect(opened[1].target.kind).toBe("ssh");
      const sshClient = opened[1].client;
      registry.release("epic-1", "chat-1", HOST_ID);
      const store = replacement.store;
      current = {
        ...current,
        websocketUrl: null,
        transportDialability: "not-dialable",
      };
      for (const listener of [...directoryListeners]) listener();
      current = {
        ...current,
        websocketUrl: "ws://127.0.0.1:44002/rpc",
        transportDialability: "dialable",
      };
      for (const listener of [...directoryListeners]) listener();
      expect(registry.peek("epic-1", "chat-1", HOST_ID)).toBe(replacement);
      expect(replacement.store).toBe(store);
      expect(sshClient.isClosed()).toBe(false);
      expect(opened).toHaveLength(2);
      expect(harness.relay.errors).toEqual([]);
      peer.close("test-cleanup");
    },
    15_000,
  );
});
