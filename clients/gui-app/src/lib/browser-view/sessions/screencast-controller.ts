import type {
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  InputEvent as ReactInputEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type {
  BrowserScreencastCaptureMode,
  BrowserScreencastClientFrame,
  BrowserScreencastServerFrame,
  BrowserScreencastServerFrameV22,
} from "@traycer/protocol/host/browser/contracts";
import { createScreencastArmBuffer } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import { deriveSpecDeadlineMs } from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
import {
  buildScreencastPointerFrame,
  inputModifiers,
  isScreencastModChord,
  isScreencastPasteChord,
  nextPointerClickCount,
  pointerButton,
  type PointerClickCount,
  type PointerLike,
  type ScreencastFrameSize,
  type ScreencastInputFrame,
  type ScreencastKeyboardInput,
  type ScreencastNavInput,
  type ScreencastPointerInput,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import type { BrowserInputChannelLabel } from "@/lib/browser-view/tiles/webrtc-media-registry";
import { wheelDeltaToPixels } from "@/lib/wheel-delta-to-pixels";

const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Finger travel that commits a touch press to a scroll instead of a tap. Wider
 * than the arm buffer's click slop, which measures a mouse holding still: a
 * finger never does, so a threshold tight enough for a cursor would turn every
 * tap into a one-pixel scroll.
 */
const TOUCH_SCROLL_SLOP_PX = 8;

/**
 * A hold this long, having travelled less than {@link TOUCH_SCROLL_SLOP_PX}, is
 * a long press (D14): the finger's "what is this?" gesture.
 *
 * D14 names 10px of travel; the scroll slop above is the TIGHTER threshold and
 * therefore already satisfies it, so the hold cancels on the one line that
 * already decides "this finger is scrolling" rather than on a second number two
 * pixels away from it.
 */
const LONG_PRESS_MS = 500;

/** Two taps inside this window and radius are one double tap (D15). */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
/** What a double tap toggles the host's page scale between (D15). */
const PAGE_ZOOM_FACTOR = 1.5;

/**
 * Momentum scroll (D15). The tick cap is the load-bearing number: keys, clicks
 * and wheels share the host's 120 frames/s control window
 * (`BROWSER_CONTROL_MAX_FRAMES_PER_WINDOW`, cited on the coalescers below), and
 * a ~1.5s flick at one tick per animation frame would spend half of it while
 * typing competes. At 30/s inertia is indistinguishable (critique-2 B19).
 */
const MOMENTUM_MIN_START_PX_PER_S = 200;
const MOMENTUM_STOP_PX_PER_S = 20;
const MOMENTUM_DECAY_PER_TICK = 0.9;
const MOMENTUM_MIN_TICK_MS = 1_000 / 30;
/**
 * A release this long after the last move is a HOLD, not a flick. Browsers
 * coalesce moves, so the last sample can be stale; coasting on it would fling
 * a page the finger had already parked.
 */
const MOMENTUM_MAX_SAMPLE_AGE_MS = 100;

export type ScreencastDialog = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "dialogOpened" }
> & { readonly armEpoch: number };

export interface ScreencastSessionRefs {
  readonly tileRef: RefObject<HTMLDivElement | null>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly overlayButtonRef: RefObject<HTMLButtonElement | null>;
  readonly imageRef: RefObject<HTMLImageElement | null>;
  /** The video plane's paint surface; null on a tile that never negotiated. */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly imeInputRef: RefObject<HTMLInputElement | null>;
}

export interface ScreencastOverlayHandlers {
  readonly onFocus: () => void;
  /** Hover pre-arms, so the click that follows costs no arm round trip. */
  readonly onPointerEnter: () => void;
  /**
   * Releases a hover pre-arm's host-side claim. A deliberate gesture arm is
   * left alone: the pointer leaving the tile is not a release of control.
   */
  readonly onPointerLeave: () => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerCancel: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/**
 * One point on the painting surface, normalized [0,1] and carrying the plane's
 * correlation token - the same pair a `pointer` frame is built from, so the
 * host hit-tests a long press exactly where it hit-tests a tap.
 */
export interface ScreencastSurfacePoint {
  readonly x: number;
  readonly y: number;
  readonly castSequence: number | null;
  readonly viewportEpoch: number | null;
}

/**
 * The page's editable-focus observation, minus the fields this side does not
 * read: `rect` is the page script's business (it scrolls the field into view
 * itself on the resize the keyboard inset causes - critique-2 B20), so nothing
 * here computes a scroll offset from it.
 */
export type ScreencastEditableFocus = Pick<
  Extract<BrowserScreencastServerFrameV22, { readonly kind: "editableFocus" }>,
  "focused" | "inputMode" | "multiline"
>;

export interface ScreencastImeHandlers {
  readonly onFocus: () => void;
  /**
   * The keyboard was dismissed. On the mobile app that has to reach the PAGE:
   * see `imeHandlers.onBlur` below.
   */
  readonly onBlur: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onKeyUp: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onPaste: (event: ReactClipboardEvent<HTMLInputElement>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: (
    event: ReactCompositionEvent<HTMLInputElement>,
  ) => void;
  readonly onInput: (event: ReactInputEvent<HTMLInputElement>) => void;
}

/**
 * The four moments the controller has to tell React about. Everything else it
 * owns outright - the epochs, the queues, the pointer bookkeeping - is state no
 * render ever reads, which is why it does not live in the hook.
 */
export interface ScreencastControllerListeners {
  /**
   * The viewer took CONTROL of this tab - a press, a nav, focus in the IME -
   * as opposed to merely holding the host-side claim a hover pre-arm raised.
   * Everything a render shows about being in control hangs off this, not off
   * the arm epoch, which a pre-arm also owns.
   */
  readonly onControlEngaged: (armEpoch: number) => void;
  /** Local arm torn down: React must drop armed / dialog / composing state. */
  readonly onLocalArmCleared: () => void;
  readonly onComposingChange: (composing: boolean) => void;
  readonly onDialogSettled: () => void;
  /**
   * A finger held still for {@link LONG_PRESS_MS} (D14). The controller owns
   * the gesture; the hook owns the `describePoint` request, its correlation and
   * the sheet, because all three outlive the finger.
   */
  readonly onLongPress: (point: ScreencastSurfacePoint) => void;
}

/**
 * Ticket 15's input transport: the video plane's DataChannels, as one
 * function. `false` means the channel could not take the frame, and the
 * controller re-sends it on the mux - which is what keeps every discrete frame
 * on exactly one transport across a switchover.
 */
export type ScreencastInputTransport = (
  label: BrowserInputChannelLabel,
  payload: string,
) => boolean;

export interface ScreencastController {
  readonly activeArmEpoch: () => number | null;
  readonly desiredArmEpoch: () => number | null;
  readonly lastFrameAt: () => number | null;
  readonly activeDialog: () => ScreencastDialog | null;
  readonly setVisible: (visible: boolean) => void;
  readonly setFrameSize: (frameSize: ScreencastFrameSize | null) => void;
  readonly setActiveDialog: (dialog: ScreencastDialog | null) => void;
  /** Drops the dialog and composition the previous transport incarnation left. */
  readonly resetInputContext: () => void;
  /** Latches the sequence the browser has actually painted (`<img onLoad>`); JPEG-plane pointer frames carry this for host-side hit-test correlation. */
  readonly notePresentedSequence: (sequence: number | null) => void;
  /**
   * Latches the host's viewport epoch, the video plane's correlation token -
   * a video tile paints no `castSequence`, so this is what its pointer frames
   * carry. `null` while no epoch is confirmed, which withholds input exactly
   * as an unpainted JPEG tile does.
   */
  readonly noteViewportEpoch: (epoch: number | null) => void;
  /** The latched viewport epoch, for callers judging a frame against it. */
  readonly viewportEpoch: () => number | null;
  /**
   * Which plane's token the tile is correlating against. The host announces
   * it (`captureMode` frame); nothing else about the mode lives here.
   */
  readonly setCaptureMode: (mode: BrowserScreencastCaptureMode) => void;
  readonly captureMode: () => BrowserScreencastCaptureMode;
  /**
   * The DataChannel sink for human input, or `null` for mux-only. Only the
   * high-frequency input frames ever look at it; arm/disarm, nav, dialog,
   * viewport, ack and videoPlaneState stay on the mux unconditionally.
   *
   * A transport is adopted only once the mux holds nothing this arm epoch -
   * see the reordering hazard on `adoptPendingTransport`. `null` takes effect
   * immediately.
   */
  readonly setInputTransport: (
    transport: ScreencastInputTransport | null,
  ) => void;
  /** Frame arrived over the wire: freshness clock + the ack the host gates the next capture on. Fires before paint - a tile acks on arrival, same as PiP. */
  readonly noteFrameArrived: (sequence: number) => void;
  /**
   * The page's own editable focus (D13), and the ONLY thing that raises the
   * keyboard on the mobile app - a no-op on every other shell, which keeps
   * today's click-to-focus. The keyboard therefore appears one control round
   * trip after the tap; that is the price of not raising it on every link tap
   * (plan §6, critique-2 B21 considered and declined).
   */
  readonly applyEditableFocus: (focus: ScreencastEditableFocus) => void;
  /**
   * The page scale the last frame was captured at: re-syncs the double tap's
   * local `zoomed` flag, so a zoom changed by anything but this viewer (another
   * viewer, a reload) does not invert the next double tap.
   */
  readonly notePageScaleFactor: (factor: number) => void;
  /** Allocates the next arm epoch without sending; the caller emits the frame. */
  readonly startArmEpoch: () => number;
  readonly noteArmed: (armEpoch: number) => void;
  /**
   * The host refused a pre-arm (another viewer is driving). Latches hover
   * pre-arm off for the rest of this transport's life so a pointer crossing a
   * contested tile cannot storm the mux; an explicit click still arms, which
   * steals, exactly as it did before pre-arm existed.
   */
  readonly notePreArmDenied: () => void;
  /**
   * How far the host has consumed this epoch's input sequence. Once it covers
   * the last frame this client put on the mux, a pending DataChannel transport
   * is promoted immediately - the mux cannot reorder against it any more.
   */
  readonly noteInputAck: (armEpoch: number, lastSeq: number) => void;
  readonly disarm: () => void;
  readonly clearLocalArm: (notifyHost: boolean) => void;
  /**
   * Refs-and-host half of a disarm, with no React notification: the visibility
   * teardown needs the host told immediately while the render that can no
   * longer route input commits afterwards.
   */
  readonly detachLocalArm: () => void;
  readonly requestNav: (input: ScreencastNavInput) => void;
  readonly releaseForwardedPageKeys: () => void;
  readonly respondToDialog: (
    generation: number,
    accept: boolean,
    promptText: string | null,
  ) => void;
  readonly handleTileKeyDown: (event: KeyboardEvent) => void;
  readonly handleTileKeyUp: (event: KeyboardEvent) => void;
  readonly clearClaimedLocalCodes: () => void;
  readonly handleWheel: (event: WheelEvent, surface: HTMLElement) => void;
  readonly overlayHandlers: ScreencastOverlayHandlers;
  readonly imeHandlers: ScreencastImeHandlers;
}

interface CapturedPointer {
  readonly element: HTMLElement;
  readonly pointerId: number;
}

/** The one finger a touch gesture is being translated from. */
interface ActiveTouch {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /**
   * The frame that was on screen when the finger LANDED. A click means "this
   * point of what I was looking at", and what the user was looking at is the
   * frame under the press - not whatever has repainted by the time they lift.
   */
  readonly downSequence: number | null;
  lastX: number;
  lastY: number;
  /** When `lastX`/`lastY` were sampled - the clock momentum's velocity is per. */
  lastMoveAt: number;
  /** The last move segment's velocity, in client px per MILLISECOND, per axis. */
  velocityX: number;
  velocityY: number;
  scrolling: boolean;
  /** The pending long-press timer, `null` once it has fired or been cancelled. */
  longPressTimer: number | null;
  /**
   * A long press already spoke for this finger: the release delivers no tap,
   * and the tap it would have been cannot start a double tap either.
   */
  consumed: boolean;
}

/** A flick still coasting after the finger left (D15). */
interface MomentumCoast {
  /** Where the finger lifted; every synthesized wheel is aimed there. */
  readonly clientX: number;
  readonly clientY: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly lastTickAt: number;
}

/**
 * A touch gesture completed while the host had not yet answered the arm
 * request. They are held in ONE ordered queue rather than in per-kind slots,
 * because the finger's order is the only order the page can be replayed in: a
 * tap belongs before the swipe that followed it and after the swipe that
 * preceded it, and no rule about kinds can recover that.
 *
 * The queue is also why touch does not use the arm buffer. That buffer holds
 * exactly one gesture and drops it when a second `up` lands outside the first
 * `down`'s slop - correct for a mouse, where a press and a release bracket one
 * click, and destructive for touch, where two taps in the window are two
 * gestures and forcing them through one pen annihilated both.
 */
type PendingTouchGesture =
  | {
      readonly kind: "wheel";
      readonly pointer: PointerLike;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly kind: "tap";
      readonly down: ScreencastPointerInput;
      readonly up: ScreencastPointerInput;
    };

/**
 * The non-React half of a screencast tile: the arm/disarm epoch protocol, the
 * input queues and their encoding dispatch, pointer capture, click counting,
 * rAF move coalescing and every `ScreencastInputFrame` emission. It reads the
 * tile's DOM refs directly and talks to the transport through `sendFrame`, so
 * the hook above it only has to own the handful of values a render actually
 * displays.
 */
export function createScreencastController(options: {
  readonly refs: ScreencastSessionRefs;
  readonly sendFrame: (frame: BrowserScreencastClientFrame) => void;
  readonly listeners: ScreencastControllerListeners;
  /**
   * The host's measured control-plane RTT for this subscription, or `null`
   * before any `rttProbe` has landed. Only the arm buffer's timeout reads it
   * (ticket 18), and only when a press is buffered.
   */
  readonly readControlPlaneRttMs: () => number | null;
  /**
   * Whether the video plane has DECODED a frame - not merely attached a
   * track. The `<video>` is in the tree from `ontrack`, blank, while the tile
   * shows its connecting loader; a pointer normalized against that element
   * would be aimed at pixels nobody can see.
   */
  readonly readVideoPainting: () => boolean;
  /**
   * What the surface hosting this tile does with `mod+t`, or `null` where it
   * has no answer and the key belongs to the page.
   *
   * The streamed half of the `newTab` row in
   * `reserved-chords-registration.ts`. A native tile gets that chord from
   * main, which claims the keystroke and names the command back to the tile;
   * a streamed tile has no main in its path at all - the app's own keybinding
   * registry is out of the chain while a tile is armed
   * (`keybinding-provider.tsx` skips every app action then), and everything
   * this handler does not claim is forwarded to the remote page as input. So
   * the chord has to be claimed HERE or it is not claimed anywhere.
   *
   * Read rather than captured, for the reason every other changing value here
   * is: the controller outlives the renders that supply it.
   */
  readonly readRequestNewTab: () => (() => void) | null;
  /**
   * What the surface hosting this tile does with `mod+w`, or `null` where the
   * chord belongs to the page.
   *
   * The `closeTab` row's streamed half, and non-null for exactly the surface
   * that OWNS its row's close - the Start Page panel
   * (`browserTileHostOwnsClose`), whose close is tombstone-first. A canvas
   * viewer passes `null`: it never retires its own tile, which is the same
   * rule its native twin follows at `agent-browser-tile.tsx`'s `closeTab`.
   */
  readonly readRequestCloseTab: () => (() => void) | null;
  /**
   * Whether this is the installed mobile app (`isMobileApp()`), which forks two
   * things and nothing else:
   *
   * - the keyboard follows the PAGE's editable focus instead of the gesture
   *   (D13), because focusing on every tap raises the iOS keyboard over links;
   * - a long press opens the context sheet (D14), which is a finger's gesture
   *   and has a right-click on every other shell.
   *
   * Read rather than captured for the same reason every other changing value
   * here is - though this one is a boot-time constant, so it never changes.
   */
  readonly readMobileAppShell: () => boolean;
  /**
   * Whether the negotiated `browser.screencast` minor is >= 2.2, i.e. whether
   * the host can answer a page signal at all. A pre-2.2 host warn-drops an
   * unknown client frame and answers nothing - screencast client frames are
   * fire-and-forget - so the gestures that need an answer are not even ARMED
   * against one (critique-2 B10): no long-press timer, no double-tap zoom.
   */
  readonly readPageSignalsSupported: () => boolean;
}): ScreencastController {
  const {
    listeners,
    readControlPlaneRttMs,
    readMobileAppShell,
    readPageSignalsSupported,
    readRequestCloseTab,
    readRequestNewTab,
    readVideoPainting,
    refs,
    sendFrame,
  } = options;

  let visible = false;
  let armEpochCounter = 0;
  let desiredArmEpoch: number | null = null;
  let activeArmEpoch: number | null = null;
  let inputSequence = 0;
  let presentedSequence: number | null = null;
  let viewportEpoch: number | null = null;
  let captureMode: BrowserScreencastCaptureMode = "jpeg";
  let inputTransport: ScreencastInputTransport | null = null;
  let pendingInputTransport: ScreencastInputTransport | null = null;
  /**
   * The sequence of the last input frame this epoch put on the MUX, or `null`
   * when the mux is known to be drained. Promotion to the DataChannels is
   * gated on it: while a mux frame is unaccounted for, a channel frame could
   * overtake it and be stale-rejected ahead of it.
   */
  let lastMuxInputSeq: number | null = null;
  /** Whether the arm request in flight is a speculative (hover) one. */
  let pendingArmIsPreArm = false;
  /**
   * Deliberate control, as opposed to the bare host-side claim a hover
   * pre-arm holds. A pre-armed tile owns the epoch (so the click that follows
   * costs no round trip) but drives nothing: no ring, no badge, no pointer
   * moves into the remote page against whatever agent is working there.
   */
  let gestureArmed = false;
  /**
   * Deliberate: once refused, hovering stops re-probing a contested tile for
   * the rest of this transport's life. A click still arms - and steals - so
   * the cost of being wrong (the owner released meanwhile) is one click.
   */
  let preArmDenied = false;
  let lastFrameAt: number | null = null;
  let activeDialog: ScreencastDialog | null = null;
  let composing = false;
  let frameSize: ScreencastFrameSize | null = null;
  let capturedPointer: CapturedPointer | null = null;
  let activeTouch: ActiveTouch | null = null;
  /** The last DELIVERED tap, for the double-tap window (D15). */
  let lastTap: {
    readonly at: number;
    readonly x: number;
    readonly y: number;
  } | null = null;
  /** What this viewer last told the host to zoom to, re-synced from each frame. */
  let zoomed = false;
  let momentum: MomentumCoast | null = null;
  let momentumRaf: number | null = null;
  /** Whether the PAGE reports an editable focused - the mobile keyboard's truth. */
  let pageEditableFocused = false;
  let pendingTouchGestures: PendingTouchGesture[] = [];
  let suppressPointerId: number | null = null;
  let pointerClickCount: PointerClickCount | null = null;
  let pendingNav: ScreencastNavInput[] = [];
  const acceptedPointerDowns = new Map<
    ScreencastPointerInput["button"],
    ScreencastPointerInput
  >();
  const forwardedKeyDowns = new Map<string, ScreencastKeyboardInput>();
  const claimedLocalCodes = new Set<string>();

  /**
   * The element a pointer's coordinates are normalized against: whichever
   * plane is PAINTING, since exactly one ever is (ticket 26) and both are
   * `object-contain` inside the same overlay button. `null` for the whole
   * loader window - a mounted-but-blank `<video>` is not a surface - and a
   * pointer frame built against nothing is dropped rather than misaimed.
   */
  const paintSurface = (): HTMLElement | null =>
    (readVideoPainting() ? refs.videoRef.current : null) ??
    refs.imageRef.current;

  /**
   * The one place the display plane decides anything on this side: which token
   * the pointer frames (and the arm buffer) correlate against. `captureMode`
   * is the host telling us whether a JPEG frame is coming at all - `video`
   * covers the whole time its cast is stopped, live track or not - so the
   * epoch is the only token that exists in that window.
   */
  const correlationToken = (): number | null =>
    captureMode === "video" ? viewportEpoch : presentedSequence;

  const armBuffer = createScreencastArmBuffer<ScreencastPointerInput>(
    () => {
      pointerClickCount = null;
      if (capturedPointer === null) return;
      suppressPointerId = capturedPointer.pointerId;
    },
    () =>
      deriveSpecDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.armBuffer,
        readControlPlaneRttMs(),
      ),
  );

  const sendInput = (frame: ScreencastInputFrame): void => {
    if (activeArmEpoch === null) return;
    if (frame.kind === "keyboard") {
      if (frame.type === "rawKeyDown") forwardedKeyDowns.set(frame.code, frame);
      else if (frame.type === "keyUp") forwardedKeyDowns.delete(frame.code);
    }
    // One encoder, two sinks: the DataChannels carry the SAME wire frame the
    // mux would have carried, so the host has a single parse path.
    const wire: BrowserScreencastClientFrame = {
      ...frame,
      hasBinaryPayload: false,
      armEpoch: activeArmEpoch,
      seq: inputSequence,
    };
    inputSequence += 1;
    const transport = inputTransport;
    const label =
      transport === null || captureMode !== "video"
        ? null
        : inputTransportLabel(frame);
    if (
      label !== null &&
      transport !== null &&
      transport(label, JSON.stringify(wire))
    ) {
      return;
    }
    lastMuxInputSeq = wire.seq;
    sendFrame(wire);
  };

  /**
   * Adopt a pending transport as soon as the mux holds nothing this epoch -
   * at the arm itself (the host resets its `lastSeq` there, so nothing can
   * reorder against the channel), or later, when a host `inputAck` says the
   * mux has drained. The two transports have no ordering between them and the
   * mux runs seconds behind the channel, so a frame still in flight there
   * would arrive after - and be stale-rejected against - the first channel
   * frame that overtook it: a press left on the mux turns a drag into a hover.
   */
  const adoptPendingTransport = (): void => {
    if (pendingInputTransport === null || lastMuxInputSeq !== null) return;
    inputTransport = pendingInputTransport;
  };

  const releaseCapturedPointer = (): void => {
    const captured = capturedPointer;
    capturedPointer = null;
    if (captured === null) return;
    try {
      captured.element.releasePointerCapture(captured.pointerId);
    } catch {
      // Already released or the node is gone.
    }
  };

  // Budget: keys + wheel + clicks share the host's 120/s control window
  // (`BROWSER_CONTROL_MAX_FRAMES_PER_WINDOW`, browser-screencast-control.ts).
  // Coalescing every tick into at most one send per animation frame caps each
  // continuous stream at ~60/s, leaving headroom for keyboard bursts and
  // clicks sharing the same budget.
  const moveInput = rafCoalescer((_pending, next) => next, sendInput);
  const wheelInput = rafCoalescer(
    (pending, next) => ({
      ...next,
      deltaX: pending.deltaX + next.deltaX,
      deltaY: pending.deltaY + next.deltaY,
    }),
    // A pending move belongs ahead of the wheel it preceded.
    (frame) => {
      moveInput.flush();
      sendInput(frame);
    },
  );

  const sendDiscretePointer = (frame: ScreencastPointerInput): void => {
    wheelInput.flush();
    moveInput.flush();
    sendInput(frame);
    if (frame.type === "down") {
      acceptedPointerDowns.set(frame.button, frame);
      return;
    }
    if (frame.type === "up") acceptedPointerDowns.delete(frame.button);
  };

  /**
   * The hidden IME input takes focus from a GESTURE - a click is where typing
   * goes, and doing it inside the pointer handler keeps it the user gesture iOS
   * requires. On the mobile app it is the PAGE that decides instead (D13): this
   * is a no-op there, and `applyEditableFocus` raises the keyboard for the taps
   * that actually land in a field.
   */
  const focusImeForGesture = (): void => {
    if (readMobileAppShell()) return;
    refs.imeInputRef.current?.focus();
  };

  const stopMomentum = (): void => {
    momentum = null;
    if (momentumRaf === null) return;
    window.cancelAnimationFrame(momentumRaf);
    momentumRaf = null;
  };

  const resetTransientInput = (): void => {
    armBuffer.drop();
    stopMomentum();
    activeTouch = null;
    pendingTouchGestures = [];
    pendingNav = [];
    forwardedKeyDowns.clear();
    claimedLocalCodes.clear();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    pointerClickCount = null;
    moveInput.cancel();
    wheelInput.cancel();
    releaseCapturedPointer();
  };

  const resetLocalArmRefs = (): number | null => {
    const armEpoch = activeArmEpoch ?? desiredArmEpoch;
    desiredArmEpoch = null;
    activeArmEpoch = null;
    lastMuxInputSeq = null;
    gestureArmed = false;
    activeDialog = null;
    composing = false;
    resetTransientInput();
    return armEpoch;
  };

  const startArmEpoch = (): number => {
    armEpochCounter += 1;
    desiredArmEpoch = armEpochCounter;
    inputSequence = 0;
    // Minting an epoch outside `sendArmRequest` (the reconnect-with-focus arm
    // in `use-screencast-session`) is always a real claim.
    pendingArmIsPreArm = false;
    gestureArmed = true;
    return armEpochCounter;
  };

  const sendArmRequest = (kind: "arm" | "preArm"): void => {
    const armEpoch = startArmEpoch();
    pendingArmIsPreArm = kind === "preArm";
    gestureArmed = kind === "arm";
    sendFrame({ kind, hasBinaryPayload: false, armEpoch });
  };

  /**
   * Promote the claim this tile already holds into control. A pre-armed tile
   * is already armed at the host, so there is no frame to send and nothing to
   * wait for - only the render (and the move forwarding) to catch up.
   */
  const engageControl = (): void => {
    if (gestureArmed) return;
    gestureArmed = true;
    if (activeArmEpoch !== null) listeners.onControlEngaged(activeArmEpoch);
  };

  const preArm = (): void => {
    if (desiredArmEpoch !== null || activeArmEpoch !== null || preArmDenied) {
      return;
    }
    sendArmRequest("preArm");
  };

  /**
   * The arm a deliberate gesture needs - a press, or a nav from the toolbar:
   * a real one. A speculative claim still in flight is REPLACED rather than
   * waited on, because it may be refused, and the gesture is itself the
   * authorization to take control from whoever holds it. The refusal for the
   * superseded epoch is ignored on arrival (neither the desired nor the active
   * epoch matches it any more).
   */
  const armForGesture = (): void => {
    if (activeArmEpoch !== null) {
      engageControl();
      return;
    }
    if (desiredArmEpoch === null || pendingArmIsPreArm) sendArmRequest("arm");
    else gestureArmed = true;
  };

  const clearLocalArm = (notifyHost: boolean): void => {
    const armEpoch = resetLocalArmRefs();
    listeners.onLocalArmCleared();
    if (!notifyHost || armEpoch === null) return;
    sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
  };

  const detachLocalArm = (): void => {
    const armEpoch = resetLocalArmRefs();
    if (armEpoch === null) return;
    sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
  };

  const deliverArmBuffer = (): void => {
    const hadPending = armBuffer.hasPending();
    const gesture = armBuffer.takeIfCurrent(correlationToken());
    if (gesture === null) {
      if (hadPending && capturedPointer !== null) {
        suppressPointerId = capturedPointer.pointerId;
      }
      return;
    }
    sendDiscretePointer(gesture.down);
    sendDiscretePointer(gesture.up);
  };

  /**
   * The gestures a finger completed while the arm request was in flight,
   * replayed in the order they were made now that there is an epoch to stamp
   * them with. Without this the whole first interaction with a freshly-opened
   * tile is lost: arming is a round trip, and on a relay it easily outlasts a
   * swipe or a tap.
   *
   * A stale TAP is dropped rather than sent. Its coordinates were normalized
   * against the frame that was on screen when the finger landed, so replaying
   * it against a frame that has since repainted clicks whatever moved into
   * that spot - the same refusal the arm buffer applies to a mouse click. A
   * wheel keeps no such promise: it carries a delta, and scrolling by it is
   * right whatever the page has repainted underneath.
   */
  const flushPendingTouchGestures = (): void => {
    const queued = pendingTouchGestures;
    pendingTouchGestures = [];
    if (activeArmEpoch === null) return;
    // A multi-click chain describes what the PAGE received. Discarding a stale
    // tap breaks it, so nothing after the discard may claim to continue it -
    // neither the taps still in this queue, whose counts were stamped when they
    // were made, nor the next tap the finger produces.
    let chainBroken = false;
    for (const gesture of queued) {
      if (gesture.kind === "wheel") {
        const frame = buildPointerFrame({
          event: gesture.pointer,
          type: "wheel",
          clampToEdge: true,
          deltaX: gesture.deltaX,
          deltaY: gesture.deltaY,
        });
        if (frame !== null) sendDiscretePointer(frame);
        continue;
      }
      // Whichever plane stamped it: exactly one of the two tokens is set, and
      // it is the one `correlationToken` was reading when the finger landed.
      if (
        (gesture.down.castSequence ?? gesture.down.viewportEpoch) !==
        correlationToken()
      ) {
        chainBroken = true;
        continue;
      }
      sendDiscretePointer(
        chainBroken ? { ...gesture.down, clickCount: 1 } : gesture.down,
      );
      sendDiscretePointer(
        chainBroken ? { ...gesture.up, clickCount: 1 } : gesture.up,
      );
    }
    if (chainBroken) pointerClickCount = null;
  };

  const noteArmed = (armEpoch: number): void => {
    // The host resets its `lastSeq` on every arm, so this epoch starts with an
    // empty mux by definition.
    lastMuxInputSeq = null;
    preArmDenied = false;
    adoptPendingTransport();
    activeArmEpoch = armEpoch;
    if (gestureArmed) listeners.onControlEngaged(armEpoch);
    // The finger's own gestures first, in the order it made them; then the
    // mouse path's buffered click, which is a different pointer's business.
    flushPendingTouchGestures();
    deliverArmBuffer();
    const pending = pendingNav;
    pendingNav = [];
    for (const frame of pending) sendInput(frame);
  };

  const requestNav = (frame: ScreencastNavInput): void => {
    if (activeArmEpoch !== null) {
      sendInput(frame);
      return;
    }
    pendingNav = [...pendingNav, frame];
    armForGesture();
  };

  const releaseForwardedPageKeys = (): void => {
    for (const frame of Array.from(forwardedKeyDowns.values())) {
      sendInput({ ...frame, type: "keyUp", autoRepeat: false });
    }
  };

  const buildPointerFrame = (request: {
    readonly event: PointerLike;
    readonly type: ScreencastPointerInput["type"];
    readonly clampToEdge: boolean;
    readonly deltaX: number;
    readonly deltaY: number;
  }): ScreencastPointerInput | null => {
    let clickCount = 0;
    if (request.type === "down") {
      const counted = nextPointerClickCount(
        pointerClickCount,
        request.event,
        performance.now(),
      );
      pointerClickCount = counted;
      clickCount = counted.count;
    } else if (request.type === "up") {
      const accepted = acceptedPointerDowns.get(
        pointerButton(request.event.button),
      );
      const down = pointerClickCount;
      clickCount =
        accepted?.clickCount ??
        (down?.button === request.event.button ? down.count : 1);
    }
    return buildScreencastPointerFrame({
      event: request.event,
      type: request.type,
      clampToEdge: request.clampToEdge,
      deltaX: request.deltaX,
      deltaY: request.deltaY,
      clickCount,
      correlationToken: correlationToken(),
      captureMode,
      surface: paintSurface(),
      frameSize,
    });
  };

  /**
   * A bare point, with no DOM event behind it: the long-press timer and the
   * momentum loop both fire long after the event that started them is gone, and
   * neither carries modifiers the page would read.
   */
  const pointerAt = (clientX: number, clientY: number): PointerLike => ({
    clientX,
    clientY,
    button: 0,
    buttons: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });

  /**
   * Where on the page a client point is, as the host reads it. Built through
   * the pointer encoder rather than beside it, so the hit test a long press
   * asks for is the identical mapping (and the identical correlation token) a
   * tap at that point would carry. `move` advances nothing - only a `down`
   * touches the multi-click counter.
   */
  const surfacePointAt = (
    clientX: number,
    clientY: number,
  ): ScreencastSurfacePoint | null => {
    const frame = buildPointerFrame({
      event: pointerAt(clientX, clientY),
      type: "move",
      clampToEdge: true,
      deltaX: 0,
      deltaY: 0,
    });
    if (frame === null) return null;
    return {
      x: frame.normalizedX,
      y: frame.normalizedY,
      castSequence: frame.castSequence,
      viewportEpoch: frame.viewportEpoch,
    };
  };

  /**
   * Momentum's OWN rAF loop (D15). Deliberately not `rafCoalescer`: that merges
   * only ticks landing inside ONE animation frame, so it would bound nothing
   * here (critique-2 B19). What bounds the rate is the {@link
   * MOMENTUM_MIN_TICK_MS} gate below - a skipped callback, not a slower clock,
   * so the coast still ends on time.
   */
  const onMomentumTick = (): void => {
    momentumRaf = null;
    const coast = momentum;
    if (coast === null) return;
    const now = performance.now();
    const elapsed = now - coast.lastTickAt;
    if (elapsed < MOMENTUM_MIN_TICK_MS) {
      momentumRaf = window.requestAnimationFrame(onMomentumTick);
      return;
    }
    const velocityX = coast.velocityX * MOMENTUM_DECAY_PER_TICK;
    const velocityY = coast.velocityY * MOMENTUM_DECAY_PER_TICK;
    if (Math.hypot(velocityX, velocityY) * 1_000 < MOMENTUM_STOP_PX_PER_S) {
      stopMomentum();
      return;
    }
    const frame = buildPointerFrame({
      event: pointerAt(coast.clientX, coast.clientY),
      type: "wheel",
      clampToEdge: true,
      // Inverted, like every other translated finger travel: the page follows
      // the finger, and the coast is the finger's travel continued.
      deltaX: -velocityX * elapsed,
      deltaY: -velocityY * elapsed,
    });
    if (frame === null) {
      // Nothing correlatable to scroll any more - the plane switched, or the
      // tile has not repainted since. The coast is over.
      stopMomentum();
      return;
    }
    momentum = { ...coast, velocityX, velocityY, lastTickAt: now };
    wheelInput.schedule(frame);
    momentumRaf = window.requestAnimationFrame(onMomentumTick);
  };

  /**
   * A flick's tail, or nothing. Below the start threshold - a slow drag let go,
   * a finger parked before lifting - there is no coast at all.
   */
  const startMomentum = (
    touch: ActiveTouch,
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const now = performance.now();
    if (now - touch.lastMoveAt > MOMENTUM_MAX_SAMPLE_AGE_MS) return;
    const speed = Math.hypot(touch.velocityX, touch.velocityY) * 1_000;
    if (speed <= MOMENTUM_MIN_START_PX_PER_S) return;
    momentum = {
      clientX: event.clientX,
      clientY: event.clientY,
      velocityX: touch.velocityX,
      velocityY: touch.velocityY,
      lastTickAt: now,
    };
    momentumRaf = window.requestAnimationFrame(onMomentumTick);
  };

  /**
   * The overlay button by ref, NOT `event.currentTarget`: a touch tap is
   * replayed out of the tile's gesture buffer at pointerup, by which time
   * React has nulled `currentTarget` on the stored down event - and it is the
   * same node either way, since the ref and these handlers sit on one button.
   */
  const capturePointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const element = refs.overlayButtonRef.current;
    if (element === null) return;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; local teardown still needs the id.
    }
    capturedPointer = { element, pointerId: event.pointerId };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    // A press of any kind ends a coast still in flight (D15).
    stopMomentum();
    capturePointer(event);
    if (activeArmEpoch !== null) {
      engageControl();
      const frame = buildPointerFrame({
        event,
        type: "down",
        clampToEdge: false,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame !== null) sendDiscretePointer(frame);
    } else {
      armForGesture();
      if (event.button !== 0) {
        suppressPointerId = event.pointerId;
      } else {
        const frame = buildPointerFrame({
          event,
          type: "down",
          clampToEdge: false,
          deltaX: 0,
          deltaY: 0,
        });
        const token = correlationToken();
        if (frame !== null && token !== null) {
          armBuffer.storeDown({
            payload: frame,
            correlationToken: token,
            clientX: event.clientX,
            clientY: event.clientY,
            isPrimary: true,
          });
        }
      }
    }
    focusImeForGesture();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (armBuffer.hasPending()) {
      armBuffer.noteMove(event.clientX, event.clientY);
      if (!armBuffer.hasPending()) suppressPointerId = event.pointerId;
      return;
    }
    if (suppressPointerId === event.pointerId) return;
    // A hover-only claim forwards nothing: the pointer crossing a tile must
    // not drive the remote cursor.
    if (activeArmEpoch === null || !gestureArmed) return;
    const frame = buildPointerFrame({
      event,
      type: "move",
      clampToEdge: event.buttons !== 0,
      deltaX: 0,
      deltaY: 0,
    });
    if (frame === null) return;
    moveInput.schedule(frame);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (armBuffer.hasPending()) {
      const frame = buildPointerFrame({
        event,
        type: "up",
        clampToEdge: true,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame !== null) {
        armBuffer.storeMatchingUp({
          payload: frame,
          isPrimary: event.button === 0,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
      releaseCapturedPointer();
      return;
    }
    if (suppressPointerId === event.pointerId) {
      suppressPointerId = null;
      releaseCapturedPointer();
      return;
    }
    if (
      activeArmEpoch !== null &&
      acceptedPointerDowns.has(pointerButton(event.button))
    ) {
      const frame = buildPointerFrame({
        event,
        type: "up",
        clampToEdge: true,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame !== null) sendDiscretePointer(frame);
    }
    releaseCapturedPointer();
  };

  const onPointerCancel = (): void => {
    stopMomentum();
    if (activeArmEpoch !== null) {
      for (const accepted of acceptedPointerDowns.values()) {
        sendDiscretePointer({ ...accepted, type: "up", buttons: 0 });
      }
    }
    armBuffer.drop();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    moveInput.cancel();
    wheelInput.cancel();
    releaseCapturedPointer();
  };

  /**
   * A touch pointer as the encoder wants to see it. The DOM event reports a
   * finger as `button 0 / buttons 1` for its whole life, which is right for the
   * synthesized click and wrong for the synthesized wheel - a wheel carrying a
   * held left button reads on the page as a button-down drag, which is the
   * text selection this translation exists to avoid.
   */
  const touchPointerLike = (
    event: ReactPointerEvent<HTMLButtonElement>,
    buttons: number,
  ): PointerLike => ({
    clientX: event.clientX,
    clientY: event.clientY,
    button: 0,
    buttons,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });

  /** The same pointer, reported where the finger first touched down. */
  const touchPointerLikeAt = (
    touch: ActiveTouch,
    event: ReactPointerEvent<HTMLButtonElement>,
    buttons: number,
  ): PointerLike => ({
    clientX: touch.startX,
    clientY: touch.startY,
    button: 0,
    buttons,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });

  const cancelLongPress = (touch: ActiveTouch): void => {
    if (touch.longPressTimer === null) return;
    window.clearTimeout(touch.longPressTimer);
    touch.longPressTimer = null;
  };

  const fireLongPress = (touch: ActiveTouch): void => {
    touch.longPressTimer = null;
    if (activeTouch !== touch) return;
    // Consumed either way: the release delivers no tap, and a gesture the host
    // cannot map is still not a tap the user asked for.
    touch.consumed = true;
    // And it is not the first half of a double tap (D15) - the two gestures
    // share the finger, so the one that fires owns it.
    lastTap = null;
    const point = surfacePointAt(touch.startX, touch.startY);
    if (point === null) return;
    listeners.onLongPress(point);
  };

  /**
   * The long press, armed on press and cancelled by anything that proves the
   * gesture was something else. Mobile app only (D14) - every other shell has a
   * right-click - and only against a host that can answer (see
   * `readPageSignalsSupported`).
   */
  const armLongPress = (touch: ActiveTouch): void => {
    if (!readMobileAppShell() || !readPageSignalsSupported()) return;
    touch.longPressTimer = window.setTimeout(() => {
      fireLongPress(touch);
    }, LONG_PRESS_MS);
  };

  const onTouchPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    // A new finger ends the coast: the page follows the finger that is down, not
    // the flick this one is interrupting.
    stopMomentum();
    // A second finger is a pinch or a stray palm, neither of which this
    // translation represents; leaving the first one in charge keeps the
    // in-flight scroll coherent instead of tearing between two origins. It does
    // end the first finger's long press, though - a pinch must stay a pinch.
    if (activeTouch !== null) {
      cancelLongPress(activeTouch);
      return;
    }
    capturePointer(event);
    const touch: ActiveTouch = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      downSequence: correlationToken(),
      lastX: event.clientX,
      lastY: event.clientY,
      lastMoveAt: performance.now(),
      velocityX: 0,
      velocityY: 0,
      scrolling: false,
      longPressTimer: null,
      consumed: false,
    };
    activeTouch = touch;
    // Arming on press, not on the tap that may follow, so the round trip
    // overlaps the gesture and a scroll can start delivering on the first move.
    armForGesture();
    armLongPress(touch);
  };

  /**
   * One finger-travel segment, as the page should receive it: inverted, because
   * the page follows the finger, and in client pixels - the same unit
   * `handleWheel` converts its own into. Shared by the move handler and the
   * release, which has its own final segment to account for.
   */
  const translateTouchScroll = (
    event: ReactPointerEvent<HTMLButtonElement>,
    deltaX: number,
    deltaY: number,
  ): void => {
    if (deltaX === 0 && deltaY === 0) return;
    if (activeArmEpoch === null) {
      // Queued rather than dropped, and replayed by `noteArmed`. Consecutive
      // moves fold into one wheel entry; a tap in between ends the run, so the
      // scroll either side of it stays on its own side.
      const last = pendingTouchGestures.at(-1);
      const carried = last?.kind === "wheel" ? last : null;
      const next: PendingTouchGesture = {
        kind: "wheel",
        pointer: touchPointerLike(event, 0),
        deltaX: (carried?.deltaX ?? 0) - deltaX,
        deltaY: (carried?.deltaY ?? 0) - deltaY,
      };
      if (carried === null) pendingTouchGestures.push(next);
      else pendingTouchGestures[pendingTouchGestures.length - 1] = next;
      return;
    }
    const frame = buildPointerFrame({
      event: touchPointerLike(event, 0),
      type: "wheel",
      clampToEdge: true,
      deltaX: -deltaX,
      deltaY: -deltaY,
    });
    if (frame === null) return;
    sendDiscretePointer(frame);
  };

  /** Whether the finger has travelled further than `slopPx` from where it landed. */
  const travelExceedsSlop = (
    touch: ActiveTouch,
    clientX: number,
    clientY: number,
    slopPx: number,
  ): boolean =>
    Math.abs(clientX - touch.startX) > slopPx ||
    Math.abs(clientY - touch.startY) > slopPx;

  const onTouchPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - touch.lastX;
    const deltaY = event.clientY - touch.lastY;
    if (!touch.scrolling) {
      if (
        !travelExceedsSlop(
          touch,
          event.clientX,
          event.clientY,
          TOUCH_SCROLL_SLOP_PX,
        )
      ) {
        // Under the scroll slop the finger is still holding still, which is what
        // a long press is: jitter must not cancel it.
        return;
      }
      touch.scrolling = true;
    }
    // A scroll is not a hold (D14) - see {@link LONG_PRESS_MS} on why this is
    // the only threshold the cancel needs.
    cancelLongPress(touch);
    const at = performance.now();
    const elapsed = at - touch.lastMoveAt;
    // Momentum reads the LAST segment. Two moves in one millisecond would
    // divide by zero, so such a tick keeps the previous sample.
    if (elapsed > 0) {
      touch.velocityX = deltaX / elapsed;
      touch.velocityY = deltaY / elapsed;
      touch.lastMoveAt = at;
    }
    touch.lastX = event.clientX;
    touch.lastY = event.clientY;
    translateTouchScroll(event, deltaX, deltaY);
  };

  /**
   * Whether this release completes a double tap (D15), plus the bookkeeping
   * that follows either way: a completed pair consumes the candidate, a lone
   * tap becomes the one the next release is measured against. The FIRST tap has
   * already been delivered as an ordinary click, which is what makes the
   * gesture cheap - only the second one is withheld, and on a 2.1 host (where
   * `setZoom` would be warn-dropped) neither is.
   */
  const consumeDoubleTap = (touch: ActiveTouch): boolean => {
    const tappedAt = performance.now();
    const previousTap = lastTap;
    const isDoubleTap =
      readPageSignalsSupported() &&
      previousTap !== null &&
      tappedAt - previousTap.at <= DOUBLE_TAP_MS &&
      Math.abs(touch.startX - previousTap.x) <= DOUBLE_TAP_SLOP_PX &&
      Math.abs(touch.startY - previousTap.y) <= DOUBLE_TAP_SLOP_PX;
    lastTap = isDoubleTap
      ? null
      : { at: tappedAt, x: touch.startX, y: touch.startY };
    return isDoubleTap;
  };

  const onTouchPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    activeTouch = null;
    cancelLongPress(touch);
    releaseCapturedPointer();
    if (touch.consumed) {
      // A long press already answered for this finger, so no click reached the
      // page and there is no multi-click chain to continue.
      pointerClickCount = null;
      return;
    }
    // The release carries its own displacement. A flick can cross the slop
    // between the last `pointermove` and the `pointerup` - browsers coalesce
    // moves, and a fast one may report almost none - so judging the gesture on
    // `scrolling` alone would call that a tap, click where the finger LANDED,
    // and raise the keyboard over what the user meant as a scroll.
    const scrolled =
      touch.scrolling ||
      travelExceedsSlop(
        touch,
        event.clientX,
        event.clientY,
        TOUCH_SCROLL_SLOP_PX,
      );
    if (scrolled) {
      // And the final segment is part of the scroll, whether it is what tipped
      // the gesture over the slop or the tail of one already under way.
      translateTouchScroll(
        event,
        event.clientX - touch.lastX,
        event.clientY - touch.lastY,
      );
      startMomentum(touch, event);
      return;
    }
    // Built from where the finger LANDED and stamped with the frame that was
    // presented then. Building from the pointer-up event instead would aim the
    // click at the current frame, so a repaint between press and release would
    // click whatever moved under the finger - and the stale-frame check below
    // would wave it through, because it would be comparing the new frame
    // against itself.
    const downSequence = touch.downSequence;
    // Refused, not merely stamped. A tap belongs to the frame it was made
    // against; once that frame is gone the coordinates describe content that
    // has been replaced, and BOTH delivery paths must say so. Sending it here
    // while the queued path rejects the identical situation would make the
    // answer depend on how busy the host happened to be.
    if (downSequence === null || downSequence !== correlationToken()) {
      // The page receives no click, so the multi-click chain it would have
      // continued does not exist.
      pointerClickCount = null;
      return;
    }
    if (consumeDoubleTap(touch)) {
      zoomed = !zoomed;
      sendFrame({
        kind: "setZoom",
        hasBinaryPayload: false,
        factor: zoomed ? PAGE_ZOOM_FACTOR : 1,
      });
      // The gesture's second tap is the zoom, not a click on the page.
      pointerClickCount = null;
      return;
    }
    const pressed = buildPointerFrame({
      event: touchPointerLikeAt(touch, event, 1),
      type: "down",
      clampToEdge: true,
      deltaX: 0,
      deltaY: 0,
    });
    const released = buildPointerFrame({
      event: touchPointerLikeAt(touch, event, 0),
      type: "up",
      clampToEdge: true,
      deltaX: 0,
      deltaY: 0,
    });
    if (pressed === null || released === null) {
      // `buildPointerFrame` advances the multi-click counter for a `down`
      // before it can fail to normalize, so a tap that dies here has still
      // been counted. Same invariant as the stale-frame branch above: no
      // click reached the page, so there is no chain to continue.
      pointerClickCount = null;
      return;
    }
    // A tap is a click, and a click is where typing goes - so the hidden IME
    // input takes focus, raising the phone's keyboard. It happens HERE, after
    // the tap has survived every check: focusing before them raises the
    // keyboard over a gesture that is then discarded, leaving it covering the
    // screen for a tap the page never received. Still inside the pointer-up
    // handler, so it is still the user gesture iOS requires. Nothing has to
    // undo it: only a deliberate release disarms, so focus leaving the IME
    // input later costs the tile nothing.
    //
    // On the installed mobile app this is where the fork lives (D13): the tap
    // raises nothing, and `applyEditableFocus` raises the keyboard one round
    // trip later for the taps that land in a field - which is the whole point,
    // since every OTHER tap on a phone is a link.
    focusImeForGesture();
    if (activeArmEpoch !== null) {
      sendDiscretePointer(pressed);
      sendDiscretePointer(released);
      return;
    }
    // Still waiting on the host's `armed`: queue the pair behind whatever the
    // finger did before it.
    pendingTouchGestures.push({ kind: "tap", down: pressed, up: released });
  };

  const onTouchPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    // Only the finger that owns the gesture may end it. An ignored second
    // touch cancels routinely - the browser reclaims it - and tearing down on
    // that would strand the primary finger's scroll mid-drag.
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    activeTouch = null;
    cancelLongPress(touch);
    // Only the gesture in flight is abandoned; gestures already completed into
    // the queue were the user's and still owed to the page.
    releaseCapturedPointer();
  };

  const onImeKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (activeDialog !== null) return;
    if (event.nativeEvent.isComposing || composing) return;
    if (activeArmEpoch === null) return;
    if (isScreencastPasteChord(event.nativeEvent)) {
      claimedLocalCodes.add(event.code);
      return;
    }
    event.preventDefault();
    sendInput({
      kind: "keyboard",
      type: "rawKeyDown",
      code: event.code,
      key: event.key,
      modifiers: inputModifiers(event),
      autoRepeat: event.repeat,
    });
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      sendInput({
        kind: "keyboard",
        type: "char",
        code: event.code,
        key: event.key,
        modifiers: inputModifiers(event),
        autoRepeat: event.repeat,
      });
    }
  };

  const onImeKeyUp = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (activeDialog !== null) return;
    if (event.nativeEvent.isComposing || composing) return;
    if (claimedLocalCodes.delete(event.code)) {
      event.preventDefault();
      return;
    }
    if (activeArmEpoch === null) return;
    if (!forwardedKeyDowns.has(event.code)) return;
    event.preventDefault();
    sendInput({
      kind: "keyboard",
      type: "keyUp",
      code: event.code,
      key: event.key,
      modifiers: inputModifiers(event),
      autoRepeat: event.repeat,
    });
  };

  return {
    activeArmEpoch: () => activeArmEpoch,
    desiredArmEpoch: () => desiredArmEpoch,
    lastFrameAt: () => lastFrameAt,
    activeDialog: () => activeDialog,
    setVisible: (next) => {
      visible = next;
    },
    setFrameSize: (next) => {
      frameSize = next;
    },
    setActiveDialog: (dialog) => {
      activeDialog = dialog;
    },
    resetInputContext: () => {
      activeDialog = null;
      composing = false;
    },
    notePresentedSequence: (sequence) => {
      presentedSequence = sequence;
    },
    noteViewportEpoch: (epoch) => {
      viewportEpoch = epoch;
    },
    viewportEpoch: () => viewportEpoch,
    captureMode: () => captureMode,
    setCaptureMode: (mode) => {
      if (mode === captureMode) return;
      captureMode = mode;
      // The two planes' tokens are different number spaces, so a gesture
      // buffered under the old one must not be matched against the new one:
      // a press held at `castSequence` 37 would replay against epoch 37.
      armBuffer.drop();
      // The finger's side of the same hazard: a queued tap carries the old
      // plane's token, and so does the finger still down. The scroll it may
      // still be making is token-free and keeps going; only the tap it could
      // end with is refused, by the `null` both delivery paths reject.
      pendingTouchGestures = [];
      pointerClickCount = null;
      if (activeTouch !== null) {
        // And the hit test a long press would ask for was measured against the
        // old plane's token, so the hold is off too.
        cancelLongPress(activeTouch);
        activeTouch = { ...activeTouch, downSequence: null };
      }
    },
    setInputTransport: (transport) => {
      pendingInputTransport = transport;
      // Demotion is immediate and safe (the fast frames were sent first, so
      // they arrive first); promotion waits for a drained mux.
      if (transport === null) inputTransport = null;
      else adoptPendingTransport();
    },
    noteFrameArrived: (sequence) => {
      lastFrameAt = Date.now();
      sendFrame({ kind: "ack", hasBinaryPayload: false, sequence });
    },
    applyEditableFocus: (focus) => {
      // Desktop and plain-web shells keep today's click-to-focus (D13) and
      // ignore the signal entirely.
      if (!readMobileAppShell()) return;
      const input = refs.imeInputRef.current;
      if (!focus.focused) {
        // Cleared BEFORE the blur, or the DOM `blur` this raises bounces a
        // `blurEditable` back at the page that just reported it had none.
        pageEditableFocused = false;
        input?.blur();
        return;
      }
      pageEditableFocused = true;
      if (input === null) return;
      // Set before `focus()`: iOS reads both when the keyboard comes up, and
      // changing them afterwards does not re-lay it out.
      input.inputMode = focus.inputMode ?? "text";
      input.enterKeyHint = enterKeyHintFor(focus);
      input.focus();
    },
    notePageScaleFactor: (factor) => {
      // ponytail: a midpoint test rather than an equality one - the page reports
      // its OWN scale and mobile emulation can land a hair either side of what
      // was asked for. Upgrade path if a page ever rests on a third value: have
      // the host echo the factor it applied.
      zoomed = factor >= (1 + PAGE_ZOOM_FACTOR) / 2;
    },
    startArmEpoch,
    noteArmed,
    notePreArmDenied: () => {
      preArmDenied = true;
    },
    noteInputAck: (armEpoch, lastSeq) => {
      if (armEpoch !== activeArmEpoch || lastMuxInputSeq === null) return;
      if (lastSeq < lastMuxInputSeq) return;
      lastMuxInputSeq = null;
      adoptPendingTransport();
    },
    disarm: () => {
      clearLocalArm(true);
    },
    clearLocalArm,
    detachLocalArm,
    requestNav,
    releaseForwardedPageKeys,
    respondToDialog: (generation, accept, promptText) => {
      const current = activeDialog;
      const armEpoch = activeArmEpoch;
      if (
        current === null ||
        current.generation !== generation ||
        armEpoch === null ||
        current.armEpoch !== armEpoch
      ) {
        return;
      }
      activeDialog = null;
      listeners.onDialogSettled();
      sendFrame({
        kind: "dialogResponse",
        hasBinaryPayload: false,
        armEpoch,
        generation,
        accept,
        promptText,
      });
      focusImeForGesture();
    },
    handleTileKeyDown: (event) => {
      const tile = refs.tileRef.current;
      if (tile === null) return;
      if (isScreencastModChord(event, "l")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        if (document.activeElement === refs.imeInputRef.current) {
          releaseForwardedPageKeys();
        }
        focusScreencastAddressBar(tile);
        return;
      }
      if (isScreencastModChord(event, "r")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        requestNav({ kind: "reload" });
        return;
      }
      if (isScreencastModChord(event, "t")) {
        // Only when the hosting surface has an answer. A tile whose surface
        // does not open tabs (the canvas) leaves the chord to the page rather
        // than swallowing it into nothing - the same split
        // `agent-browser-tile.tsx` makes on the native side, where a null
        // handler falls through instead of claiming.
        const requestNewTab = readRequestNewTab();
        if (requestNewTab === null) return;
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        // Focus is about to leave for the surface's own chooser, exactly as it
        // does for the address bar above - so the page has to be told about
        // the keys it still believes are down, or the modifier this chord was
        // typed with stays stuck there.
        if (document.activeElement === refs.imeInputRef.current) {
          releaseForwardedPageKeys();
        }
        requestNewTab();
        return;
      }
      if (isScreencastModChord(event, "w")) {
        const requestCloseTab = readRequestCloseTab();
        if (requestCloseTab === null) return;
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        // Worth doing even though this tile is about to unmount, because the
        // TAB may not be. The surface that owns this close is tombstone-first:
        // it retires the row now and lets the host's `closeTab` settle later,
        // so a device that cannot be reached keeps a live tab whose page still
        // believes the modifier this chord was typed with is held. Releasing
        // costs one frame on a transport that is usually about to close, and
        // saves the one case where nothing else ever will.
        //
        // Before the callback, not after: the close retires the row
        // synchronously, and the frames have to go out while this stream is
        // still up.
        if (document.activeElement === refs.imeInputRef.current) {
          releaseForwardedPageKeys();
        }
        requestCloseTab();
      }
    },
    handleTileKeyUp: (event) => {
      if (!claimedLocalCodes.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    clearClaimedLocalCodes: () => {
      claimedLocalCodes.clear();
    },
    handleWheel: (event, surface) => {
      if (activeArmEpoch === null) return;
      event.preventDefault();
      const frame = buildPointerFrame({
        event,
        type: "wheel",
        clampToEdge: false,
        deltaX: wheelDeltaToPixels(
          event.deltaX,
          event.deltaMode,
          surface.clientWidth,
          WHEEL_LINE_HEIGHT_PX,
        ),
        deltaY: wheelDeltaToPixels(
          event.deltaY,
          event.deltaMode,
          surface.clientHeight,
          WHEEL_LINE_HEIGHT_PX,
        ),
      });
      if (frame === null) return;
      wheelInput.schedule(frame);
    },
    overlayHandlers: {
      onFocus: () => {
        focusImeForGesture();
      },
      onPointerEnter: preArm,
      // A speculative claim the pointer merely raised is released the moment
      // it leaves; a deliberate gesture arm is not, so control survives the
      // pointer wandering off the tile.
      onPointerLeave: () => {
        if (!gestureArmed) detachLocalArm();
      },
      // A finger is translated before it reaches the pointer path: forwarded
      // verbatim it becomes a mouse drag, which on the remote page selects
      // text rather than scrolling. Every other pointer type - mouse, pen,
      // and the synthetic pointers a test drives - takes the branch below
      // unchanged.
      onPointerDown: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerDown(event);
          return;
        }
        onPointerDown(event);
      },
      onPointerMove: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerMove(event);
          return;
        }
        onPointerMove(event);
      },
      onPointerUp: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerUp(event);
          return;
        }
        onPointerUp(event);
      },
      onPointerCancel: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerCancel(event);
          return;
        }
        onPointerCancel();
      },
      onContextMenu: (event) => {
        if (activeArmEpoch === null) return;
        event.preventDefault();
      },
    },
    imeHandlers: {
      onFocus: armForGesture,
      onBlur: () => {
        // The keyboard was dismissed - the iOS "done" bar, a tap on another
        // surface - while the page still believes a field is focused. Take the
        // page's focus with it, or the caret stays in a field nothing is typing
        // into. The flag is cleared first, so the `editableFocus { focused:
        // false }` that answers this cannot send a second one.
        if (!readMobileAppShell() || !pageEditableFocused) return;
        pageEditableFocused = false;
        sendFrame({ kind: "blurEditable", hasBinaryPayload: false });
      },
      onKeyDown: onImeKeyDown,
      onKeyUp: onImeKeyUp,
      onPaste: (event) => {
        if (activeArmEpoch === null) return;
        if (!visible) return;
        const text = event.clipboardData.getData("text/plain");
        event.preventDefault();
        if (text === "") return;
        sendInput({ kind: "insertText", text });
      },
      onCompositionStart: () => {
        composing = true;
        listeners.onComposingChange(true);
      },
      onCompositionEnd: (event) => {
        composing = false;
        listeners.onComposingChange(false);
        event.currentTarget.value = "";
        if (event.data !== "") {
          sendInput({ kind: "insertText", text: event.data });
        }
      },
      onInput: (event) => {
        if (!composing) event.currentTarget.value = "";
      },
    },
  };
}

interface RafCoalescer {
  readonly schedule: (frame: ScreencastPointerInput) => void;
  /** Emits whatever is pending right now (a discrete frame needs it ordered ahead). */
  readonly flush: () => void;
  /** Drops whatever is pending without emitting it (teardown, pointer cancel). */
  readonly cancel: () => void;
}

/**
 * At most one emission per animation frame, with `merge` deciding what several
 * ticks inside one frame add up to: the latest position for moves, the summed
 * deltas for wheels.
 */
function rafCoalescer(
  merge: (
    pending: ScreencastPointerInput,
    next: ScreencastPointerInput,
  ) => ScreencastPointerInput,
  emit: (frame: ScreencastPointerInput) => void,
): RafCoalescer {
  let pending: ScreencastPointerInput | null = null;
  let raf: number | null = null;

  const cancelRaf = (): void => {
    if (raf === null) return;
    window.cancelAnimationFrame(raf);
    raf = null;
  };
  const flush = (): void => {
    const frame = pending;
    pending = null;
    cancelRaf();
    if (frame !== null) emit(frame);
  };

  return {
    schedule: (frame) => {
      pending = pending === null ? frame : merge(pending, frame);
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        flush();
      });
    },
    flush,
    cancel: () => {
      pending = null;
      cancelRaf();
    },
  };
}

/**
 * Which channel a frame belongs on, or `null` for the mux. Moves and wheels
 * are droppable, so they take the unordered lossy channel; everything a page
 * would mis-handle out of order or missing takes the reliable one. Nav frames
 * ride `sendInput` too and are control - they stay on the mux.
 */
function inputTransportLabel(
  frame: ScreencastInputFrame,
): BrowserInputChannelLabel | null {
  if (frame.kind === "keyboard" || frame.kind === "insertText") {
    return "input-reliable";
  }
  if (frame.kind !== "pointer") return null;
  return frame.type === "move" || frame.type === "wheel"
    ? "input-lossy"
    : "input-reliable";
}

/**
 * Which return key iOS should draw (D13). The keyboard TYPE comes from
 * `inputMode` verbatim; this is only the action label, and the two fields that
 * imply one win over the shape of the field: a search box searches and a URL bar
 * goes, whatever else they are.
 */
function enterKeyHintFor(focus: ScreencastEditableFocus): string {
  if (focus.inputMode === "search") return "search";
  if (focus.inputMode === "url") return "go";
  return focus.multiline ? "enter" : "done";
}

function focusScreencastAddressBar(tile: HTMLElement): void {
  const input = tile.querySelector('input[aria-label="Browser address"]');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}
