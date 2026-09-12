import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mountController,
  type MountedController,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

const LONG_PRESS_MS = 500;

function touchInit(
  point: { readonly clientX: number; readonly clientY: number },
  buttons: number,
  pointerId: number,
): Record<string, unknown> {
  return {
    pointerId,
    pointerType: "touch",
    clientX: point.clientX,
    clientY: point.clientY,
    button: 0,
    buttons,
    detail: 0,
  };
}

function touchDown(
  overlay: HTMLElement,
  point: { readonly clientX: number; readonly clientY: number },
  pointerId = 5,
): void {
  fireEvent.pointerDown(overlay, touchInit(point, 1, pointerId));
}

function touchMove(
  overlay: HTMLElement,
  point: { readonly clientX: number; readonly clientY: number },
  pointerId = 5,
): void {
  fireEvent.pointerMove(overlay, touchInit(point, 1, pointerId));
}

function touchUp(
  overlay: HTMLElement,
  point: { readonly clientX: number; readonly clientY: number },
  pointerId = 5,
): void {
  fireEvent.pointerUp(overlay, touchInit(point, 0, pointerId));
}

/** A controller ready to arm the hold: mobile shell + a host that can answer. */
function readyMounted(): MountedController {
  const mounted = mountController();
  mounted.setMobileAppShell(true);
  mounted.setPageSignalsSupported(true);
  mounted.controller.notePresentedSequence(7);
  return mounted;
}

describe("screencast controller long press (D14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the listener after a 500ms hold with no travel", () => {
    const { overlay, longPresses } = readyMounted();
    touchDown(overlay, { clientX: 400, clientY: 300 });

    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(longPresses).toHaveLength(1);
    expect(longPresses[0].castSequence).toBe(7);
    expect(longPresses[0].viewportEpoch).toBeNull();
    expect(longPresses[0].x).toBeCloseTo(0.5);
    expect(longPresses[0].y).toBeCloseTo(0.5);
  });

  it("does not fire when the finger travels past the scroll slop first", () => {
    const { overlay, longPresses } = readyMounted();
    touchDown(overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(200);
    // 15px > the 8px scroll slop.
    touchMove(overlay, { clientX: 415, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(longPresses).toHaveLength(0);
  });

  it("does not fire once released before the hold completes", () => {
    const { overlay, longPresses } = readyMounted();
    touchDown(overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(400);
    touchUp(overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(200);

    expect(longPresses).toHaveLength(0);
  });

  it("cancels the hold when a second pointer comes down", () => {
    const { overlay, longPresses } = readyMounted();
    touchDown(overlay, { clientX: 400, clientY: 300 }, 5);
    vi.advanceTimersByTime(200);
    touchDown(overlay, { clientX: 100, clientY: 100 }, 9);
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(longPresses).toHaveLength(0);
  });

  it("cancels the hold when the capture mode switches mid-hold", () => {
    const { controller, overlay, longPresses } = readyMounted();
    touchDown(overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(200);

    controller.setCaptureMode("video");
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(longPresses).toHaveLength(0);
  });

  it("never arms a timer when the shell is not the mobile app", () => {
    const mounted = mountController();
    mounted.setPageSignalsSupported(true);
    mounted.controller.notePresentedSequence(7);

    touchDown(mounted.overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(mounted.longPresses).toHaveLength(0);
  });

  it("never arms a timer when the host cannot answer a page signal", () => {
    const mounted = mountController();
    mounted.setMobileAppShell(true);
    mounted.controller.notePresentedSequence(7);

    touchDown(mounted.overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(mounted.longPresses).toHaveLength(0);
  });

  it("never arms a timer when neither reader allows it", () => {
    const mounted = mountController();
    mounted.controller.notePresentedSequence(7);

    touchDown(mounted.overlay, { clientX: 400, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(mounted.longPresses).toHaveLength(0);
  });
});
