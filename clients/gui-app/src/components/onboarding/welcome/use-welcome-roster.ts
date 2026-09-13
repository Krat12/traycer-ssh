import { useMutationState, type UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderCliState,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providersMutationKeys } from "@/lib/query-keys";

export interface WelcomeRoster {
  readonly query: UseQueryResult<ProvidersListResponse, HostRpcError>;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  /** A `providers.setEnabled` is in flight somewhere in the app. */
  readonly toggling: boolean;
  /**
   * A toggle succeeded after the roster was last read successfully, so the
   * roster on hand is the one from BEFORE it. Cleared only by a successful
   * read that lands after the toggle - a refresh that fails keeps the stale
   * data and leaves this set.
   */
  readonly refreshRequired: boolean;
  /**
   * Whether the roster may be acted on: resolved, not mid-refresh, not in
   * error, and every toggle since the last good read refreshed into it.
   */
  readonly settled: boolean;
}

/**
 * Page 1's roster, with the one fact `providers.list` alone cannot answer:
 * whether it is CURRENT with respect to the toggles the page sends.
 *
 * `useHostScopedMutation` fires the list invalidation inside `onSuccess`
 * without awaiting it, and a refetch can fail: TanStack then keeps the old
 * data, drops `isFetching`, and the query reads as resolved - with the
 * roster from before the toggle. The Continue branch reads that roster, so
 * "enable Claude, refresh fails, Continue" would finish the modal as
 * `no-sessions` for a user who had just turned Claude on.
 *
 * So the requirement is derived, not remembered: the mutation cache says
 * when each `setEnabled` was submitted and whether it succeeded, and the
 * query says when it last read successfully. A successful read stamped
 * after the newest successful toggle is the only thing that satisfies it -
 * read off the cache rather than kept in component state so the modal and
 * the page, which both gate on it, cannot disagree, and so a toggle from
 * any surface counts.
 */
export function useWelcomeRoster(): WelcomeRoster {
  // App-wide host on purpose: this is an app-wide surface, not a composer.
  const query = useProvidersList({ enabled: true, subscribed: true });
  const toggles = useMutationState({
    filters: { mutationKey: providersMutationKeys.setEnabled() },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
    }),
  });
  let toggling = false;
  let newestSuccessfulToggleAt = 0;
  for (const toggle of toggles) {
    if (toggle.status === "pending") toggling = true;
    if (toggle.status === "success") {
      newestSuccessfulToggleAt = Math.max(
        newestSuccessfulToggleAt,
        toggle.submittedAt,
      );
    }
  }
  const providers = query.data?.providers;
  const refreshRequired =
    newestSuccessfulToggleAt > 0 &&
    query.dataUpdatedAt <= newestSuccessfulToggleAt;
  const settled =
    providers !== undefined &&
    !toggling &&
    !query.isFetching &&
    !query.isError &&
    !refreshRequired;
  return { query, providers, toggling, refreshRequired, settled };
}
