import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  NoiseSession,
  DEFAULT_REPLAY_WINDOW_SIZE,
} from "@traycer/protocol/crypto/noise";
import {
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  OutboundChunkSource,
  type OutboundMessage,
  type ReassembledMessage,
} from "@traycer/protocol/host-transport/chunking";
import { MutableBearerLease } from "../../auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import type { StreamFrameEnvelope } from "../i-stream-session";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
} from "../ws-stream-factory";
import {
  acquireRemoteSession,
  type RemoteSessionIdentity,
} from "../remote/active-remote-sessions";
import { RemoteSession } from "../remote/remote-session";
import { RemoteStreamClient } from "../remote/remote-stream-client";

interface Connection {
  readonly socket: StreamWebSocketLike;
  readonly reassembler: ChunkReassembler;
  readonly sequences: Map<number, number>;
  noise: NoiseSession | null;
  queue: Promise<void>;
  closed: boolean;
}

/** Only the external relay/host wire is fake: real Noise, mux, session and cache. */
export class RemoteStreamRelay {
  readonly hostKeys = generateStaticKeyPair();
  readonly messages: ReassembledMessage[] = [];
  readonly errors: unknown[] = [];
  private readonly connections: Connection[] = [];

  constructor(private readonly registry: VersionedStreamRpcRegistry) {}

  readonly factory: IStreamWebSocketFactory = {
    create: () => {
      const socket: StreamWebSocketLike = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => this.enqueue(connection, data),
        close: () => {
          connection.closed = true;
        },
      };
      const connection: Connection = {
        socket,
        reassembler: new ChunkReassembler(undefined),
        sequences: new Map(),
        noise: null,
        queue: Promise.resolve(),
        closed: false,
      };
      this.connections.push(connection);
      queueMicrotask(() => {
        if (connection.closed) return;
        socket.onopen?.({ type: "open" });
        socket.onmessage?.({
          type: "text",
          data: JSON.stringify({
            type: "attach_ack",
            role: "client",
            sid: this.connections.length,
          }),
        });
      });
      return socket;
    },
  };

  get liveSocketCount(): number {
    return this.connections.filter((connection) => !connection.closed).length;
  }

  private liveConnection(): Connection {
    const connection = this.connections.findLast(
      (candidate) => !candidate.closed,
    );
    if (connection === undefined) throw new Error("No live relay socket");
    return connection;
  }

  async sendStreamFrame(
    streamId: number,
    frame: StreamFrameEnvelope,
  ): Promise<void> {
    await this.send(this.liveConnection(), {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { ...frame },
      binary: null,
    });
  }

  async sendSessionFatal(): Promise<void> {
    await this.send(this.liveConnection(), {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      binary: null,
      json: {
        details: {
          code: "INCOMPATIBLE",
          reason: "test terminal close",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    });
  }

  private enqueue(connection: Connection, data: string | Uint8Array): void {
    if (data === "relay-ping") {
      queueMicrotask(() => {
        if (!connection.closed)
          connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
      });
      return;
    }
    connection.queue = connection.queue
      .then(() => this.receive(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private async receive(
    connection: Connection,
    data: string | Uint8Array,
  ): Promise<void> {
    if (connection.closed || typeof data === "string") return;
    if (connection.noise === null) {
      const handshake = await createResponderHandshake(
        this.hostKeys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const reply = await handshake.writeMessage(new Uint8Array(0));
      connection.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      connection.socket.onmessage?.({ type: "binary", data: reply });
      return;
    }
    const decoded = decodeMuxFrame(
      await connection.noise.decrypt(data, new Uint8Array(0)),
    );
    const message = connection.reassembler.accept(decoded);
    if (message === null) return;
    this.messages.push(message);
    if (message.type === MuxFrameType.OPEN) {
      await this.send(connection, {
        type: MuxFrameType.OPEN_ACK,
        streamId: SESSION_CONTROL_STREAM_ID,
        qos: QosClass.INTERACTIVE,
        binary: null,
        json: {
          manifest: {
            rpc: {},
            optionalRpc: {},
            stream: buildStreamManifest(
              this.registry,
              SERVES_EVERY_INSTALLED_MAJOR,
            ),
          },
          capabilities: [],
        },
      });
    }
  }

  private async send(
    connection: Connection,
    message: OutboundMessage,
  ): Promise<void> {
    const noise = connection.noise;
    if (noise === null || connection.closed)
      throw new Error("Relay is not ready");
    const source = new OutboundChunkSource(
      message,
      () => {
        const seq = connection.sequences.get(message.streamId) ?? 0;
        connection.sequences.set(message.streamId, seq + 1);
        return seq;
      },
      false,
    );
    while (!source.done) {
      const data = await noise.encrypt(
        encodeMuxFrame(source.nextFrame()),
        new Uint8Array(0),
      );
      if (!connection.closed)
        connection.socket.onmessage?.({ type: "binary", data });
    }
  }
}

export function createRemoteStreamHarness<
  Registry extends VersionedStreamRpcRegistry,
>(hostId: string, registry: Registry) {
  const relay = new RemoteStreamRelay(registry);
  const lease = new MutableBearerLease("test-bearer", "user-a");
  const identity: RemoteSessionIdentity = {
    hostId,
    userId: "user-a",
    hostPublicKey: "registered-key",
    relayAttachUrl: "wss://relay.test/attach",
    authRecovery: "terminal",
    authEpoch: hostId,
  };
  const session = new RemoteSession({
    hostId,
    attachBaseUrl: identity.relayAttachUrl,
    hostStaticPublicKey: relay.hostKeys.publicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok",
        grant: { grant: "test-grant", expiresInSeconds: 300 },
      }),
    bearer: () => lease,
    auth: null,
    clock: null,
    rpcRegistry: defineVersionedRpcRegistry({}),
    streamRegistry: registry,
    webSocketFactory: relay.factory,
    requestId: () => "test-request",
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
  return {
    relay,
    session,
    identity,
    acquire: () =>
      new RemoteStreamClient(
        acquireRemoteSession(
          identity,
          { proactiveWakeEligible: true },
          () => session,
        ),
        () => null,
      ),
  };
}
