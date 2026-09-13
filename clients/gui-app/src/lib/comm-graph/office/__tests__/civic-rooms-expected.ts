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
  campus: true,
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
  campus: true,
  city: false,
};

/**
 * WHERE THE AMBULANCE ACTUALLY WAITS FOR ITS RIDER, which is not everywhere.
 *
 * A vehicle dwells at the kerb for at least four seconds, at most twelve, and in
 * between for as long as its rider takes to settle. Which of those three bounds
 * is the one DOING the waiting is a fact about the view's geometry, and in one
 * view it is not the rider.
 *
 * Campus puts the sick bay at the first content column with its kerb on the lane
 * beside its own door, so the walk from a desk to a bed is shorter than the
 * ambulance's own trip: measured, the rider settles at tick 37 and the vehicle
 * reaches the kerb at 57 - twenty ticks after the patient is already in bed - and
 * three ticks from desk to bed in the small fixture. The ambulance then waits the
 * four-second floor and leaves, which meets the contract at both ends. The other
 * three views give the rider bounds of 120, 66 and 83 ticks, where the rider is
 * plainly what sets the dwell.
 *
 * A TABLE RATHER THAN A LOOSENED BOUND, for the reason the other two exist. The
 * guard on those cases is `minimumDwell > 41`, and 41 is exactly what a vehicle
 * that DROPPED its riders is observed at - so relaxing it to admit Campus would
 * admit the implementation the case exists to reject. And the regime may not be
 * read off the measured dwell either: a bug that shortened the wait would flip
 * the case into the other regime and pass. So it is declared here, and both
 * regimes assert their own premise as an observation - see the cases - which
 * makes this table something the scene confirms rather than something a fixture
 * assumes.
 *
 * THE AMBULANCE, AND ONLY THE AMBULANCE - which is why the name says so. Campus
 * is not excused from the rider claim in general: its POLICE CAR has a late rider
 * and pins the wait exactly as the other views do. Measured, by deleting the
 * rider check in `advanceVehicle`: ten cases red, and one of them is Campus's own
 * police-car case. So this table is about one vehicle at one room whose kerb is a
 * step from its door, not about a view that cannot see vehicles waiting. Widen it
 * to another vehicle only with that vehicle's own measurement in hand.
 */
export const AMBULANCE_RIDER_SETS_THE_DWELL: Readonly<
  Record<OfficeViewId, boolean>
> = {
  floor: true,
  towers: true,
  building: true,
  // No road, no vehicle: these cases never run here at all.
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
