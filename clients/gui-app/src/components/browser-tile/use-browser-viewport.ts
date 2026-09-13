import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BrowserViewGuestViewportRequested } from "@traycer-clients/shared/platform/browser-view";
import {
  browserViewportSizeSchema,
  type BrowserViewportGeometry,
  type BrowserViewportIntent,
  type BrowserViewportState,
} from "@traycer/protocol/host/browser/viewport";
import {
  useMaybeBrowserSessionsContext,
  useMaybeBrowserSessionsCoordinatorKey,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { browserSessionsCoordinatorState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import {
  browserTabId,
  subscribeBrowserTabId,
} from "@/lib/browser-tab-identity";
import { useDesktopWindowId } from "@/lib/windows/desktop-window-id";
import { toastFromHostError } from "@/lib/host-error-toast";
import { runWhenNativeKeyboardSettled } from "@/lib/native-keyboard";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import {
  confirmBrowserGuestViewport,
  readBrowserGuestViewport,
  subscribeBrowserGuestViewport,
  type BrowserGuestViewportPresentation,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";

/**
 * A report the host answers with silence (it deduped it via `sameGeometry`, or
 * ownership moved between send and arrival) must not strand the hold. 4s is
 * the host's own per-apply budget (`playwright-browser-driver.ts`), so anything
 * still outstanding past it is not coming.
 */
const FIT_CONFIRM_TIMEOUT_MS = 4_000;

/**
 * Trailing coalesce for a ResizeObserver burst. Deliberately NOT sized against
 * the 250ms `h-safe-dvh` glide (`index.css`): the glide is held out by the
 * native keyboard's `transitioning` flag, and a trailing timer re-armed by each
 * of its ~16 ticks fires only after the last one anyway. 50ms matches the
 * terminal's observer (`terminal-tile-xterm.tsx`) and is immaterial next to the
 * host's apply, which is four CDP round trips under a 4s budget.
 */
const VIEWPORT_REPORT_DEBOUNCE_MS = 50;

export interface BrowserViewportOrigin {
  readonly x: number;
  readonly anchor: 0 | 0.5 | 1;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly availableWidth: number;
  readonly availableHeight: number;
}

export interface BrowserViewportController {
  readonly state: BrowserViewportState;
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly expanded: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly dismissError: () => void;
  readonly previewScale: number;
  readonly previewScaleSetting: number | null;
  readonly setPreviewScale: (scale: number | null) => void;
  readonly previewOrigin: BrowserViewportOrigin | null;
  readonly ratioLocked: boolean;
  readonly ratio: number | null;
  readonly resizeScale: number;
  readonly setRatio: (ratio: number) => void;
  readonly fitOwnedHere: boolean;
  readonly open: () => void;
  readonly reset: () => Promise<void>;
  readonly resize: (
    width: number,
    height: number,
    origin: BrowserViewportOrigin | null,
  ) => Promise<void>;
  readonly setRatioLocked: (locked: boolean) => void;
  readonly claim: () => void;
  readonly setTrigger: (element: HTMLButtonElement | null) => void;
}

export interface BrowserViewportPresentation {
  readonly controller: BrowserViewportController | null;
  readonly areaRef: RefObject<HTMLDivElement | null>;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly guestViewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly autoFit: boolean;
    readonly requestId: string | null;
  } | null;
  readonly paintedSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  /** The measured pane, for the DEV overlay (research 09 §D). */
  readonly area: { readonly width: number; readonly height: number };
  /** Monotonic count of Fit reports actually put on the wire; DEV overlay only. */
  readonly reportCount: number;
  readonly claim: () => void;
  readonly onInteraction: (event: SyntheticEvent) => void;
}

interface ViewportFailure {
  readonly error: Error;
  readonly revision: number;
  readonly connectionGeneration: number;
}

/** The host owns layout; this hook owns only this surface's presentation. */
export function useBrowserViewport(input: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly instanceId: string;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly pageZoom: number;
  readonly native: boolean;
  readonly registrationId: string | null;
}): BrowserViewportPresentation {
  const sessions = useMaybeBrowserSessionsContext();
  const coordinatorKey = useMaybeBrowserSessionsCoordinatorKey();
  const observed = sessions?.viewports[input.tabId];
  const state = observed?.sessionId === input.sessionId ? observed : null;
  const nativeViewport = useNativeViewportPresentation(
    input.registrationId,
    state,
    input.pageZoom,
  );
  const paneFocused = usePaneFocused();
  // What this viewer drives the viewport with (D02): a coarse-pointer Fit
  // owner is what makes the host render the page phone-shaped. The pointer
  // class, not which bundle is running - a touch laptop reports `coarse` too.
  const coarse = useCoarsePointer();
  const desktopWindowId = useDesktopWindowId();
  const readWindowId = useCallback(
    () => desktopWindowId ?? browserTabId(),
    [desktopWindowId],
  );
  const windowId = useSyncExternalStore(subscribeBrowserTabId, readWindowId);
  // Native binding recovery remounts the surface; placement and window survive.
  const viewerId = JSON.stringify([windowId, input.instanceId]);
  const [opened, setOpened] = useState(false);
  const [previewScaleSetting, setPreviewScale] = useState<number | null>(null);
  const [previewOrigin, setPreviewOrigin] =
    useState<BrowserViewportOrigin | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [failure, setFailure] = useState<ViewportFailure | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const geometryRef = useRef<BrowserViewportGeometry | null>(null);
  const actionRevision = useRef(0);
  const activationPending = useRef(false);
  const report = sessions?.reportViewport;
  const release = sessions?.releaseViewport;
  const supported = state !== null;
  const connectionGeneration = sessions?.connectionGeneration;
  const lifecycle = sessions?.lifecycle;
  const canChange = !input.disabled && lifecycle === "live";
  const { expanded, nativePending, resetPreferences, clearAgentOrigin } =
    viewportControlState(state, nativeViewport, {
      opened,
      scale: previewScaleSetting,
      origin: previewOrigin,
    });

  // Preview preferences belong to the responsive controls' lifetime, including
  // when another viewer or agent exits that mode. Reset before children paint.
  if (resetPreferences) {
    setPreviewScale(null);
    setPreviewOrigin(null);
  }

  useEffect(() => {
    // Activation can precede the first nonzero measurement. Keep it pending
    // across geometry changes without treating those changes as new activity.
    activationPending.current =
      input.visible && paneFocused && document.hasFocus();
  }, [input.visible, paneFocused, viewerId]);

  // D22a: while a Fit report is outstanding the painted box keeps the last
  // host-CONFIRMED scale, so a pane that shrinks ahead of the host (the 250ms
  // keyboard glide) clips the picture instead of thumbnailing it.
  const { heldScale, reportCount, hold, holdForClaim, countReport, commit } =
    useFitReportHold(state, viewerId);

  useEffect(() => {
    const element = areaRef.current;
    if (element === null || !input.visible) return;
    // Local to this subscription: reconnect and ownership/lifecycle changes
    // still resend, but ResizeObserver's initial delivery need not repeat it.
    let lastReported: BrowserViewportGeometry | null = null;
    let reportTimer: number | null = null;
    let settleCancel: (() => void) | null = null;
    const cancelPendingReport = (): void => {
      if (reportTimer !== null) {
        clearTimeout(reportTimer);
        reportTimer = null;
      }
      settleCancel?.();
      settleCancel = null;
    };
    const sendReport = (): void => {
      // The LAST measurement, not the one that armed the timer.
      const geometry = geometryRef.current;
      if (geometry === null) return;
      if (
        lastReported?.width === geometry.width &&
        lastReported.height === geometry.height &&
        lastReported.dpr === geometry.dpr
      )
        return;
      lastReported = geometry;
      report?.({
        sessionId: input.sessionId,
        tabId: input.tabId,
        viewerId,
        geometry,
        claim: activationPending.current && document.hasFocus(),
        pointer: coarse ? "coarse" : "fine",
      });
      activationPending.current = false;
      countReport();
    };
    /**
     * D22b: one report per gesture. The trailing timer coalesces a plain
     * ResizeObserver burst; `runWhenNativeKeyboardSettled` holds the whole
     * keyboard glide out (outside the installed app it runs synchronously, so
     * desktop behaviour is the debounce alone). The hold latches here, when the
     * pane first disagrees with the host - not at send - because the glide's
     * every tick would otherwise repaint at an unconfirmed scale.
     */
    const scheduleReport = (): void => {
      cancelPendingReport();
      hold();
      reportTimer = window.setTimeout(() => {
        reportTimer = null;
        settleCancel = runWhenNativeKeyboardSettled(() => {
          settleCancel = null;
          sendReport();
        });
      }, VIEWPORT_REPORT_DEBOUNCE_MS);
    };
    const measure = (): void => {
      const width = element.clientWidth - (expanded ? 48 : 0);
      const height = element.clientHeight - (expanded ? 48 : 0);
      if (width <= 0 || height <= 0) return;
      setArea((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
      const geometry = {
        width: Math.max(1, Math.round(width / input.pageZoom)),
        height: Math.max(1, Math.round(height / input.pageZoom)),
        dpr: Math.min(8, window.devicePixelRatio),
      };
      geometryRef.current = geometry;
      if (
        supported &&
        canChange &&
        (lastReported?.width !== geometry.width ||
          lastReported.height !== geometry.height ||
          lastReported.dpr !== geometry.dpr)
      ) {
        scheduleReport();
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      cancelPendingReport();
    };
  }, [
    input.visible,
    input.pageZoom,
    input.sessionId,
    input.tabId,
    report,
    supported,
    viewerId,
    connectionGeneration,
    canChange,
    coarse,
    expanded,
    paneFocused,
    hold,
    countReport,
  ]);

  /**
   * The release, and nothing else, so that it fires when this viewer stops
   * showing the tab and at no other time.
   *
   * Deliberately NOT the measure effect's cleanup: that effect re-runs on
   * eleven inputs, so an expand, a pane-focus change, a page-zoom change or a
   * sessions reconnect would release this viewer's own Fit ownership
   * mid-session - and the next report only re-claims on a deliberate
   * activation, which a plain re-measure is not.
   */
  useEffect(() => {
    if (release === undefined) return;
    return () => {
      release({
        sessionId: input.sessionId,
        tabId: input.tabId,
        viewerId,
      });
    };
  }, [release, input.sessionId, input.tabId, viewerId]);

  const claim = useCallback(() => {
    const geometry = geometryRef.current;
    if (!supported || !canChange || geometry === null || !input.visible) return;
    report?.({
      sessionId: input.sessionId,
      tabId: input.tabId,
      viewerId,
      geometry,
      claim: true,
      pointer: coarse ? "coarse" : "fine",
    });
    countReport();
    // A claim is always an owner-transferring report - the host answers it
    // whoever sends it - so it latches unconditionally, unlike the measure
    // path. It also stays immediate and undebounced (D03): ownership transfer
    // is a deliberate act, and delaying it would let a background measurement
    // land first.
    holdForClaim();
  }, [
    coarse,
    input.sessionId,
    input.tabId,
    input.visible,
    report,
    supported,
    canChange,
    viewerId,
    countReport,
    holdForClaim,
  ]);

  const mutation = useMutation({
    mutationKey: browserMutationKeys.setViewport(
      input.hostId,
      input.sessionId,
      input.tabId,
    ),
    retry: false,
    mutationFn: async (action: {
      readonly intent: BrowserViewportIntent;
      readonly origin: BrowserViewportOrigin | null;
      readonly revision: number;
      readonly connectionGeneration: number | undefined;
    }): Promise<void> => {
      const { intent } = action;
      if (!canChange)
        throw new Error(
          "Viewport controls are unavailable for this browser view.",
        );
      if (sessions === null || !supported)
        throw new Error("Update this host to change browser dimensions.");
      if (intent.mode === "fixed") {
        const checked = browserViewportSizeSchema.safeParse({
          width: intent.width,
          height: intent.height,
        });
        if (!checked.success)
          throw new Error(
            checked.error.issues[0]?.message ??
              "Enter a supported viewport size.",
          );
      }
      // Invalid drafts must never take Fit ownership or reflow the page.
      setPreviewOrigin(action.origin);
      claim();
      await sessions.setViewport(input.sessionId, input.tabId, intent);
    },
    onError: (error, action) => {
      // Rollback can publish before the RPC rejects. Anchor the failure to
      // that confirmed state, rather than hiding it against its own rollback.
      const current =
        browserSessionsCoordinatorState(coordinatorKey) ?? sessions;
      if (
        action.revision !== actionRevision.current ||
        action.connectionGeneration !== current?.connectionGeneration
      )
        return;
      setFailure({
        error,
        revision: current?.viewports[input.tabId]?.revision ?? 0,
        connectionGeneration: current?.connectionGeneration ?? 0,
      });
      if (!expanded)
        toastFromHostError(
          toHostRpcError(error, "browser.sessions"),
          error.message,
        );
    },
  });
  if (clearAgentOrigin && !mutation.isPending) setPreviewOrigin(null);
  const apply = (
    intent: BrowserViewportIntent,
    origin: BrowserViewportOrigin | null,
  ): Promise<void> =>
    mutation.mutateAsync({
      intent,
      origin,
      revision: ++actionRevision.current,
      connectionGeneration,
    });
  const resize = async (
    width: number,
    height: number,
    origin: BrowserViewportOrigin | null,
  ): Promise<void> => {
    await apply({ mode: "fixed", width, height }, origin);
  };
  const reset = async (): Promise<void> => {
    const applied = apply({ mode: "fit" }, null);
    const revision = actionRevision.current;
    await applied;
    if (actionRevision.current !== revision) return;
    setPreviewScale(null);
    setOpened(false);
    triggerRef.current?.focus();
  };
  const open = (): void => {
    if (state === null || expanded || !canChange) return;
    const applied = apply(state.intent, previewOrigin);
    const revision = actionRevision.current;
    // The native apply path preserves annotations before the row can reflow Fit.
    void applied
      .then(() => {
        if (actionRevision.current === revision) setOpened(true);
      })
      .catch(() => undefined);
  };
  const onInteraction = (event: SyntheticEvent): void => {
    // Toolbar mutations claim when applied. Inspecting presets or changing
    // preview scale must not reflow another viewer's Fit.
    if (
      event.target === scrollRef.current ||
      (event.target instanceof Element &&
        event.target.closest("[data-viewport-controls]") !== null)
    )
      return;
    claim();
  };
  const layout = viewportLayout({
    state,
    area,
    pageZoom: input.pageZoom,
    native: input.native,
    viewerId,
    expanded,
    previewScaleSetting,
    nativeViewport,
    heldScale,
  });
  // The committed scale is recorded in an effect, never during render: on the
  // render that latches, the held value is therefore the scale of the last
  // commit with no report outstanding - the one the host had confirmed (D22a).
  useEffect(() => {
    commit(layout);
  }, [commit, layout]);
  if (layout === null)
    return {
      areaRef,
      scrollRef,
      claim,
      onInteraction,
      area,
      reportCount,
      guestViewport: null,
      paintedSize: null,
      controller: null,
    };
  const { size, scale, resizeScale, fitOwnedHere, guestViewport, paintedSize } =
    layout;
  return {
    areaRef,
    scrollRef,
    claim,
    onInteraction,
    area,
    reportCount,
    guestViewport,
    paintedSize,
    controller: {
      state:
        nativeViewport === null
          ? layout.state
          : { ...layout.state, intent: nativeViewport.intent },
      size,
      expanded,
      pending: mutation.isPending || nativePending,
      disabled: !canChange,
      error: viewportFailureMessage(
        failure,
        mutation.error,
        layout.state.revision,
        connectionGeneration,
      ),
      dismissError: () => setFailure(null),
      previewScale: scale,
      previewScaleSetting,
      setPreviewScale: (nextScale) => {
        if (nextScale === null) setPreviewOrigin(null);
        setPreviewScale(nextScale);
      },
      previewOrigin,
      ratioLocked: ratio !== null,
      ratio,
      resizeScale,
      setRatio: (nextRatio) => {
        if (ratio !== null) setRatio(nextRatio);
      },
      fitOwnedHere,
      open,
      reset,
      resize,
      setRatioLocked: (locked) =>
        setRatio(locked && size !== null ? size.width / size.height : null),
      claim,
      setTrigger: (element) => {
        triggerRef.current = element;
      },
    },
  };
}

/**
 * The outstanding-Fit-report latch (D22a) and the DEV report counter, kept out
 * of {@link useBrowserViewport} so the caller reads as presentation.
 *
 * `heldScale` is the scale to paint at while a report is outstanding: the last
 * one committed with nothing outstanding - i.e. the last the host had confirmed
 * - and `null` whenever the live pane may be trusted again.
 */
function useFitReportHold(
  state: BrowserViewportState | null,
  viewerId: string,
): {
  readonly heldScale: number | null;
  readonly reportCount: number;
  readonly hold: () => void;
  readonly holdForClaim: () => void;
  readonly countReport: () => void;
  readonly commit: (layout: { readonly scale: number } | null) => void;
} {
  const [heldScale, setHeldScale] = useState<number | null>(null);
  const [reportCount, setReportCount] = useState(0);
  // Written in an effect and read only from the send paths, which run from a
  // timer: the value is the scale of the last committed render, so latching
  // during a pane change holds the size the host last confirmed against.
  const committedScale = useRef<number | null>(null);
  const fitOwnedHereRef = useRef(false);

  useEffect(() => {
    const fitOwnerId = state?.fitOwnerId ?? null;
    fitOwnedHereRef.current = fitOwnerId === null || fitOwnerId === viewerId;
  }, [state?.fitOwnerId, viewerId]);

  /**
   * Latch the painted box until the host answers. Gated on ownership: the host
   * answers a report from the Fit owner (or a claim) and silently returns the
   * current state for anyone else (`browser-viewport-plane.ts`), so a non-owner
   * that latched would freeze its own rotate/resize behind a report nobody will
   * answer.
   */
  const hold = useCallback((): void => {
    if (fitOwnedHereRef.current) setHeldScale(committedScale.current);
  }, []);
  /** A claim transfers ownership, so the host always answers it. */
  const holdForClaim = useCallback((): void => {
    setHeldScale(committedScale.current);
  }, []);
  const countReport = useCallback((): void => {
    if (import.meta.env.DEV) setReportCount((count) => count + 1);
  }, []);
  const commit = useCallback(
    (layout: { readonly scale: number } | null): void => {
      committedScale.current = layout === null ? null : layout.scale;
    },
    [],
  );

  // Any word from the host - a confirmed geometry or a new revision - ends the
  // hold. Adjusted during render rather than in an effect so the tile never
  // paints one more frame at the held scale after the host has answered.
  const applied = state?.applied ?? null;
  const confirmed = `${applied?.width ?? "-"}x${applied?.height ?? "-"}@${applied?.dpr ?? "-"}#${state?.revision ?? "-"}`;
  const [lastConfirmed, setLastConfirmed] = useState(confirmed);
  if (lastConfirmed !== confirmed) {
    setLastConfirmed(confirmed);
    setHeldScale(null);
  }

  /**
   * Backstop: a report the host answers with silence (it deduped it via
   * `sameGeometry`, or ownership moved between send and arrival) must not
   * strand the hold.
   */
  useEffect(() => {
    if (heldScale === null) return;
    const timer = window.setTimeout(() => {
      setHeldScale(null);
    }, FIT_CONFIRM_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [heldScale]);

  return { heldScale, reportCount, hold, holdForClaim, countReport, commit };
}

function viewportControlState(
  state: BrowserViewportState | null,
  nativeViewport: BrowserGuestViewportPresentation | null,
  preferences: {
    readonly opened: boolean;
    readonly scale: number | null;
    readonly origin: BrowserViewportOrigin | null;
  },
): {
  readonly expanded: boolean;
  readonly nativePending: boolean;
  readonly resetPreferences: boolean;
  readonly clearAgentOrigin: boolean;
} {
  const expanded =
    preferences.opened ||
    state?.intent.mode === "fixed" ||
    nativeViewport?.intent.mode === "fixed";
  return {
    expanded,
    nativePending: nativeViewport?.confirmed === false,
    resetPreferences:
      !expanded && (preferences.scale !== null || preferences.origin !== null),
    clearAgentOrigin: state?.source === "agent" && preferences.origin !== null,
  };
}

function viewportFailureMessage(
  failure: ViewportFailure | null,
  error: Error | null,
  revision: number,
  connectionGeneration: number | undefined,
): string | null {
  return failure !== null &&
    failure.error === error &&
    failure.revision === revision &&
    failure.connectionGeneration === connectionGeneration
    ? failure.error.message
    : null;
}

function viewportLayout(input: {
  readonly state: BrowserViewportState | null;
  readonly area: { readonly width: number; readonly height: number };
  readonly pageZoom: number;
  readonly native: boolean;
  readonly viewerId: string;
  readonly expanded: boolean;
  readonly previewScaleSetting: number | null;
  readonly nativeViewport: BrowserViewGuestViewportRequested | null;
  /** The last host-confirmed scale while a Fit report is outstanding (D22a). */
  readonly heldScale: number | null;
}): {
  readonly size: BrowserViewportController["size"];
  readonly scale: number;
  readonly resizeScale: number;
  readonly fitOwnedHere: boolean;
  readonly guestViewport: BrowserViewportPresentation["guestViewport"];
  readonly paintedSize: BrowserViewportPresentation["paintedSize"];
  /** The state this layout was computed from, narrowed for the caller. */
  readonly state: BrowserViewportState;
} | null {
  const { state, area } = input;
  if (state === null) return null;
  const request = input.nativeViewport;
  const { size, intrinsic, zoom } = viewportDimensions(
    state,
    input.pageZoom,
    request,
  );
  const scale =
    input.previewScaleSetting ?? input.heldScale ?? fitScale(intrinsic, area);
  const fitOwnedHere =
    state.fitOwnerId === null || state.fitOwnerId === input.viewerId;
  const layout = {
    state,
    size,
    scale,
    resizeScale: scale * zoom,
    fitOwnedHere,
    guestViewport: null,
    paintedSize: null,
  };
  if (
    input.native &&
    request === null &&
    state.intent.mode === "fit" &&
    fitOwnedHere &&
    input.previewScaleSetting === null
  ) {
    return { ...layout, paintedSize: input.expanded ? area : null };
  }
  if (intrinsic === null) return layout;
  return {
    ...layout,
    guestViewport: {
      ...intrinsic,
      scale,
      autoFit: input.previewScaleSetting === null,
      requestId: request?.requestId ?? null,
    },
    paintedSize: {
      width: intrinsic.width * scale,
      height: intrinsic.height * scale,
    },
  };
}

/** The pane-fitting scale, never an upscale. */
function fitScale(
  intrinsic: BrowserViewportController["size"],
  area: { readonly width: number; readonly height: number },
): number {
  return intrinsic === null || area.width === 0 || area.height === 0
    ? 1
    : Math.min(1, area.width / intrinsic.width, area.height / intrinsic.height);
}

function viewportDimensions(
  state: BrowserViewportState,
  zoom: number,
  request: BrowserViewGuestViewportRequested | null,
): {
  readonly size: BrowserViewportController["size"];
  readonly intrinsic: BrowserViewportController["size"];
  readonly zoom: number;
} {
  if (request !== null)
    return {
      size: nativeViewportSize(request),
      intrinsic: { width: request.width, height: request.height },
      zoom: request.zoom,
    };
  const size =
    state.applied ?? (state.intent.mode === "fixed" ? state.intent : null);
  return {
    size,
    intrinsic:
      size === null
        ? null
        : { width: size.width * zoom, height: size.height * zoom },
    zoom,
  };
}

function nativeViewportSize(request: BrowserViewGuestViewportRequested): {
  readonly width: number;
  readonly height: number;
} {
  if (request.intent.mode === "fixed") return request.intent;
  return {
    width: Math.max(1, Math.round(request.width / request.zoom)),
    height: Math.max(1, Math.round(request.height / request.zoom)),
  };
}

function useNativeViewportPresentation(
  registrationId: string | null,
  state: BrowserViewportState | null,
  zoom: number,
): BrowserGuestViewportPresentation | null {
  const request = useSyncExternalStore(subscribeBrowserGuestViewport, () =>
    readBrowserGuestViewport(registrationId),
  );
  useEffect(() => {
    confirmBrowserGuestViewport({ registrationId, state, zoom });
  }, [registrationId, state, zoom, request]);
  return request;
}
