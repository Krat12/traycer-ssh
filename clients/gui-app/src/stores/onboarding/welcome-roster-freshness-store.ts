import { create } from "zustand";

/**
 * Per-host receipts for the welcome modal's roster (`useWelcomeRoster`):
 * which `providers.setEnabled` GENERATION each host's `providers.list` was
 * last fetched under, and which generation a completed fetch has satisfied.
 *
 * Generations are counts of successful toggles on a host, read off the
 * mutation cache by the hook; nothing here is a timestamp, and the store
 * holds only what the hook's observation of the list query produces - a
 * fetch start (under some generation) and a fetch success (crediting the
 * generation it started under). Kept OUT of the hook instances because two
 * of them are mounted at once (the modal and its page 1) and must read one
 * answer, and so a receipt observed by either counts for both.
 *
 * In memory, never persisted: a receipt is a fact about this window's
 * cache, and a persisted one would outlive the cache it describes.
 */
export interface WelcomeRosterFreshness {
  /** The generation the most recent fetch of this host's list STARTED under. */
  readonly fetchStartedAt: number;
  /** The generation the most recent SUCCESSFUL fetch had started under. */
  readonly satisfied: number;
  /** The generation the hook last asked for a fetch of its own for. */
  readonly nudgedFor: number;
}

const UNTOUCHED: WelcomeRosterFreshness = {
  fetchStartedAt: 0,
  satisfied: 0,
  nudgedFor: 0,
};

export interface WelcomeRosterFreshnessState {
  readonly byHost: Readonly<Record<string, WelcomeRosterFreshness>>;
  readonly recordFetchStart: (hostId: string, generation: number) => void;
  readonly recordFetchSuccess: (hostId: string) => void;
  readonly recordNudge: (hostId: string, generation: number) => void;
  readonly reset: () => void;
}

export const useWelcomeRosterFreshnessStore =
  create<WelcomeRosterFreshnessState>()((set) => ({
    byHost: {},
    recordFetchStart: (hostId, generation) =>
      set((state) => {
        const current = state.byHost[hostId] ?? UNTOUCHED;
        if (current.fetchStartedAt === generation) return state;
        return {
          byHost: {
            ...state.byHost,
            [hostId]: { ...current, fetchStartedAt: generation },
          },
        };
      }),
    recordFetchSuccess: (hostId) =>
      set((state) => {
        const current = state.byHost[hostId] ?? UNTOUCHED;
        // Credits the generation the fetch STARTED under, not the current
        // one: a toggle that succeeded while the fetch was in flight is not
        // reflected in what it read.
        if (current.satisfied === current.fetchStartedAt) return state;
        return {
          byHost: {
            ...state.byHost,
            [hostId]: { ...current, satisfied: current.fetchStartedAt },
          },
        };
      }),
    recordNudge: (hostId, generation) =>
      set((state) => {
        const current = state.byHost[hostId] ?? UNTOUCHED;
        if (current.nudgedFor === generation) return state;
        return {
          byHost: {
            ...state.byHost,
            [hostId]: { ...current, nudgedFor: generation },
          },
        };
      }),
    reset: () => set({ byHost: {} }),
  }));

export function selectWelcomeRosterFreshness(
  state: Pick<WelcomeRosterFreshnessState, "byHost">,
  hostId: string | null,
): WelcomeRosterFreshness {
  if (hostId === null) return UNTOUCHED;
  return state.byHost[hostId] ?? UNTOUCHED;
}
