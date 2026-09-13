/**
 * The catalogue the onboarding flow runs over: which tours exist, the steps
 * each one has, and the order a branch plays them in.
 *
 * Data only. The flow store (`onboarding-flow-store.ts`) reads these arrays
 * to activate, advance and finish tours; the tour host and Settings ▸
 * Onboarding read them to render. Nothing here knows about a DOM target or a
 * route — a tour's steps are ids, and what a step points at is the tour
 * host's business.
 */

/** The five spotlight tours, each replayable from Settings ▸ Onboarding. */
export type TourId =
  | "add-folder"
  | "terminal-mode"
  | "submit-prompt"
  | "task-panels"
  | "history";

/**
 * Every lesson card on Settings ▸ Onboarding: the five tours plus the four
 * that are a demo, an editor or a dialog rather than a tour, and so carry no
 * progress.
 */
export type LessonId =
  | TourId
  | "split-screen"
  | "task-tabs"
  | "agent-guide"
  | "login-import";

/**
 * Which chain the welcome modal hands a user into: one for someone with
 * nothing to bring over, one for someone whose sessions were just imported.
 */
export type OnboardingBranch = "no-sessions" | "sessions";

export const TOUR_IDS: ReadonlyArray<TourId> = [
  "add-folder",
  "terminal-mode",
  "submit-prompt",
  "task-panels",
  "history",
];

export const LESSON_IDS: ReadonlyArray<LessonId> = [
  ...TOUR_IDS,
  "split-screen",
  "task-tabs",
  "agent-guide",
  "login-import",
];

/**
 * One step per tour today, so `stepId === tourId`. The tour ticket may add
 * steps; the store only reads these arrays, so a tour that grows keeps its
 * persisted progress meaningful (an unknown step id falls back to the first).
 */
export const TOUR_STEP_IDS: Readonly<
  Record<TourId, readonly [string, ...string[]]>
> = {
  "add-folder": ["add-folder"],
  "terminal-mode": ["terminal-mode"],
  "submit-prompt": ["submit-prompt"],
  "task-panels": ["task-panels"],
  history: ["history"],
};

/**
 * The tours each branch plays, in order. Both end on `task-panels`: it is the
 * one tour every user should see, and the one a detour (a user who reaches
 * the panels before the chain does) jumps to.
 */
export const BRANCH_TOUR_ORDER: Readonly<
  Record<OnboardingBranch, ReadonlyArray<TourId>>
> = {
  "no-sessions": ["add-folder", "terminal-mode", "submit-prompt", "task-panels"],
  sessions: ["history", "task-panels"],
};

export function isTourId(value: string): value is TourId {
  return TOUR_IDS.some((id) => id === value);
}

export function firstStepOf(tour: TourId): string {
  return TOUR_STEP_IDS[tour][0];
}

/**
 * The step after `step` in `tour`, or `null` when `step` is the last one —
 * or not one of the tour's steps at all, which the caller treats the same
 * way: there is nowhere further to go, so the tour finishes.
 */
export function nextStepOf(tour: TourId, step: string | null): string | null {
  const steps = TOUR_STEP_IDS[tour];
  const index = step === null ? 0 : steps.indexOf(step);
  if (index < 0 || index + 1 >= steps.length) return null;
  return steps[index + 1];
}
