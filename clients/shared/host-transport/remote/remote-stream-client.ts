import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "../host-stream-client";
import type { IStreamSession } from "../i-stream-session";
import type { StreamParamsProvider } from "../i-stream-client";
import {
  createInertStreamSession,
  type ParamsOf,
  type StreamMethodSupport,
} from "../ws-stream-client";
import {
  PLAN_RESTRICTED_FATAL_CODE,
  planRestrictedClosedReason,
} from "./config";
import type { IRemoteSession } from "./remote-session";
import type { AvailabilityRecoveryKind } from "../availability-recovery-kind";

/** Monotonic source for `RemoteStreamClient.instanceId` (log correlation). */
let nextRemoteStreamClientId = 0;

/**
 * `IHostStreamClient` over the persistent remote session — the streaming
 * sibling of `WsStreamClient`. Because the typed wrappers depend only on
 * `IStreamClient` (transport-seam spike extraction), this is a drop-in for the
 * local client: `TerminalStreamClient`, `ChatStreamClient`, … run unchanged
 * over the mux. The lifecycle superset (`close`/`isClosed`/
 * `notifyBearerRotated`/`reconnectAll`) is what lets the app-wide/durable
 * stream provider tree select this transport by `kind` with no wrapper change
 * (T14).
 */
export class RemoteStreamClient<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> implements IHostStreamClient<StreamRegistry> {
  private readonly session: IRemoteSession<RpcRegistry, StreamRegistry>;
  private readonly planRestrictedReprobeAt: () => number | null;
  private readonly ownedStreams = new Set<IStreamSession>();
  private readonly subscriptions = new Set<() => void>();
  private readonly closedListeners = new Set<() => void>();
  private closed = false;
  private closedReason: string | null = null;
  private sessionCloseWired = false;
  readonly instanceId = `remote-stream-client-${nextRemoteStreamClientId++}`;

  constructor(
    session: IRemoteSession<RpcRegistry, StreamRegistry>,
    planRestrictedReprobeAt: () => number | null,
  ) {
    this.session = session;
    this.planRestrictedReprobeAt = planRestrictedReprobeAt;
  }

  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProvider(method, () => params);
  }

  subscribeAtVersion<Method extends keyof StreamRegistry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.openOwnedStream(() =>
      this.session.subscribeAtVersion(method, schemaVersion, params),
    );
  }

  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: StreamParamsProvider<StreamRegistry, Method>,
  ): IStreamSession {
    return this.openOwnedStream(() =>
      this.session.subscribeWithParamsProvider(method, paramsProvider),
    );
  }

  /** Pushes a rotated bearer in place (no reconnect) if the host supports it. */
  notifyBearerRotated(): void {
    if (!this.isClosed()) this.session.notifyBearerRotated();
  }

  /** Pushes the current cloud verdict in place if the host supports it. */
  notifyCloudVerdictChanged(): void {
    if (!this.isClosed()) this.session.notifyCloudVerdictChanged();
  }

  isClosed(): boolean {
    return this.closed || this.session.isClosed();
  }

  getClosedReason(): string | null {
    if (this.session.terminalFatal()?.code !== PLAN_RESTRICTED_FATAL_CODE) {
      return this.closedReason;
    }
    const reprobeAt = this.planRestrictedReprobeAt();
    return reprobeAt === null ? null : planRestrictedClosedReason(reprobeAt);
  }

  /**
   * Fires once when THIS client closes, including a shared-session terminal
   * close. Releasing a client must be visible immediately even while another
   * holder (or the cache's linger) keeps the underlying socket alive.
   * Not retro-fired; late callers pair this with `isClosed()`.
   */
  onClosed(listener: () => void): () => void {
    if (this.isClosed()) return () => undefined;
    this.observeSessionClose();
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    // The acquired session's close only releases a reference. Cancel our own
    // logical subscriptions BEFORE release; forcing the shared socket closed
    // would interrupt unrelated holders, while release alone leaks streams.
    const cleanup = [
      ...this.subscriptions,
      ...Array.from(this.ownedStreams, (stream) => () => stream.close()),
      () => this.session.close(),
      ...this.closedListeners,
    ];
    this.ownedStreams.clear();
    this.closedListeners.clear();
    for (const dispose of cleanup) {
      try {
        dispose();
      } catch (error) {
        console.error("RemoteStreamClient close listener failed", error);
      }
    }
    this.subscriptions.clear();
  }

  private openOwnedStream(open: () => IStreamSession): IStreamSession {
    if (this.isClosed()) {
      return createInertStreamSession(
        this.getClosedReason() ?? "remote-session-closed",
      );
    }
    this.observeSessionClose();
    const stream = open();
    this.ownedStreams.add(stream);
    // Observe terminal streams even before a typed wrapper installs a handler.
    // The wrapper below preserves the single-handler/replayed-close contract.
    stream.onStatusChange((status) => {
      if (status === "closed") this.ownedStreams.delete(stream);
    });
    return {
      sendClientFrame: (frame, binary) => stream.sendClientFrame(frame, binary),
      onServerFrame: (handler) => stream.onServerFrame(handler),
      onStatusChange: (handler) =>
        stream.onStatusChange((status, reason, cause) => {
          if (status === "closed") this.ownedStreams.delete(stream);
          handler(status, reason, cause);
        }),
      getNegotiatedSchemaVersion: () => stream.getNegotiatedSchemaVersion(),
      requestReconnect: () => stream.requestReconnect(),
      close: () => {
        this.ownedStreams.delete(stream);
        stream.close();
      },
    };
  }

  private trackSubscription(subscribe: () => () => void): () => void {
    if (this.isClosed()) return () => undefined;
    this.observeSessionClose();
    const unsubscribe = subscribe();
    if (this.isClosed()) {
      unsubscribe();
      return () => undefined;
    }
    const dispose = () => {
      if (this.subscriptions.delete(dispose)) unsubscribe();
    };
    this.subscriptions.add(dispose);
    return dispose;
  }

  private observeSessionClose(): void {
    if (this.sessionCloseWired) return;
    this.sessionCloseWired = true;
    // Unary-only transport factories also construct a stream client, then
    // release their acquired session directly. Do not retain those unused
    // wrappers in the shared session's listeners.
    this.trackSubscription(() =>
      this.session.onClosed(() => this.close("remote-session-closed")),
    );
  }

  /**
   * Reconnects THIS client's session and no other (see
   * {@link IRemoteSession.wake} / {@link IRemoteSession.forceReconnect}).
   *
   * There is no endpoint to re-resolve - a remote session's attach address is
   * the relay's fixed WS URL, never a per-host one that moves on respawn - but
   * `probeFirst` still names two genuinely different demands. Probe-first
   * forwards to the session's own wake: poke the socket, re-dial only on a
   * failed verdict, pull a stale backoff wait forward. Forced
   * (`probeFirst: false`) is a caller declaring the current socket not worth
   * probing - a person tapping Retry now, an endpoint-change sweep - and it
   * drops the socket and re-dials with no backoff delay. It used to be
   * flattened into `wake`, which made Retry-now a spectator to the very 10s
   * probe window the person was trying to cut short.
   *
   * Scope is the whole point, and it is why this is NOT the cache-wide sweep.
   * The caller here is asking about a connection it can name - a user tapping
   * Retry on a banner that told them about ONE session - and a verdict and its
   * remedy must share scope. A button that reports session A and then dials A,
   * B and C is lying about at least two of them. Runtime resume is a different
   * question with a different answer (`wakeHeldRemoteSessions`): there the
   * evidence is about the whole process, so the whole cache is in scope.
   *
   * Production builds this over an ACQUIRED view, so a client whose consumer
   * has released inherits that view's ownership guard and this becomes a no-op
   * rather than hurrying a session nobody holds.
   */
  reconnectAll(reason: string, options: ReconnectAllOptions): void {
    if (this.isClosed()) return;
    if (options.probeFirst) {
      this.session.wake(reason, options.wakeProbe);
    } else {
      this.session.forceReconnect(reason);
    }
  }

  /**
   * Whether the session backing THIS client is carrying traffic right now
   * (see {@link IRemoteSession.isReady}) - full attach through the host's own
   * `openAck`, with the host still attached at the relay. What any one stream
   * has delivered stays that stream's own status: a subscription with nothing
   * to say is not an unready connection.
   *
   * Exact by construction: one client, one shared session, no lookup by host.
   * A ready one-shot session or a lingering keep-warm one for the same host
   * cannot answer here, which is the whole reason a surface speaking for one
   * connection must ask its client rather than scan the cache.
   */
  isReady(): boolean {
    return !this.isClosed() && this.session.isReady();
  }

  /**
   * The session's own silence verdict (see {@link IRemoteSession.isSilentFor}),
   * forwarded unchanged - including its `isReady()` term, so a client whose
   * host is merely DETACHED at the relay answers false and a person's Retry
   * stays a re-subscribe.
   *
   * Production builds this over an ACQUIRED view, so a client whose consumer
   * has released inherits that view's ownership guard and answers false too.
   */
  isSilentFor(ms: number): boolean {
    return !this.isClosed() && this.session.isSilentFor(ms);
  }

  /**
   * Bridges the session's ready-boundary transition (full attach through the
   * host's `openAck`; see `RemoteSession.subscribeAvailabilityRecovered`) to
   * availability-recovered listeners - the same "endpoint recovered" evidence
   * `WsStreamClient`
   * surfaces when a session re-opens after a drop, PLUS the clean first open
   * (a remote session's first dial races the queries that created it; see
   * the session contract for why). This is what un-strands errored
   * host-scoped queries for a tab bound to a NON-active remote host, whose
   * only recovery evidence is its own transport (the registry-liveness +
   * relay-resume path only covers the active host).
   *
   * Every emission is reported as a `"reconnect"`. The session has one
   * recovery edge, its ready boundary, and each one follows a new attach:
   * the host may have restarted since the last one, so no read that settled
   * before it can be vouched for. The session contract in `protocol/` stays
   * kind-free, because with one edge a kind there would always read the
   * same.
   */
  subscribeAvailabilityRecovered(
    listener: (kind: AvailabilityRecoveryKind) => void,
  ): () => void {
    return this.trackSubscription(() =>
      this.session.subscribeAvailabilityRecovered(() => {
        if (!this.isClosed()) listener("reconnect");
      }),
    );
  }

  getMethodSupport<Method extends keyof StreamRegistry & string>(
    method: Method,
  ): StreamMethodSupport {
    return this.isClosed() ? "unknown" : this.session.getMethodSupport(method);
  }

  subscribeMethodSupport(listener: () => void): () => void {
    return this.trackSubscription(() =>
      this.session.subscribeMethodSupport(() => {
        // The shared session retracts its manifest after marking itself
        // closed, before onClosed retires our observers. Deliver that final
        // "unknown" while this client still owns the subscription.
        if (!this.closed) listener();
      }),
    );
  }

  getMethodSchemaVersion<Method extends keyof StreamRegistry & string>(
    method: Method,
  ): SchemaVersion | null {
    return this.isClosed() ? null : this.session.getMethodSchemaVersion(method);
  }
}
