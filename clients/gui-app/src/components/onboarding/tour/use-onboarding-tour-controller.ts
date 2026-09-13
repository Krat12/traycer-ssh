import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useReducedMotion } from "motion/react";
import {
  ACTIONS,
  EVENTS,
  STATUS,
  type EventData,
  type Step,
} from "react-joyride";
import { useShallow } from "zustand/react/shallow";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  selectPresentedModalCount,
  useModalPresenceStore,
} from "@/components/ui/modal-presence";
import {
  buildTourSteps,
  TOUR_LESSONS,
  tourLessonTitle,
  type StepPresentation,
} from "@/components/onboarding/tour/tour-steps";
import {
  getActivationToken,
  startActivationWatch,
  subscribeActivation,
} from "@/components/onboarding/tour/tour-activation";
import {
  createTargetTracker,
  cssAttributeValue,
  observeTourTargets,
  resolveAnchor,
  resolveHistoryRow,
  resolvePanelTarget,
  type TargetResolution,
  type TourSurfaceScope,
} from "@/components/onboarding/tour/tour-targets";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  selectActiveStep,
  useOnboardingFlowStore,
  type ActiveStep,
  type AdvanceReason,
  type ChainStatus,
  type OnboardingContext,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import {
  BRANCH_TOUR_ORDER,
  type OnboardingBranch,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import {
  useLandingReceiptsStore,
  type LandingAttemptDispatch,
  type LandingReceipt,
} from "@/stores/onboarding/landing-receipts-store";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import {
  sessionImportRunFor,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabRefKey } from "@/stores/tabs/layout";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";

/**
 * The spotlight tour's controller: everything that decides WHAT Joyride
 * shows and what the flow store does about Joyride's events. The flow store
 * (`onboarding-flow-store.ts`) stays the one progress authority - this hook
 * never keeps a second copy of the step, only in-memory presentation state
 * (which node, whether the card is anchored, a renderer epoch) that a
 * persisted DOM handle could never be.
 *
 * Shape, in one breath: the active tour and its branch order give a
 * controlled `stepIndex`; a scoped resolver picks the target node and bumps
 * an `epoch` (the `<Joyride>` key) whenever the CHOSEN node changes so the
 * card re-presents (spike finding F5); `run` drops while any modal is
 * presented and resumes one macrotask later (F2); Joyride's events are
 * mapped to the store's guarded actions (`advance` / `pauseChain` /
 * `skipChain`) with the stale-event guards the spike measured (F1, F3); and
 * each lesson's own success predicate auto-advances from real store facts -
 * a new folder path, a terminal composer mode, an accepted-create receipt, a
 * user-opened epic - never from clicks or routes.
 */

export type TourPresentation =
  | "idle"
  | "resolving"
  | "presenting"
  | "unanchored"
  | "modal-suspended";

export interface OnboardingTourController {
  /** Joyride's `run`. */
  readonly run: boolean;
  /** Joyride's `steps` (one per tour of the chain's order). */
  readonly steps: Step[];
  /** Joyride's controlled `stepIndex`. */
  readonly stepIndex: number;
  /** `key` for `<Joyride>`: a new value re-presents the active lesson. */
  readonly epoch: number;
  readonly presentation: TourPresentation;
  /** A counted modal or the folder picker owns the screen (and Esc). */
  readonly modalSuspended: boolean;
  readonly reducedMotion: boolean;
  readonly onEvent: (data: EventData) => void;
  /** Polite live-region text for the step that just presented. */
  readonly announcement: string | null;
}

type SuspensionState = "suspended" | "clearing" | "settled";

function readSuspended(): boolean {
  return (
    selectPresentedModalCount(useModalPresenceStore.getState()) > 0 ||
    useRemoteFolderPickerStore.getState().open
  );
}

interface SuspensionGate {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SuspensionState;
  /** Watch the modal count and the picker; returns stop. */
  readonly start: () => () => void;
}

/**
 * "A counted modal or the folder picker owns the screen", plus the one
 * macrotask of grace after it stops (spike finding F2): Radix handles the
 * Escape that closes a modal in a document capture listener, React flushes
 * the resulting commit in the microtask checkpoint between listeners, and a
 * `run=true` in that commit would re-arm Joyride's body keydown listener in
 * time for the SAME keydown to bubble to it and pause the tour. An external
 * store, like the target tracker, so the React side only reads it.
 */
function createSuspensionGate(): SuspensionGate {
  let state: SuspensionState = readSuspended() ? "suspended" : "settled";
  const listeners = new Set<() => void>();
  const publish = (next: SuspensionState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    start: () => {
      let timer: number | null = null;
      const onChange = (): void => {
        if (readSuspended()) {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
          publish("suspended");
          return;
        }
        if (state === "settled" || timer !== null) return;
        publish("clearing");
        timer = window.setTimeout(() => {
          timer = null;
          publish("settled");
        }, 0);
      };
      const unsubscribeModals = useModalPresenceStore.subscribe(onChange);
      const unsubscribePicker = useRemoteFolderPickerStore.subscribe(onChange);
      onChange();
      return () => {
        unsubscribeModals();
        unsubscribePicker();
        if (timer !== null) window.clearTimeout(timer);
      };
    },
  };
}

const LANDING_TOURS: ReadonlyArray<TourId> = [
  "add-folder",
  "terminal-mode",
  "submit-prompt",
  "history",
];

/**
 * Esc / Pause tour in THIS window's lifetime. The flow store persists the
 * paused checkpoint; this keeps the host that mounts the tour from resuming
 * it in the same launch (resume is next-launch-only, ticket 4).
 */
let dismissedThisLaunch = false;

export function wasTourDismissedThisLaunch(): boolean {
  return dismissedThisLaunch;
}

export function resetTourDismissalForTests(): void {
  dismissedThisLaunch = false;
}

function trackStep(tour: TourId, step: string, action: "next" | "auto" | "skip" | "pause"): void {
  Analytics.getInstance().track(AnalyticsEvent.OnboardingTourStep, {
    tour,
    step,
    action,
  });
}

function chainOrder(
  scope: "branch" | "single",
  branch: OnboardingBranch | null,
  active: TourId | null,
): ReadonlyArray<TourId> {
  if (active === null) return [];
  if (scope === "single" || branch === null) return [active];
  const order = BRANCH_TOUR_ORDER[branch];
  return order.includes(active) ? order : [active];
}

function refKey(ref: TabRef | null): string | null {
  return ref === null ? null : tabRefKey(ref);
}

/** The epic header tab for a focused epic ref, for its epic id and host. */
function epicTabFor(
  ref: TabRef,
): { readonly epicId: string; readonly tabId: string; readonly hostId: string | null } | null {
  if (ref.kind !== "epic") return null;
  const tab = getHeaderTabs().find(
    (candidate) => candidate.kind === "epic" && candidate.id === ref.id,
  );
  if (tab === undefined || tab.kind !== "epic") return null;
  return { epicId: tab.epicId, tabId: tab.id, hostId: tab.hostId };
}

function epicSurfaceMounted(tabId: string): boolean {
  return (
    document.querySelector(`[data-epic-surface="${cssAttributeValue(tabId)}"]`) !==
    null
  );
}

function receiptMatchesContext(
  receipt: LandingReceipt,
  context: OnboardingContext,
): boolean {
  return (
    receipt.attemptId === context.attemptId &&
    receipt.draftId === context.draftId &&
    (context.hostId === null || receipt.hostId === context.hostId)
  );
}

export function useOnboardingTourController(): OnboardingTourController {
  const flow = useOnboardingFlowStore(
    useShallow((state) => ({
      chain: state.chain,
      chainScope: state.chainScope,
      branch: state.branch,
      activeTourId: state.activeTourId,
      stepId:
        state.activeTourId === null
          ? null
          : (selectActiveStep(state)?.stepId ?? null),
      context: state.context,
    })),
  );
  const context = flow.context;
  const draftId = context?.draftId ?? null;
  const tabId = context?.tabId ?? null;
  const hostId = context?.hostId ?? null;
  const attemptId = context?.attemptId ?? null;
  const chainActive = flow.chain === "active";
  const activeTourId = flow.activeTourId;
  const stepId = flow.stepId;
  const active = useMemo<ActiveStep | null>(
    () =>
      activeTourId === null || stepId === null
        ? null
        : { tourId: activeTourId, stepId },
    [activeTourId, stepId],
  );

  const reducedMotion = useReducedMotion() === true;

  // ── Suspension gate (F2) ────────────────────────────────────────────────
  const [gate] = useState(createSuspensionGate);
  const suspension = useSyncExternalStore(
    gate.subscribe,
    gate.getSnapshot,
    gate.getSnapshot,
  );
  useEffect(() => gate.start(), [gate]);
  const modalSuspended = suspension === "suspended";
  const run = chainActive && active !== null && suspension === "settled";

  // ── Activation token ────────────────────────────────────────────────────
  // See `tour-activation.ts`: moves synchronously with a chain start / pause
  // / end / replay or an identity change, and drops pending receipts.
  useEffect(() => {
    startActivationWatch();
  }, []);
  const activation = useSyncExternalStore(
    subscribeActivation,
    getActivationToken,
    getActivationToken,
  );

  // ── Presence ────────────────────────────────────────────────────────────
  const setTourBusy = useOnboardingPresenceStore((state) => state.setTourBusy);
  useEffect(() => {
    setTourBusy(chainActive);
    return () => {
      setTourBusy(false);
    };
  }, [chainActive, setTourBusy]);

  // ── Context capture: which draft / epic the lessons are about ───────────
  const focusedRef = useTabsStore(useShallow(selectHostFocusedRef));
  const setContext = useOnboardingFlowStore((state) => state.setContext);
  useEffect(() => {
    if (!chainActive || activeTourId === null || focusedRef === null) return;
    if (LANDING_TOURS.includes(activeTourId)) {
      if (draftId === null && focusedRef.kind === "draft") {
        setContext({ draftId: focusedRef.id });
      }
      return;
    }
    if (activeTourId === "task-panels" && tabId === null) {
      const tab = epicTabFor(focusedRef);
      if (tab !== null) setContext(tab);
    }
  }, [chainActive, activeTourId, draftId, tabId, focusedRef, setContext]);

  // ── Lesson inputs (real stores) ─────────────────────────────────────────
  const draft = useLandingDraftStore(
    useShallow((state) =>
      draftId === null
        ? null
        : (state.drafts.find((candidate) => candidate.id === draftId) ?? null),
    ),
  );
  const draftFolders = draft?.workspace.folders ?? null;
  const bucketFolders = useWorkspaceFoldersStore((state) =>
    draftFolders === null
      ? selectWorkspaceFoldersBucket(state, hostId).folders
      : null,
  );
  const folders = draftFolders ?? bucketFolders ?? null;
  const settingsComposerMode = useSettingsStore((state) => state.composerMode);
  const composerMode = draft === null ? null : (draft.composerMode ?? settingsComposerMode);
  const receipt = useLandingReceiptsStore((state) =>
    attemptId === null ? undefined : state.byAttemptId[attemptId],
  );
  const dispatchSequence = useLandingReceiptsStore(
    (state) => state.dispatchSequence,
  );
  const pendingAttempt = useLandingReceiptsStore((state) =>
    attemptId !== null && attemptId in state.dispatchedByAttemptId,
  );
  const importedEpicIds = useSessionImportRunStore(
    useShallow((state) => {
      const run = sessionImportRunFor(state, hostId);
      const ids: string[] = [];
      for (const entry of run.outcomes.values()) {
        if (entry.outcome.kind === "imported") ids.push(entry.outcome.epicId);
      }
      return ids;
    }),
  );
  const unseenEpicIds = useImportedUnseenStore(
    useShallow((state) => Object.keys(state.unseen)),
  );
  const historyEpicIds = useMemo(
    () => [...importedEpicIds, ...unseenEpicIds],
    [importedEpicIds, unseenEpicIds],
  );

  // ── Target resolution + presentation epoch ──────────────────────────────
  const [tracker] = useState(createTargetTracker);
  const target = useSyncExternalStore(
    tracker.subscribe,
    tracker.getSnapshot,
    tracker.getSnapshot,
  );
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const historyEpicIdsRef = useRef(historyEpicIds);
  useEffect(() => {
    historyEpicIdsRef.current = historyEpicIds;
  }, [historyEpicIds]);

  const resolveTarget = useCallback(
    (tourId: TourId): TargetResolution => {
      if (tourId === "task-panels") {
        const scope: TourSurfaceScope | null =
          tabId === null ? null : { kind: "epic", tabId };
        return {
          node: scope === null ? null : resolvePanelTarget(scope),
          scrollNode: null,
        };
      }
      const scope: TourSurfaceScope | null =
        draftId === null ? null : { kind: "draft", draftId };
      if (scope === null) return { node: null, scrollNode: null };
      if (tourId === "submit-prompt") {
        // While the composer is in terminal mode Send is not rendered; the
        // mode switch is the alternate presentation target of the same step.
        return {
          node:
            resolveAnchor(scope, "landing-send") ??
            resolveAnchor(scope, "landing-terminal-switch"),
          scrollNode: null,
        };
      }
      if (tourId === "history") {
        // Unresolved until the first imported/unseen row is mounted
        // (decision 19): unrelated rows already in the list are not the
        // lesson's, and without a row the timeout fallback must run.
        const row = resolveHistoryRow(scope, historyEpicIdsRef.current);
        if (row === null) return { node: null, scrollNode: null };
        return { node: resolveAnchor(scope, "landing-history"), scrollNode: row };
      }
      return {
        node: resolveAnchor(scope, TOUR_LESSONS[tourId].anchor),
        scrollNode: null,
      };
    },
    [draftId, tabId],
  );

  // One tracked lesson at a time, keyed by lesson + context so a new lesson
  // (or a new draft/tab for it) starts fresh under a new renderer epoch.
  const lessonKey =
    chainActive && active !== null
      ? `${active.tourId}|${active.stepId}|${draftId ?? ""}|${tabId ?? ""}`
      : null;
  useEffect(() => {
    if (lessonKey === null || active === null) {
      tracker.reset();
      return undefined;
    }
    const tourId = active.tourId;
    return tracker.track(lessonKey, () => resolveTarget(tourId));
    // `historyEpicIds` re-resolves the history row when imports land.
  }, [lessonKey, active, resolveTarget, tracker, historyEpicIds]);

  // ── Joyride props ───────────────────────────────────────────────────────
  const order = useMemo(
    () => chainOrder(flow.chainScope, flow.branch, activeTourId),
    [flow.chainScope, flow.branch, activeTourId],
  );
  const stepIndex = Math.max(
    0,
    activeTourId === null ? 0 : order.indexOf(activeTourId),
  );
  const epoch = target.epoch;
  const steps = useMemo<Step[]>(() => {
    if (activeTourId === null) return [];
    // A snapshot resolved for a previous lesson/context never anchors this
    // one: until the tracker has re-resolved, the step resolves to nothing
    // (Joyride waits) rather than to the previous lesson's node.
    const fresh = target.key === lessonKey;
    const node = fresh ? target.node : null;
    const scrollNode = fresh ? target.scrollNode : null;
    const stepPresentation: StepPresentation =
      fresh && target.unanchored
        ? { kind: "unanchored" }
        : {
            kind: "anchored",
            target: () => node,
            scrollTarget: scrollNode === null ? null : () => scrollNode,
          };
    return buildTourSteps(order, activeTourId, stepPresentation);
  }, [order, activeTourId, target, lessonKey]);

  // ── Focus origin, restored on pause / end only ──────────────────────────
  const originRef = useRef<HTMLElement | null>(null);
  const previousRun = useRef(false);
  useEffect(() => {
    if (run && !previousRun.current) {
      const activeElement = document.activeElement;
      originRef.current =
        activeElement instanceof HTMLElement &&
        activeElement.closest("#react-joyride-portal") === null
          ? activeElement
          : null;
    }
    previousRun.current = run;
  }, [run]);
  const previousChain = useRef<ChainStatus>(flow.chain);
  useEffect(() => {
    const before = previousChain.current;
    previousChain.current = flow.chain;
    if (before !== "active" || flow.chain === "active") return;
    if (flow.chain === "completed" || flow.chain === "skipped") {
      if (flow.branch !== null) {
        Analytics.getInstance().track(AnalyticsEvent.OnboardingChainEnded, {
          reason: flow.chain,
          branch: flow.branch,
        });
      }
    }
    const origin = originRef.current;
    originRef.current = null;
    if (origin === null) return;
    requestAnimationFrame(() => {
      if (origin.isConnected && origin.checkVisibility()) {
        origin.focus({ preventScroll: true });
      }
    });
  }, [flow.chain, flow.branch]);

  // ── Event adapter (guarded) ─────────────────────────────────────────────
  const guardedAdvance = useCallback(
    (tourId: TourId, expectedStepId: string, reason: AdvanceReason) => {
      const store = useOnboardingFlowStore.getState();
      const current = selectActiveStep(store);
      if (
        store.chain !== "active" ||
        current === null ||
        current.tourId !== tourId ||
        current.stepId !== expectedStepId
      ) {
        return false;
      }
      store.advance(tourId, expectedStepId, reason);
      const after = selectActiveStep(useOnboardingFlowStore.getState());
      const advanced =
        useOnboardingFlowStore.getState().chain !== "active" ||
        after === null ||
        after.tourId !== tourId ||
        after.stepId !== expectedStepId;
      if (advanced) {
        trackStep(tourId, expectedStepId, reason === "detour" ? "auto" : reason);
      }
      return advanced;
    },
    [],
  );

  const onEvent = useCallback(
    (data: EventData) => {
      // Closed over the epoch and ids this renderer was built for: a late
      // event from a replaced renderer, a stale replay or another lesson
      // reaches no store action.
      if (getActivationToken() !== activation) return;
      if (tracker.getSnapshot().epoch !== epoch || active === null) return;
      if (data.step.id !== active.tourId) return;
      const store = useOnboardingFlowStore.getState();
      const current = selectActiveStep(store);
      if (
        store.chain !== "active" ||
        current === null ||
        current.tourId !== active.tourId ||
        current.stepId !== active.stepId
      ) {
        return;
      }
      switch (data.type) {
        case EVENTS.TOOLTIP: {
          tracker.markPresented();
          setAnnouncement(
            `Step ${data.index + 1} of ${data.size}: ${tourLessonTitle(active.tourId)}`,
          );
          return;
        }
        case EVENTS.TARGET_NOT_FOUND: {
          // F4: upstream leaves a full dim with no card here. Same lesson,
          // centred card, no cutout; progress untouched.
          tracker.markUnanchored();
          return;
        }
        case EVENTS.STEP_AFTER: {
          // F1: a suspension (`run` -> false) emits step:after with the LAST
          // tracked action and status "paused". Only a running step counts.
          if (data.status !== STATUS.RUNNING) return;
          if (data.action === ACTIONS.NEXT) {
            guardedAdvance(active.tourId, active.stepId, "next");
          } else if (data.action === ACTIONS.CLOSE) {
            dismissedThisLaunch = true;
            trackStep(active.tourId, active.stepId, "pause");
            store.pauseChain();
          }
          return;
        }
        case EVENTS.TOUR_END: {
          // F3: Skip emits no step:after; tour:end/skipped is the signal.
          // A finished tour:end is Joyride's own bookkeeping after the last
          // Next already advanced the flow, and changes nothing.
          if (data.status === STATUS.SKIPPED) {
            trackStep(active.tourId, active.stepId, "skip");
            store.skipChain();
          }
          return;
        }
        default:
          return;
      }
    },
    [activation, epoch, active, guardedAdvance, tracker],
  );

  // ── Lesson predicates ───────────────────────────────────────────────────

  // add-folder: a path absent at lesson entry is now present. Baseline per
  // lesson + context; a picker suspension keeps it, a new context / replay /
  // relaunch resets it. Length is not the signal (the 50-folder cap can keep
  // the count equal while a path changes; a re-added existing path is not
  // new).
  const folderBaselineRef = useRef<{ key: string; paths: ReadonlySet<string> } | null>(null);
  const folderBaselineKey =
    chainActive && activeTourId === "add-folder"
      ? `${activation}|${activeTourId}|${draftId ?? ""}|${hostId ?? ""}`
      : null;
  useEffect(() => {
    if (folderBaselineKey === null) {
      folderBaselineRef.current = null;
      return;
    }
    if (folderBaselineRef.current?.key !== folderBaselineKey) {
      folderBaselineRef.current = {
        key: folderBaselineKey,
        paths: new Set(folders ?? []),
      };
      return;
    }
    if (active === null || pendingAttempt || folders === null) return;
    const baseline = folderBaselineRef.current.paths;
    if (!folders.some((path) => !baseline.has(path))) return;
    guardedAdvance(active.tourId, active.stepId, "auto");
  }, [folderBaselineKey, folders, pendingAttempt, active, guardedAdvance]);

  // terminal-mode: the bound draft's composer is in terminal mode (already
  // there at entry counts too). Never resets the mode.
  useEffect(() => {
    if (!chainActive || active === null || active.tourId !== "terminal-mode") return;
    if (pendingAttempt || composerMode !== "terminal") return;
    guardedAdvance(active.tourId, active.stepId, "auto");
  }, [chainActive, active, pendingAttempt, composerMode, guardedAdvance]);

  // Attempt capture: a landing create announced for THIS draft while the
  // lesson that waits on it is active. Prompt receipts matter to the prompt
  // lesson; a terminal Start (A2 detour) matters to mode and prompt alike.
  useEffect(() => {
    if (!chainActive || active === null || draftId === null) return;
    const state = useLandingReceiptsStore.getState();
    const dispatches = Object.values(state.dispatchedByAttemptId);
    const latest: LandingAttemptDispatch | undefined =
      dispatches[dispatches.length - 1];
    if (latest === undefined || latest.draftId !== draftId) return;
    // The lesson is bound to a host for life: an attempt on another host is
    // not this lesson's, however the draft matches.
    if (hostId !== null && latest.hostId !== hostId) return;
    if (latest.attemptId === attemptId) return;
    // Both landing lessons wait on both kinds: a Start is the A2 detour, a
    // sent prompt during the mode lesson completes mode AND prompt.
    const relevant =
      active.tourId === "submit-prompt" || active.tourId === "terminal-mode";
    if (!relevant) return;
    setContext({ attemptId: latest.attemptId, hostId: latest.hostId });
  }, [chainActive, active, draftId, hostId, attemptId, dispatchSequence, setContext]);

  // Accepted receipts: prompt-accepted completes the prompt lesson (and,
  // arriving during the mode lesson, completes mode and prompt both - the
  // user sent a real prompt); tui-accepted (accepted Start) detours mode or
  // prompt to the panels. Every id must match; a receipt is consumed once.
  useEffect(() => {
    if (!chainActive || active === null || context === null) return;
    if (receipt === undefined || !receiptMatchesContext(receipt, context)) return;
    const tourId = active.tourId;
    if (tourId !== "terminal-mode" && tourId !== "submit-prompt") return;
    useLandingReceiptsStore.getState().consume(receipt.attemptId);
    setContext({
      epicId: receipt.epicId,
      tabId: receipt.tabId,
      hostId: receipt.hostId,
      attemptId: null,
    });
    if (receipt.kind === "tui-accepted") {
      guardedAdvance(tourId, active.stepId, "detour");
      return;
    }
    guardedAdvance(tourId, active.stepId, "auto");
    if (tourId === "terminal-mode") {
      const following = selectActiveStep(useOnboardingFlowStore.getState());
      if (following !== null && following.tourId === "submit-prompt") {
        guardedAdvance(following.tourId, following.stepId, "auto");
      }
    }
  }, [chainActive, active, context, receipt, setContext, guardedAdvance]);

  // history: the user opened a task - the focused ref became an epic that
  // was NOT focused at lesson entry, and its surface is mounted. A restored
  // unrelated epic already focused at entry is not that.
  const historyBaselineRef = useRef<string | null>(null);
  const historyEntryKey =
    chainActive && activeTourId === "history"
      ? `${activation}|history|${draftId ?? ""}`
      : null;
  useEffect(() => {
    if (historyEntryKey === null) {
      historyBaselineRef.current = null;
      return undefined;
    }
    if (historyBaselineRef.current === null) {
      historyBaselineRef.current =
        refKey(selectHostFocusedRef(useTabsStore.getState())) ?? "";
    }
    const check = (): void => {
      if (active === null) return;
      const focused = selectHostFocusedRef(useTabsStore.getState());
      if (focused === null || focused.kind !== "epic") return;
      if (refKey(focused) === historyBaselineRef.current) return;
      if (!epicSurfaceMounted(focused.id)) return;
      const tab = epicTabFor(focused);
      if (tab === null) return;
      setContext(tab);
      guardedAdvance(active.tourId, active.stepId, "auto");
    };
    check();
    const unsubscribe = useTabsStore.subscribe(check);
    const stopObserving = observeTourTargets(check);
    return () => {
      unsubscribe();
      stopObserving();
    };
  }, [historyEntryKey, active, setContext, guardedAdvance]);

  const presentationOut: TourPresentation =
    !chainActive || active === null
      ? "idle"
      : modalSuspended
        ? "modal-suspended"
        : target.key !== lessonKey
          ? "resolving"
          : target.unanchored
            ? "unanchored"
            : target.presented
              ? "presenting"
              : "resolving";

  return {
    run,
    steps,
    stepIndex,
    epoch,
    presentation: presentationOut,
    modalSuspended,
    reducedMotion,
    onEvent,
    announcement,
  };
}
