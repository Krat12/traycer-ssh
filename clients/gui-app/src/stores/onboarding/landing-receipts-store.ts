import { create } from "zustand";

/**
 * Proof that a LANDING create was accepted by the host, keyed by the attempt
 * that asked for it. The spotlight tour's "submit a prompt" / "start a
 * terminal agent" lessons complete on one of these, never on a tab opening,
 * a focused epic appearing or a create being *sent* - all of which happen
 * for refused, retired and unrelated creates too (contract 5 of the
 * onboarding plan).
 */
export interface LandingReceipt {
  readonly kind: "prompt-accepted" | "tui-accepted";
  readonly attemptId: string;
  /** Null for a terminal launch that had no landing draft behind it. */
  readonly draftId: string | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
}

/**
 * Announced synchronously at dispatch, before any host round trip. The tour
 * controller decides relevance from it (matching draft/host to the active
 * lesson) and records `context.attemptId`; a receipt that later arrives for
 * any other attempt is simply never matched.
 */
export interface LandingAttemptDispatch {
  readonly kind: LandingReceipt["kind"];
  readonly attemptId: string;
  readonly draftId: string | null;
  readonly hostId: string;
}

/**
 * Bound on both maps. A tour waits on exactly one attempt at a time, so this
 * only has to outlast a burst of unrelated creates between dispatch and
 * settlement; older entries are evicted in insertion order.
 */
const MAX_TRACKED_ATTEMPTS = 8;

interface LandingReceiptsState {
  readonly byAttemptId: Readonly<Record<string, LandingReceipt>>;
  readonly dispatchedByAttemptId: Readonly<Record<string, LandingAttemptDispatch>>;
  /** Monotonic; lets a subscriber notice a dispatch without diffing maps. */
  readonly dispatchSequence: number;
  readonly announce: (dispatch: LandingAttemptDispatch) => void;
  /** Idempotent: a second emit for the same attempt keeps the first. */
  readonly emit: (receipt: LandingReceipt) => void;
  /** Take a matched receipt out so it cannot complete a second lesson. */
  readonly consume: (attemptId: string) => LandingReceipt | null;
  /** Identity teardown, chain end, replay: nothing pending survives. */
  readonly reset: () => void;
}

function bounded<T>(
  entries: Readonly<Record<string, T>>,
  key: string,
  value: T,
): Readonly<Record<string, T>> {
  if (key in entries) return entries;
  const next: Record<string, T> = { ...entries, [key]: value };
  const keys = Object.keys(next);
  for (let index = 0; keys.length - index > MAX_TRACKED_ATTEMPTS; index += 1) {
    delete next[keys[index]];
  }
  return next;
}

export const useLandingReceiptsStore = create<LandingReceiptsState>()(
  (set, get) => ({
    byAttemptId: {},
    dispatchedByAttemptId: {},
    dispatchSequence: 0,
    announce: (dispatch) =>
      set((state) => ({
        dispatchedByAttemptId: bounded(
          state.dispatchedByAttemptId,
          dispatch.attemptId,
          dispatch,
        ),
        dispatchSequence: state.dispatchSequence + 1,
      })),
    emit: (receipt) =>
      set((state) => {
        const byAttemptId = bounded(
          state.byAttemptId,
          receipt.attemptId,
          receipt,
        );
        return byAttemptId === state.byAttemptId ? state : { byAttemptId };
      }),
    consume: (attemptId) => {
      const receipt = get().byAttemptId[attemptId];
      if (receipt === undefined) return null;
      set((state) => {
        const { [attemptId]: _consumed, ...rest } = state.byAttemptId;
        const { [attemptId]: _dispatched, ...restDispatched } =
          state.dispatchedByAttemptId;
        return { byAttemptId: rest, dispatchedByAttemptId: restDispatched };
      });
      return receipt;
    },
    reset: () => set({ byAttemptId: {}, dispatchedByAttemptId: {} }),
  }),
);

export function selectLandingReceipt(
  state: LandingReceiptsState,
  attemptId: string | null,
): LandingReceipt | undefined {
  return attemptId === null ? undefined : state.byAttemptId[attemptId];
}
