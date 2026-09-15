import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { AvailabilityRecoveryKind } from "@traycer-clients/shared/host-transport/availability-recovery-kind";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { subscribeStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
import {
  AVAILABILITY_RECOVERY_COOLDOWN_MS,
  wireAvailabilityRecovery,
} from "@/lib/host/availability-recovery";
import { appLogger } from "@/lib/logger";
import {
  remoteAwareOwnerIdentity,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

export interface DurableStreamTransport {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  /**
   * Tears down wake + endpoint-change wiring then the socket. The owning session
   * calls it exactly once - when it disposes, or before rebuilding on `retry()`.
   */
  readonly close: () => void;
}

/** A durable session transport whose owner can attribute its final close. */
export interface AttributableDurableStreamTransport extends DurableStreamTransport {
  /**
   * Same teardown, with a caller-authored diagnostic reason.
   *
   * Kept on the transport rather than achieved by closing `wsStreamClient`
   * directly: wake, endpoint-change and availability wiring must be disposed
   * BEFORE the socket closes, or a close notification can race live reconnect
   * wiring. `close()` is the historical default for owners with no narrower
   * attribution.
   */
  readonly closeWithReason: (reason: string) => void;
}

/**
 * Builds a LONG-LIVED host stream transport for a SESSION STORE to own across
 * its warm lifetime (not a React tile). This is the ONE place "durable stream =
 * transport + auth + wake + endpoint-change re-dial + availability recovery"
 * lives: the chat, terminal, and epic session stores all build their transport
 * here, and the app-wide stream uses the same `buildHostStreamClient` +
 * reconnect primitives - so a new durable consumer cannot wire a subset (auth
 * without wake, or a socket without the endpoint-change re-dial) and silently
 * reintroduce the freeze / slow-wake / stuck-after-restart bugs this replaced.
 *
 *  - `endpoint` is read LIVE on every (re)dial, so a host that respawns on a
 *    new `websocketUrl` while the session is warm (no tile mounted to recompute
 *    a memo) reconnects to the new address instead of retrying the dead one.
 *  - `readTarget` preserves the owner's route and registry identity boundary:
 *    switching relay/SSH or replacing the registered Host closes the former
 *    transport, even without a mounted tile. A later acquire builds its owner
 *    against the new identity. SSH endpoint loss/port moves keep that identity.
 *  - `bearer` + `auth` provide UNAUTHORIZED revalidate+reconnect.
 *  - bearer-rotation forwarding pushes `credentialUpdate` frames to already-open
 *    sessions after same-user token refresh, so long-lived streams do not keep
 *    stale host-side request contexts.
 *  - wake re-dial (`window 'online'` + OS resume) is wired here.
 *  - endpoint-change re-dial: when the bound host moves to a NEW dialable
 *    endpoint while the app is awake (a Settings-page restart / re-provision -
 *    no OS sleep, no network transition), this re-dials IMMEDIATELY instead of
 *    waiting for the dropped socket to be noticed (up to the pong timeout on a
 *    half-open socket). It is the session-transport sibling of the app-wide
 *    `useReconnectStreamOnEndpointChange` nudge, keeping both scopes symmetric.
 *
 * All wiring is torn down by `close()`. If any subscription throws while wiring,
 * every already-registered subscription is disposed and the half-built socket is
 * closed before the error propagates, so a failed build never leaks a socket or
 * listeners. Callers that build a typed stream client (chat/terminal/epic) on
 * top must likewise `close()` this transport if THAT construction throws.
 */
export function openDurableStreamTransport(params: {
  readonly target: HostDirectoryEntry;
  /** Re-read the route and registered incarnation even while no React owner is mounted. */
  readonly readTarget: () => HostDirectoryEntry | null;
  /** The signed-in user this transport is built for (Architecture §4 / S1 cache key). */
  readonly userId: string;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator;
  readonly runnerHost: IRunnerHost;
  /**
   * Subscribes to same-user bearer rotations. The durable transport forwards the
   * event to its owned stream client so open host connections rotate credentials
   * in place via `credentialUpdate`.
   */
  readonly subscribeBearerRotation: (onRotation: () => void) => () => void;
  /**
   * Subscribes to in-place CLOUD-VERDICT changes on the live request context.
   *
   * Separate from `subscribeBearerRotation` because the events are separate:
   * a demotion rotates and withdraws at once, but the promotion back asserts a
   * verdict on a bearer that never moved, so a transport wired only to rotation
   * would stay refused by the host until something unrelated forced a redial.
   */
  readonly subscribeCloudVerdictChange: (onChange: () => void) => () => void;
  /**
   * Subscribes to host-directory changes for the bound host, returning a
   * disposer. The callback fires on ANY directory change; this module filters it
   * down to an owner identity change or a genuine dialable-endpoint move.
   */
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
  /**
   * Called (cooldown-coalesced by this module) when this transport's own
   * heartbeat evidences ITS host recovering - a session re-open after a drop,
   * or a pong after a stall-length gap - with the kind of that edge. The
   * factory routes it to `HostClient.notifyHostAvailabilityRecovered(hostId,
   * kind)` so that host's stranded unary queries refetch. This must live
   * here, not on the app-wide stream: tabs bind a `hostId` for life, so a
   * tab can heartbeat a host that is not the effective one, and only its own
   * transport ever observes that host's recovery. No host argument, because
   * the host is fixed at open time - see {@link NamedHostRecoveryTarget}.
   */
  readonly notifyRecoveredForNamedHost: (
    kind: AvailabilityRecoveryKind,
  ) => void;
}): AttributableDurableStreamTransport {
  const ownerIdentity = remoteAwareOwnerIdentity(params.target, params.userId);
  const identityIsCurrent = (): boolean =>
    remoteAwareOwnerIdentityKey(params.readTarget(), params.userId) ===
    ownerIdentity;
  // A retry must not reopen a transport captured before a route change. The
  // normal factory reads the target live; this guard also covers stale callers
  // before they can acquire a relay session or create any subscriptions.
  if (!identityIsCurrent()) {
    throw new Error(
      `Host ${params.target.hostId} changed identity before its durable stream opened`,
    );
  }
  const wsStreamClient = buildHostStreamClient({
    target: params.target,
    endpoint: params.endpoint,
    bearer: params.bearer,
    cloudAuthorized: () =>
      authorizesCloudCapability(useAuthStore.getState().status),
    authnBaseUrl: params.runnerHost.authnBaseUrl,
    auth: params.auth,
    userId: params.userId,
    // Durable warm session: its streams re-snapshot on replay, so the
    // process-wide sweep may probe or force-drop it freely.
    proactiveWakeEligible: true,
    // Owned-lifetime transport: eager warm-connect is correct here.
    autoStart: true,
  });
  if (wsStreamClient === null) {
    // Only reachable for a remote target whose registry-published public key
    // does not decode (a corrupt row) — genuinely exceptional, unlike the
    // ordinary "no target yet" case callers already gate on before opening.
    throw new Error(
      `Remote host ${params.target.hostId} has an invalid public key; cannot open a durable stream`,
    );
  }
  appLogger.debug("[stream] durable transport opened", {
    hasEndpoint: params.endpoint() !== null,
  });
  const disposers: Array<() => void> = [];
  let closed = false;
  const closeWithReason = (reason: string): void => {
    if (closed) return;
    closed = true;
    // Remove all reconnect sources before notifying the typed session that its
    // socket closed. Warm owners may still hold that session until reacquire.
    disposers.splice(0).forEach((dispose) => dispose());
    wsStreamClient.close(reason);
  };
  const registerDisposer = (dispose: () => void): void => {
    // A source may notify synchronously while being subscribed. If that closes
    // this transport, neither this nor later subscriptions may outlive it.
    if (closed) dispose();
    else disposers.push(dispose);
  };
  try {
    registerDisposer(
      params.subscribeBearerRotation(() => {
        wsStreamClient.notifyBearerRotated();
      }),
    );
    registerDisposer(
      params.subscribeCloudVerdictChange(() => {
        wsStreamClient.notifyCloudVerdictChanged();
      }),
    );
    registerDisposer(
      subscribeStreamWakeReconnect(wsStreamClient, params.runnerHost),
    );
    registerDisposer(
      subscribeEndpointRedial({
        client: wsStreamClient,
        endpoint: params.endpoint,
        subscribeEndpointChange: params.subscribeEndpointChange,
        identityIsCurrent,
        closeObsoleteTransport: () =>
          closeWithReason("durable-host-identity-changed"),
      }),
    );
    registerDisposer(
      wireAvailabilityRecovery({
        wsStreamClient,
        target: {
          notifyRecoveredForNamedHost: params.notifyRecoveredForNamedHost,
        },
        cooldownMs: AVAILABILITY_RECOVERY_COOLDOWN_MS,
        now: () => Date.now(),
      }),
    );
  } catch (cause) {
    appLogger.error("[stream] durable transport wiring failed", {}, cause);
    // Roll back every subscription wired so far, then close the socket, so a
    // throw mid-wiring leaves nothing dangling.
    closeWithReason("durable-transport-wiring-failed");
    throw cause;
  }
  return {
    wsStreamClient,
    close: () => {
      closeWithReason("durable-transport-closed");
    },
    closeWithReason,
  };
}

/**
 * Re-dials the durable transport the instant its bound host gains a NEW dialable
 * endpoint - a host restart / re-provision that moved to a new `websocketUrl`,
 * or a host that just came back `available` - instead of waiting for the dropped
 * socket to notice (up to the pong timeout on a half-open socket). The dropped
 * socket would re-dial the live `endpoint()` on its own eventually; nudging
 * skips that wait so recovery is instant, matching the app-wide stream.
 *
 * A different owner identity retires this transport instead of re-dialing it.
 * For the same owner, re-dial only fires when the dialable `websocketUrl`
 * MOVES to a new non-null value, so benign directory re-emits (every
 * `onLocalHostChange` rebuilds the entry, and on desktop it crosses the IPC
 * bridge as a fresh object) do NOT churn the socket. A move to `null` (host went
 * away) is recorded but not nudged - the next non-null move fires it.
 */
function subscribeEndpointRedial(params: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly endpoint: HostEndpointProvider;
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
  readonly identityIsCurrent: () => boolean;
  readonly closeObsoleteTransport: () => void;
}): () => void {
  let lastWebsocketUrl = params.endpoint()?.websocketUrl ?? null;
  return params.subscribeEndpointChange(() => {
    // Endpoint redial cannot turn a RemoteStreamClient into a direct SSH
    // client. Retire the old owner even when the selected route has no URL;
    // existing session acquisition replaces it using the new owner identity.
    if (!params.identityIsCurrent()) {
      params.closeObsoleteTransport();
      return;
    }
    const nextWebsocketUrl = params.endpoint()?.websocketUrl ?? null;
    if (nextWebsocketUrl === lastWebsocketUrl) {
      return;
    }
    lastWebsocketUrl = nextWebsocketUrl;
    if (nextWebsocketUrl !== null) {
      appLogger.debug("[stream] durable endpoint changed - reconnecting", {});
      // The host moved to a new address: the current socket points somewhere
      // that no longer serves this host, so it must be dropped whether or not
      // it still answers. Not a wake - no probe.
      params.client.reconnectAll("host-endpoint-change", {
        probeFirst: false,
        wakeProbe: null,
      });
    }
  });
}
