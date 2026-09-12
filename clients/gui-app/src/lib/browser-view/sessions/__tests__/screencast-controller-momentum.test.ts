import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  mountController,
  pointerFrames,
  type MountedController,
  type PointerFrame,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

/** One rAF tick at 60Hz, the momentum loop's own gate (`MOMENTUM_MIN_TICK_MS`). */
const TICK_MS = 1_000 / 30 + 1;
const POINTER_ID = 20;

function touchInit(
  point: { readonly clientX: number; readonly clientY: number },
  buttons: number,
): Record<string, unknown> {
  return {
    pointerId: POINTER_ID,
    pointerType: "touch",
    clientX: point.clientX,
    clientY: point.clientY,
    button: 0,
    buttons,
    detail: 0,
  };
}

/**
 * The `pointer` frame kind is one flat shape carrying every type ("down" /
 * "up" / "move" / "wheel") rather than a nested discriminated union, so it is
 * filtered by `kind` (`pointerFrames`, from the harness) and then by `.type`
 * at runtime - a compound `Extract<..., {kind:"pointer",type:"wheel"}>` does
 * not narrow anything here and silently degrades to `never`.
 */
function wheelFrames(
  sent: readonly BrowserScreencastClientFrame[],
): PointerFrame[] {
  return pointerFrames(sent).filter((frame) => frame.type === "wheel");
}

/**
 * A controllable stand-in for the browser's animation clock. `runFrame`
 * advances the clock and then runs whatever was scheduled as of the call -
 * mirroring a real frame, where a callback registered DURING it (the
 * momentum loop rescheduling itself, the wheel coalescer flushing) runs on
 * the next tick, not this one. `wait` moves the clock with no frame at all -
 * a parked finger, or the gap between two DOM events this suite fires by
 * hand.
 */
function installFakeAnimationClock(): {
  readonly wait: (deltaMs: number) => void;
  readonly runFrame: (deltaMs: number) => void;
  readonly pendingCount: () => number;
} {
  let time = 0;
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    callbacks.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  return {
    wait: (deltaMs) => {
      time += deltaMs;
    },
    runFrame: (deltaMs) => {
      time += deltaMs;
      const due = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of due) callback(time);
    },
    pendingCount: () => callbacks.size,
  };
}

function readyMounted(): MountedController {
  const mounted = mountController();
  mounted.controller.notePresentedSequence(7);
  return mounted;
}

function armViaTouchDown(
  mounted: MountedController,
  point: { readonly clientX: number; readonly clientY: number },
): void {
  fireEvent.pointerDown(mounted.overlay, touchInit(point, 1));
  const armFrame = mounted.sent.find((frame) => frame.kind === "arm");
  if (armFrame === undefined) {
    throw new Error("expected an arm request from the touch down");
  }
  mounted.controller.noteArmed(armFrame.armEpoch);
}

describe("screencast controller momentum scroll (D15)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("decays each emitted wheel tick to about 0.9x the last one after a fast flick", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(50);
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 1),
    );
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 0),
    );

    const baseline = wheelFrames(mounted.sent).length;
    for (let tick = 0; tick < 8; tick += 1) clock.runFrame(TICK_MS);

    const ticks = wheelFrames(mounted.sent).slice(baseline);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i += 1) {
      const ratio = Math.abs(ticks[i].deltaY) / Math.abs(ticks[i - 1].deltaY);
      expect(ratio).toBeCloseTo(0.9, 1);
    }
  });

  it("emits at most 30 ticks per simulated second at 60Hz", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(50);
    // A strong flick, so decay alone does not stop the coast inside 1s.
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 50 }, 1),
    );
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 50 }, 0),
    );

    const baseline = wheelFrames(mounted.sent).length;
    const SIXTY_HZ_MS = 1_000 / 60;
    for (let frame = 0; frame < 60; frame += 1) clock.runFrame(SIXTY_HZ_MS);

    const emitted = wheelFrames(mounted.sent).length - baseline;
    expect(emitted).toBeLessThanOrEqual(30);
    expect(emitted).toBeGreaterThan(0);
  });

  it("stops coasting once the decayed speed drops below 20px/s", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(50);
    // velocityY = -210px/s over the flick's last segment - just past the
    // 200px/s start threshold, so it takes the fewest ticks to decay under
    // the 20px/s stop threshold.
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 300 - 10.5 }, 1),
    );
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 300 - 10.5 }, 0),
    );

    for (let tick = 0; tick < 60; tick += 1) clock.runFrame(TICK_MS);

    // Momentum has torn down its own loop - nothing left scheduled.
    expect(clock.pendingCount()).toBe(0);
    const settled = wheelFrames(mounted.sent).length;
    clock.runFrame(TICK_MS);
    clock.runFrame(TICK_MS);
    expect(wheelFrames(mounted.sent).length).toBe(settled);
  });

  it("stops the coast on the same tick a new pointer comes down", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(50);
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 1),
    );
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 0),
    );
    clock.runFrame(TICK_MS);
    expect(clock.pendingCount()).toBeGreaterThan(0);

    // Stops the momentum LOOP immediately - it schedules no further tick of
    // its own past this point. One coalesced wheel frame already queued for
    // the next paint (by the tick that just ran) is a separate rAF
    // registration the coalescer owns, so it still lands; nothing beyond it
    // ever does.
    fireEvent.pointerDown(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 1),
    );
    clock.runFrame(TICK_MS);
    expect(clock.pendingCount()).toBe(0);

    const settled = wheelFrames(mounted.sent).length;
    clock.runFrame(TICK_MS);
    clock.runFrame(TICK_MS);
    expect(wheelFrames(mounted.sent).length).toBe(settled);
  });

  it("emits nothing after a slow drag's release", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(100);
    // 15px clears the 8px scroll slop (so this is a drag, not a tap), at
    // velocityY = -150px/s - below the 200px/s momentum start threshold.
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 285 }, 1),
    );
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 285 }, 0),
    );

    const settled = wheelFrames(mounted.sent).length;
    clock.runFrame(TICK_MS);
    clock.runFrame(TICK_MS);
    expect(wheelFrames(mounted.sent).length).toBe(settled);
    expect(clock.pendingCount()).toBe(0);
  });

  it("emits nothing when the finger was parked for over 100ms before lifting", () => {
    const clock = installFakeAnimationClock();
    const mounted = readyMounted();
    armViaTouchDown(mounted, { clientX: 400, clientY: 300 });
    clock.wait(50);
    // A fast segment, which alone would start a coast...
    fireEvent.pointerMove(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 1),
    );
    // ...but the finger then rests before lifting, well past the 100ms
    // freshness window the release checks.
    clock.wait(150);
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 200 }, 0),
    );

    expect(clock.pendingCount()).toBe(0);
    const settled = wheelFrames(mounted.sent).length;
    clock.runFrame(TICK_MS);
    clock.runFrame(TICK_MS);
    expect(wheelFrames(mounted.sent).length).toBe(settled);
  });
});
