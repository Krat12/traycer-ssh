import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { MuxFrameType } from "@traycer/protocol/host-transport/mux";
import { createRemoteStreamHarness } from "../../__testing__/remote-stream-relay";
import {
  remoteSessionRefCountForTest,
  retireAllRemoteSessions,
} from "../active-remote-sessions";

const registry = defineVersionedStreamRpcRegistry({
  "test.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineStreamRpcContract({
            method: "test.subscribe",
            schemaVersion: { major: 1, minor: 0 },
            openRequestSchema: z.object({}),
            serverFrameSchema: z.object({
              kind: z.literal("snapshot"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("input"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
  },
});
const WAIT = { timeout: 10_000, interval: 10 };
const serverFrame = { kind: "snapshot", hasBinaryPayload: false };
const clientFrame = { kind: "input", hasBinaryPayload: false };
afterEach(() => retireAllRemoteSessions());

describe("RemoteStreamClient owns logical streams independently of the shared relay", () => {
  it.each([true, false])(
    "closes its streams immediately with another holder=%s, including a lingering socket",
    async (keepPeer) => {
      const harness = createRemoteStreamHarness(
        `owned-relay-${String(keepPeer)}`,
        registry,
      );
      const client = harness.acquire();
      let peer = keepPeer ? harness.acquire() : null;
      const streams = [
        client.subscribe("test.subscribe", {}),
        client.subscribeAtVersion("test.subscribe", { major: 1, minor: 0 }, {}),
        client.subscribeWithParamsProvider("test.subscribe", () => ({})),
      ];
      const incoming = vi.fn();
      const status = vi.fn();
      for (const stream of streams) {
        stream.onServerFrame(incoming);
        stream.onStatusChange(status);
      }
      const closed = vi.fn();
      const recovered = vi.fn();
      const support = vi.fn();
      client.onClosed(closed);
      client.subscribeAvailabilityRecovered(recovered);
      client.subscribeMethodSupport(support);
      harness.session.start();
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages.filter(
              (message) => message.type === MuxFrameType.SUBSCRIBE,
            ),
          ).toHaveLength(3),
        WAIT,
      );
      const streamIds = harness.relay.messages
        .filter((message) => message.type === MuxFrameType.SUBSCRIBE)
        .map((message) => message.streamId);
      await harness.relay.sendStreamFrame(streamIds[0], serverFrame);
      await vi.waitFor(() => expect(incoming).toHaveBeenCalledTimes(1), WAIT);
      streams[0].sendClientFrame(clientFrame, null);
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages.filter(
              (message) => message.type === MuxFrameType.STREAM_FRAME,
            ),
          ).toHaveLength(1),
        WAIT,
      );

      client.close("durable-host-identity-changed");
      expect(client.isClosed()).toBe(true);
      expect(client.isReady()).toBe(false);
      expect(client.getClosedReason()).toBe("durable-host-identity-changed");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(
        status.mock.calls.filter(([value]) => value === "closed"),
      ).toHaveLength(3);
      expect(remoteSessionRefCountForTest(harness.identity)).toBe(
        keepPeer ? 1 : 0,
      );
      expect(harness.session.isReady()).toBe(true);
      expect(harness.relay.liveSocketCount).toBe(1);
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages
              .filter((message) => message.type === MuxFrameType.CLOSE)
              .map((message) => message.streamId),
          ).toEqual(streamIds),
        WAIT,
      );

      const lateStatus = vi.fn();
      client.subscribe("test.subscribe", {}).onStatusChange(lateStatus);
      client
        .subscribeAtVersion("test.subscribe", { major: 1, minor: 0 }, {})
        .onStatusChange(lateStatus);
      client
        .subscribeWithParamsProvider("test.subscribe", () => ({}))
        .onStatusChange(lateStatus);
      await vi.waitFor(() => expect(lateStatus).toHaveBeenCalledTimes(3), WAIT);
      expect(lateStatus.mock.calls[0][1]).toMatchObject({
        kind: "fatalError",
        details: { code: "CLIENT_CLOSED" },
      });
      client.close("second-close");
      client.onClosed(closed);
      expect(closed).toHaveBeenCalledTimes(1);

      // With no original peer, acquire the still-live cached socket during its
      // 60-second linger. Only the new holder may send/receive on it now.
      peer ??= harness.acquire();
      const peerStream = peer.subscribe("test.subscribe", {});
      const peerFrames = vi.fn();
      peerStream.onServerFrame(peerFrames);
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages.filter(
              (message) => message.type === MuxFrameType.SUBSCRIBE,
            ),
          ).toHaveLength(4),
        WAIT,
      );
      const peerId = harness.relay.messages.filter(
        (message) => message.type === MuxFrameType.SUBSCRIBE,
      )[3].streamId;
      await harness.relay.sendStreamFrame(streamIds[0], serverFrame);
      await harness.relay.sendStreamFrame(peerId, serverFrame);
      await vi.waitFor(() => expect(peerFrames).toHaveBeenCalledTimes(1), WAIT);
      expect(incoming).toHaveBeenCalledTimes(1);
      for (const stream of streams) stream.sendClientFrame(clientFrame, null);
      peerStream.sendClientFrame(clientFrame, null);
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages
              .filter((message) => message.type === MuxFrameType.STREAM_FRAME)
              .map((message) => message.streamId),
          ).toEqual([streamIds[0], peerId]),
        WAIT,
      );

      const previousRecovered = recovered.mock.calls.length;
      const previousSupport = support.mock.calls.length;
      peer.reconnectAll("test-peer-reconnect", {
        probeFirst: false,
        wakeProbe: null,
      });
      await vi.waitFor(
        () =>
          expect(
            harness.relay.messages.filter(
              (message) => message.type === MuxFrameType.SUBSCRIBE,
            ),
          ).toHaveLength(5),
        WAIT,
      );
      expect(recovered).toHaveBeenCalledTimes(previousRecovered);
      expect(support).toHaveBeenCalledTimes(previousSupport);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(harness.relay.errors).toEqual([]);
      peer.close("test-cleanup");
    },
    15_000,
  );

  it("reports shared-session terminal close once, and releases its acquired reference", async () => {
    const harness = createRemoteStreamHarness("owned-relay-fatal", registry);
    const client = harness.acquire();
    const closed = vi.fn();
    client.onClosed(closed);
    harness.session.start();
    await vi.waitFor(() => expect(client.isReady()).toBe(true), WAIT);
    await harness.relay.sendSessionFatal();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1), WAIT);
    expect(client.isClosed()).toBe(true);
    expect(remoteSessionRefCountForTest(harness.identity)).toBe(0);
    client.close("test-cleanup");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(harness.relay.errors).toEqual([]);
  }, 15_000);
});
