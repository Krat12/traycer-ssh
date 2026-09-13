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
  towers: true,
  building: true,
  "mission-control": true,
  campus: false,
  city: false,
};

/**
 * WHICH ENROLLED VIEWS PLAN A STREET, which is not all of them.
 *
 * Four of the five offices are buildings with a way in from outside, and a
 * vehicle pulls up at their kerbs. Mission control is ONE AMPHITHEATRE: nothing
 * drives into a hall, so it plans no road and every one of its four rooms names
 * a null kerb - C6's own reading, and the reason its medbay is marked by a siren
 * light rather than by an ambulance.
 *
 * A SECOND TABLE rather than a tolerated `null`, for the reason the first one
 * exists: a view that lost its road would otherwise pass by having no kerbs to
 * misplace, and the whole point of the tables is that the layer can only be
 * entered, or left, on purpose.
 */
export const CIVIC_ROADS_EXPECTED: Readonly<Record<OfficeViewId, boolean>> = {
  floor: true,
  towers: true,
  building: true,
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
