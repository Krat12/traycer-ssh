import {
  useMutationState,
  type FetchStatus,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderCliState,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providersMutationKeys } from "@/lib/query-keys";
import {
  selectWelcomeRosterFreshness,
  useWelcomeRosterFreshnessStore,
} from "@/stores/onboarding/welcome-roster-freshness-store";

export interface WelcomeRoster {
  readonly query: UseQueryResult<ProvidersListResponse, HostRpcError>;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  /** A `providers.setEnabled` for this host is in flight. */
  readonly toggling: boolean;
  /**
   * A toggle on this host succeeded and no fetch of the roster that started
   * AFTER it has completed successfully yet, so the roster on hand may be
   * the one from before the toggle. A refresh that failed, was paused, or
   * had started before the toggle leaves this set.
   */
  readonly refreshRequired: boolean;
  /**
   * Whether the roster may be acted on: resolved, not mid-fetch, not in
   * error, and every toggle on this host receipted by a later fetch.
   */
  readonly settled: boolean;
}

/**
 * Page 1's roster, with the one fact `providers.list` alone cannot answer:
 * whether it is CURRENT with respect to the toggles sent to its host.
 *
 * `useHostScopedMutation` fires the list invalidation inside `onSuccess`
 * without awaiting it, and a refetch can fail: TanStack then keeps the old
 * data, drops `isFetching`, and the query reads as resolved - with the
 * roster from before the toggle. The Continue branch reads that roster, so
 * "enable Claude, refresh fails, Continue" would finish the modal as
 * `no-sessions` for a user who had just turned Claude on.
 *
 * The requirement is a RECEIPT, not a clock. The mutation cache gives the
 * generation - how many `setEnabled` calls aimed at this host have
 * succeeded - and this hook watches the list query's fetch cycle: a fetch
 * that starts is stamped with the generation at that moment, and only a
 * fetch that completes successfully credits the generation it started
 * under. A toggle on ANOTHER host is not this roster's business (its list is
 * a different query, never invalidated by that toggle), and no wall-clock
 * ordering is involved, so a clock step cannot strand it and a read that
 * began before the write cannot satisfy it.
 *
 * One consequence needs its own step. The refetch a toggle's success
 * invalidates into starts BEFORE the mutation reports success (the
 * invalidation runs inside its `onSuccess`, the status flips after), so by
 * the rule above it is stamped with the previous generation and cannot be
 * the receipt. Rather than adopt it on an ordering argument, the hook asks
 * for one more fetch once that refetch has landed - an extra
 * `providers.list` per toggle, against a machine that just answered one.
 *
 * Receipts live in a per-host store (`welcome-roster-freshness-store`) so
 * the modal and its page, both calling this hook, read one answer.
 */
export function useWelcomeRoster(): WelcomeRoster {
  // The host the list query below is keyed on - the same resolver
  // `useHostQuery` reads, and the same client the toggle captures its
  // `hostId` from.
  const hostId = useAddressableHostId();
  // App-wide host on purpose: this is an app-wide surface, not a composer.
  const query = useProvidersList({ enabled: true, subscribed: true });
  const toggles = useMutationState({
    filters: { mutationKey: providersMutationKeys.setEnabled() },
    select: (mutation) => ({
      status: mutation.state.status,
      hostId: contextHostId(mutation.state.context),
    }),
  });
  let toggling = false;
  let generation = 0;
  for (const toggle of toggles) {
    if (hostId === null || toggle.hostId !== hostId) continue;
    if (toggle.status === "pending") toggling = true;
    if (toggle.status === "success") generation += 1;
  }

  const freshness = useWelcomeRosterFreshnessStore((state) =>
    selectWelcomeRosterFreshness(state, hostId),
  );
  const recordFetchStart = useWelcomeRosterFreshnessStore(
    (state) => state.recordFetchStart,
  );
  const recordFetchSuccess = useWelcomeRosterFreshnessStore(
    (state) => state.recordFetchSuccess,
  );
  const recordNudge = useWelcomeRosterFreshnessStore(
    (state) => state.recordNudge,
  );

  // The fetch cycle, observed as transitions of the query's own status: a
  // start is `→ fetching`, a receipt is `fetching → idle` with data. `paused`
  // is neither - an offline refetch has not read anything.
  const { fetchStatus, status, refetch } = query;
  const previousFetchStatusRef = useRef<FetchStatus>("idle");
  useEffect(() => {
    const previous = previousFetchStatusRef.current;
    previousFetchStatusRef.current = fetchStatus;
    if (hostId === null) return;
    if (previous !== "fetching" && fetchStatus === "fetching") {
      recordFetchStart(hostId, generation);
    }
    if (
      previous === "fetching" &&
      fetchStatus === "idle" &&
      status === "success"
    ) {
      recordFetchSuccess(hostId);
    }
  }, [
    hostId,
    fetchStatus,
    status,
    generation,
    recordFetchStart,
    recordFetchSuccess,
  ]);

  const refreshRequired = generation > freshness.satisfied;

  // The one fetch the hook asks for itself (see above): only once per
  // generation, only when nothing is in flight, and never over an error -
  // there the page's Retry is the next move, not a silent loop.
  useEffect(() => {
    if (hostId === null || !refreshRequired) return;
    if (fetchStatus !== "idle" || status === "error") return;
    // Read LIVE, not from this render's snapshot: the modal and its page
    // run this effect in the same commit, and a snapshot would let the
    // second instance ask again for a fetch the first just asked for.
    const live = selectWelcomeRosterFreshness(
      useWelcomeRosterFreshnessStore.getState(),
      hostId,
    );
    if (live.fetchStartedAt >= generation) return;
    if (live.nudgedFor >= generation) return;
    recordNudge(hostId, generation);
    void refetch();
  }, [
    hostId,
    refreshRequired,
    fetchStatus,
    status,
    generation,
    freshness.fetchStartedAt,
    freshness.nudgedFor,
    recordNudge,
    refetch,
  ]);

  const providers = query.data?.providers;
  const settled =
    providers !== undefined &&
    !toggling &&
    !query.isFetching &&
    !query.isError &&
    !refreshRequired;
  return { query, providers, toggling, refreshRequired, settled };
}

/**
 * The host a `useHostScopedMutation` captured at `onMutate` - its context is
 * `{ hostId, captured }` - read without trusting the shape: a mutation that
 * carries none names no host and counts for no roster.
 */
function contextHostId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  if (!("hostId" in context)) return null;
  const { hostId } = context;
  return typeof hostId === "string" ? hostId : null;
}
