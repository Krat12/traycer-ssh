/**
 * WHICH VIEWS PLAN CIVIC ROOMS, and the flip is the whole interface.
 *
 * K1 gives the rooms to the Floor alone; K2 turns each of the others on as it
 * builds them. A view that is `false` here is asserted to plan NO civic rooms
 * and NO road, which is what makes the table the only way in: a view that grew
 * rooms without being enrolled reddens rather than quietly shipping half a
 * layer, and enrolling one is a one-line edit rather than a case rewrite.
 *
 * ONE TABLE, not one per suite. Both the plan cases and the scene cases gate on
 * it, and two copies would be two things to flip - a view enrolled in the plans
 * but not the scene would grow rooms nobody walks to, and every civic scene
 * case for it would SKIP rather than fail, which is the failure mode that
 * hides. It lives here rather than beside either suite because neither owns it;
 * `counting-array-ctor.ts` is the precedent for a test-support module in this
 * directory.
 */
import type {
  OfficeCivicKind,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";

export const CIVIC_ROOMS_EXPECTED: Readonly<Record<OfficeViewId, boolean>> = {
  floor: true,
  towers: false,
  building: false,
  "mission-control": false,
  campus: false,
  city: false,
};

/** The four rooms every enrolled storey owes, in no particular order. */
export const CIVIC_KINDS: ReadonlyArray<OfficeCivicKind> = [
  "infirmary",
  "waiting-room",
  "help-desk",
  "archive",
];
