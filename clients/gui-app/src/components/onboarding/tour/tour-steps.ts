import type { Placement, Step } from "react-joyride";
import {
  TOUR_COPY,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import type { TourAnchor } from "@/components/onboarding/tour/tour-targets";

/**
 * The five lessons as Joyride sees them: the instruction on the card, its
 * placement and which anchor. Titles, progress, order and ids come from the
 * shared catalogue (`onboarding-tour-catalog.ts` - `TOUR_COPY` names each
 * tour once, for the card and Settings alike); nothing here is a second
 * copy of those.
 */

/** Spotlight geometry, in pixels (Joyride takes numbers, not tokens). */
export const TOUR_SPOTLIGHT_PADDING_PX = 8;
export const TOUR_SPOTLIGHT_RADIUS_PX = 8;
/** Overlay 45 / card 46: above the app, below every `z-50` Dialog. */
export const TOUR_Z_INDEX = 45;
/** How long a lesson waits for its anchor before the unanchored card. */
export const TOUR_TARGET_WAIT_TIMEOUT_MS = 8000;
export const TOUR_SCROLL_DURATION_MS = 300;

export interface TourLesson {
  /** What the card asks the user to do (the catalogue owns the title). */
  readonly body: string;
  readonly placement: Placement;
  readonly anchor: TourAnchor;
}

export const TOUR_LESSONS: Readonly<Record<TourId, TourLesson>> = {
  "add-folder": {
    body: "Choose a folder so your agent can work with your code.",
    placement: "bottom",
    anchor: "landing-folder-add",
  },
  "terminal-mode": {
    body: "Switch to Terminal to work with your coding agent in a terminal.",
    placement: "top",
    anchor: "landing-terminal-switch",
  },
  "submit-prompt": {
    body: "Switch back to Chat, describe what you want to build, and send it.",
    placement: "top",
    anchor: "landing-send",
  },
  "task-panels": {
    body: "Use these panels to move between agents, files, and tools.",
    placement: "right",
    anchor: "epic-sidebar-column",
  },
  history: {
    body: "Your imported sessions are here. Open a task to keep going.",
    placement: "top",
    anchor: "landing-history",
  },
};

export function tourLessonTitle(tourId: TourId): string {
  return TOUR_COPY[tourId].title;
}

/**
 * How the active lesson is being shown. `anchored` spotlights a resolved
 * node (and may scroll to a row inside it); `unanchored` is the same lesson
 * as a centred card with no cutout - the target is missing, timed out or
 * detached, and the user still gets Next / Skip / pause (never a trap).
 */
export type StepPresentation =
  | {
      readonly kind: "anchored";
      readonly target: () => HTMLElement | null;
      readonly scrollTarget: (() => HTMLElement | null) | null;
    }
  | { readonly kind: "unanchored" };

function documentBody(): HTMLElement {
  return document.body;
}

/**
 * One Joyride step per tour in `order`, so the controlled `stepIndex` is the
 * active tour's position and Joyride's own `isLastStep` / step count read
 * true for the chain (a Settings replay is a one-tour order). Only the
 * active tour gets a real presentation; the others are placeholders that
 * validate but are never shown.
 */
export function buildTourSteps(
  order: ReadonlyArray<TourId>,
  activeTourId: TourId,
  presentation: StepPresentation,
): Step[] {
  return order.map((tourId) => {
    const lesson = TOUR_LESSONS[tourId];
    const base = {
      id: tourId,
      title: tourLessonTitle(tourId),
      content: lesson.body,
    };
    if (tourId !== activeTourId || presentation.kind === "unanchored") {
      return {
        ...base,
        target: documentBody,
        placement: "center",
        hideOverlay: true,
        skipScroll: true,
      };
    }
    return {
      ...base,
      target: presentation.target,
      ...(presentation.scrollTarget === null
        ? {}
        : { scrollTarget: presentation.scrollTarget }),
      placement: lesson.placement,
    };
  });
}
