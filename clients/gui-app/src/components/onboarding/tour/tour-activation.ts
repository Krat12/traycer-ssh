import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { useOnboardingFlowStore } from "@/stores/onboarding/onboarding-flow-store";

/**
 * The tour's ACTIVATION TOKEN: a counter that moves, synchronously with the
 * store write, whenever the thing the tour is doing changes identity - the
 * chain starts, pauses, ends or is replayed (a replay of the very same tour
 * included: it resets the context), or the signed-in identity changes.
 *
 * Everything that closes over "the current attempt" checks it: a Joyride
 * callback from before a replay, a receipt for an attempt announced under
 * the previous activation, an entry baseline taken for the previous one.
 * DOM epochs and lesson ids cannot do this job - a same-tour replay keeps
 * both - and an effect would be one render late, which is exactly the gap
 * an old callback lands in. Pending receipts are dropped on every move for
 * the same reason.
 *
 * A singleton: there is one tour host per window, and the card needs to
 * read the token without a hook of its own (`focus intent` below).
 */

let token = 0;
const listeners = new Set<() => void>();
let watchers = 0;
let stopWatching: (() => void) | null = null;

function bump(): void {
  token += 1;
  useLandingReceiptsStore.getState().reset();
  for (const listener of listeners) listener();
}

export function getActivationToken(): number {
  return token;
}

export function subscribeActivation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Watch the flow and auth stores; returns stop. Reference-counted. */
export function startActivationWatch(): () => void {
  watchers += 1;
  if (stopWatching === null) {
    const unsubscribeFlow = useOnboardingFlowStore.subscribe((next, previous) => {
      if (
        next.chain !== previous.chain ||
        next.chainScope !== previous.chainScope ||
        (previous.context !== null && next.context === null)
      ) {
        bump();
      }
    });
    const unsubscribeAuth = useAuthStore.subscribe((next, previous) => {
      if (next.status !== previous.status) bump();
    });
    stopWatching = () => {
      unsubscribeFlow();
      unsubscribeAuth();
    };
  }
  return () => {
    watchers -= 1;
    if (watchers === 0 && stopWatching !== null) {
      stopWatching();
      stopWatching = null;
    }
  };
}

/** Tests only: a fresh token, no listeners disturbed. */
export function resetActivationForTests(): void {
  token += 1;
  armedFor = null;
}

// ── Focus intent ────────────────────────────────────────────────────────────
// Keyboard Next moves focus into the NEXT card, and only that one: the
// intent is armed against the current activation, and the next card that
// mounts consumes it only if the activation is still the same. A final
// Finish never arms it, so a later replay does not steal focus.

let armedFor: number | null = null;

export function armFocusNextCard(): void {
  armedFor = token;
}

export function consumeFocusNextCard(): boolean {
  const hit = armedFor === token;
  armedFor = null;
  return hit;
}
