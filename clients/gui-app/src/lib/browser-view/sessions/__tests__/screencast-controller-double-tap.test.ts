import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  mountController,
  type MountedController,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

type SetZoomFrame = Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "setZoom" }
>;

let nextPointerId = 100;

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

/** A full tap - down then up - on a fresh finger. */
function tap(overlay: HTMLElement, clientX: number, clientY: number): void {
  const pointerId = nextPointerId++;
  fireEvent.pointerDown(overlay, touchInit({ clientX, clientY }, 1, pointerId));
  fireEvent.pointerUp(overlay, touchInit({ clientX, clientY }, 0, pointerId));
}

function zoomFrames(
  sent: readonly BrowserScreencastClientFrame[],
): readonly SetZoomFrame[] {
  return sent.filter(
    (frame): frame is SetZoomFrame => frame.kind === "setZoom",
  );
}

function pointerDownCount(
  sent: readonly BrowserScreencastClientFrame[],
): number {
  return sent.filter(
    (frame) => frame.kind === "pointer" && frame.type === "down",
  ).length;
}

/** A controller with a host that can answer page signals - what double tap needs. */
function ready(): MountedController {
  const mounted = mountController();
  mounted.setPageSignalsSupported(true);
  mounted.controller.notePresentedSequence(7);
  return mounted;
}

/**
 * Arms via the first tap's own gesture (as a real press does), so every tap
 * fired after it is delivered live rather than queued behind the arm.
 */
function armViaFirstTap(
  mounted: MountedController,
  clientX: number,
  clientY: number,
): void {
  const pointerId = nextPointerId++;
  fireEvent.pointerDown(
    mounted.overlay,
    touchInit({ clientX, clientY }, 1, pointerId),
  );
  const armFrame = mounted.sent.find((frame) => frame.kind === "arm");
  if (armFrame === undefined) {
    throw new Error("expected an arm request from the first touch");
  }
  mounted.controller.noteArmed(armFrame.armEpoch);
  fireEvent.pointerUp(
    mounted.overlay,
    touchInit({ clientX, clientY }, 0, pointerId),
  );
}

describe("screencast controller double tap zoom (D15)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("zooms in on two taps inside the window and radius, suppressing only the second click", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 410, 305);

    expect(zoomFrames(mounted.sent)).toEqual([
      { kind: "setZoom", hasBinaryPayload: false, factor: 1.5 },
    ]);
    // Only the first tap's click reached the page.
    expect(pointerDownCount(mounted.sent)).toBe(1);
  });

  it("zooms back out on the following double tap", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 410, 305);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 405, 302);

    expect(zoomFrames(mounted.sent).map((frame) => frame.factor)).toEqual([
      1.5, 1,
    ]);
  });

  it("does not zoom when the taps are more than 300ms apart", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(350);
    tap(mounted.overlay, 405, 302);

    expect(zoomFrames(mounted.sent)).toEqual([]);
    expect(pointerDownCount(mounted.sent)).toBe(2);
  });

  it("does not zoom when the taps are more than 24px apart", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 440, 300);

    expect(zoomFrames(mounted.sent)).toEqual([]);
    expect(pointerDownCount(mounted.sent)).toBe(2);
  });

  it("clears the double-tap seed once a long press fires", () => {
    const mounted = ready();
    mounted.setMobileAppShell(true);
    armViaFirstTap(mounted, 400, 300);

    const pointerId = nextPointerId++;
    fireEvent.pointerDown(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 300 }, 1, pointerId),
    );
    vi.advanceTimersByTime(500);
    fireEvent.pointerUp(
      mounted.overlay,
      touchInit({ clientX: 400, clientY: 300 }, 0, pointerId),
    );

    // Inside the window and radius of the long-pressed tap, but the long
    // press already spoke for that finger - this tap starts fresh.
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 405, 302);

    expect(zoomFrames(mounted.sent)).toEqual([]);
  });

  it("re-syncs from a reported page scale so the next double tap zooms in", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 410, 305); // zooms in; the controller now thinks it's at 1.5x

    // Something else reset the page's zoom back to 1x.
    mounted.controller.notePageScaleFactor(1);

    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 405, 302);

    expect(zoomFrames(mounted.sent).map((frame) => frame.factor)).toEqual([
      1.5, 1.5,
    ]);
  });

  it("re-syncs from a reported page scale so the next double tap zooms out", () => {
    const mounted = ready();
    armViaFirstTap(mounted, 400, 300);
    mounted.controller.notePageScaleFactor(1.5);

    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 410, 305);

    expect(zoomFrames(mounted.sent)).toEqual([
      { kind: "setZoom", hasBinaryPayload: false, factor: 1 },
    ]);
  });

  it("never zooms when the host cannot answer a page signal", () => {
    const mounted = mountController();
    mounted.controller.notePresentedSequence(7);
    armViaFirstTap(mounted, 400, 300);
    vi.advanceTimersByTime(150);
    tap(mounted.overlay, 410, 305);

    expect(zoomFrames(mounted.sent)).toEqual([]);
    expect(pointerDownCount(mounted.sent)).toBe(2);
  });
});
