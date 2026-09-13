import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  makeTestEpic,
  type OfficeTestEpic,
} from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_TILE,
  type OfficeSeat,
  type OfficeSize,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeDeskState, OfficePlanInput } from "../office-view";
import { planFloor } from "../floor/floor-plan";
import { floorPainter } from "../floor/floor-painter";

const VIEWPORT: OfficeSize = { width: 1280, height: 700 };

function populationFor(epic: OfficeTestEpic): OfficePopulation {
  return partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
}

function planInputFor(epic: OfficeTestEpic): OfficePlanInput {
  return {
    agents: epic.agents,
    partition: populationFor(epic),
    occupancy: new Map(),
    needsCapacity: [],
    activityById: new Map(epic.agents.map((agent) => [agent.id, 0])),
    viewport: VIEWPORT,
    previous: null,
  };
}

function idleDeskState(agentId: string | null): OfficeDeskState {
  return {
    agentId,
    name: agentId,
    accentId: null,
    status: "idle",
    sheeted: false,
    openRequests: 0,
    screenFrame: 0,
    harnessId: null,
    modelTier: "medium",
  };
}

function spriteNames(
  drawables: ReturnType<typeof floorPainter.seatProps>,
): ReadonlyArray<string> {
  return drawables
    .filter((item) => item.drawable.kind === "sprite")
    .map((item) =>
      item.drawable.kind === "sprite" ? item.drawable.sprite.name : "",
    );
}

/**
 * A big enough triage epic that `planFloor` (`layoutOffice`) packs civic rooms
 * on the first floor: the infirmary's beds and the lounge's chairs. Plan-time
 * geometry does not depend on statuses - civic rooms are furniture the packer
 * lays out for any large enough population - so this is only about having
 * ENOUGH agents, not about which ones are `failure` or `awaiting`.
 */
const CIVIC_EPIC = makeTestEpic("triage", 309, 1);

function seatOfKind(kind: OfficeSeat["kind"]): OfficeSeat {
  const layout = planFloor(planInputFor(CIVIC_EPIC));
  const seat = [...layout.seats.values()].find(
    (candidate) => candidate.kind === kind,
  );
  if (seat === undefined) throw new Error(`expected a ${kind} seat`);
  return seat;
}

describe("floorPainter.seatProps: civic seats", () => {
  it("draws a bed's turned-down sheet only when the ward's per-seat state carries an owner", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const bed = seatOfKind("bed");

    const empty = idleDeskState(null);
    const emptySprites = spriteNames(
      floorPainter.seatProps(layout, bed, empty, 2),
    );
    expect(emptySprites).toEqual(["bed"]);

    // The claim under test: `bed-occupied` rides the per-seat state's
    // `agentId`, not the seat's own geometry - the same bed, same layout,
    // draws the extra sheet sprite the instant an owner shows up in state.
    const occupied = idleDeskState("agent-in-ward");
    const occupiedSprites = spriteNames(
      floorPainter.seatProps(layout, bed, occupied, 2),
    );
    expect(occupiedSprites).toEqual(["bed", "bed-occupied"]);
  });

  it("draws a lounge chair with no occupied variant, unlike a bed - a chair reads as taken from the agent sitting in it", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const lounge = seatOfKind("lounge");

    const empty = idleDeskState(null);
    const occupied = idleDeskState("agent-in-lounge");

    // There is deliberately no `lounge-chair-occupied` sprite in the
    // contract: a bed needs the sheet because at this scale the bed itself
    // gives no cue that anyone is in it, while a seated agent's own sprite is
    // the lounge chair's cue. Asserting only the base sprite would miss the
    // asymmetry this case exists to pin.
    expect(
      spriteNames(floorPainter.seatProps(layout, lounge, empty, 2)),
    ).toEqual(["lounge-chair"]);
    expect(
      spriteNames(floorPainter.seatProps(layout, lounge, occupied, 2)),
    ).toEqual(["lounge-chair"]);
  });

  it("keeps painting a crashed screen on a desk whose owner has walked off to the infirmary (the painter half of the vanishing-desk fix; F19, occupantToPaint)", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const desk = [...layout.seats.values()].find(
      (candidate) => candidate.kind === "desk",
    );
    if (desk === undefined) throw new Error("expected a desk seat");

    // `small`, not `medium`: the medium tier's crash offset happens to equal
    // its normal offset, which would let a broken offset swap through
    // unnoticed. `small`'s crash offset (3, -8) differs from its normal
    // screen offset (5, -5) in both axes, so the assertion below actually
    // exercises the swap.
    // The owner comes from the STATE, not the seat: an `OfficeSeat` is
    // geometry and carries no `agentId` at all. That is the whole point of the
    // fix this case guards - who is at a desk is a per-frame fact the desk
    // state carries, which is why `occupantToPaint` can keep answering for an
    // agent that has walked away.
    const state: OfficeDeskState = {
      ...idleDeskState("agent-at-crashed-desk"),
      status: "failure",
      modelTier: "small",
    };
    const drawables = floorPainter.seatProps(layout, desk, state, 2);
    expect(spriteNames(drawables)).toEqual(
      expect.arrayContaining(["desk", "monitor-crash"]),
    );

    const deskX = desk.deskTile.col * OFFICE_TILE;
    const deskY = desk.deskTile.row * OFFICE_TILE;
    const monitor = drawables.find(
      (item) =>
        item.drawable.kind === "sprite" &&
        item.drawable.sprite.name === "monitor-crash",
    );
    if (monitor?.drawable.kind !== "sprite") {
      throw new Error("expected a monitor-crash sprite");
    }
    // The crashed branch uses `crashXOffset`/`crashYOffset`, not the normal
    // screen offset - that swap is what keeps a crashed screen legible
    // instead of drifting to where a live screen sits.
    expect(monitor.drawable.x).toBe(deskX + 3);
    expect(monitor.drawable.y).toBe(deskY - 8);
  });
});
