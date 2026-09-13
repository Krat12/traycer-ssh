import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { EventData, Props as JoyrideProps } from "react-joyride";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingTour } from "@/components/onboarding/tour/onboarding-tour";
import {
  resetTourDismissalForTests,
  wasTourDismissedThisLaunch,
} from "@/components/onboarding/tour/use-onboarding-tour-controller";
import type { TourAnchor } from "@/components/onboarding/tour/tour-targets";
import {
  registerPresentedModal,
  resetModalPresenceForTests,
} from "@/components/ui/modal-presence";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

/**
 * The controller against the REAL stores (flow, receipts, drafts, tabs,
 * modal presence, picker) with only Joyride faked - the fake records the
 * props the controller hands it and lets a test fire the exact events
 * react-joyride 3.2 emits (including the stale ones the spike measured:
 * F1's paused `step:after`, F3's `tour:end`-only skip). Geometry is not
 * under test here (the spike and the real-Joyride smoke test cover it);
 * jsdom's `checkVisibility` / `getBoundingClientRect` are stubbed so the
 * resolver's presentability filter can answer.
 */

const joyride = vi.hoisted(() => ({
  props: null as JoyrideProps | null,
  mounts: 0,
}));

vi.mock("react-joyride", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-joyride")>();
  function FakeJoyride(props: JoyrideProps): null {
    joyride.props = props;
    useEffect(() => {
      joyride.mounts += 1;
    }, []);
    return null;
  }
  return { ...actual, Joyride: FakeJoyride };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: { getInstance: () => ({ track: analyticsTrack }) },
  };
});
const analyticsTrack = vi.hoisted(() => vi.fn());

const DRAFT_ID = "draft-tour";
const HOST_ID = "host-tour";
const EPIC_TAB_ID = "tab-epic-1";
const EPIC_ID = "epic-1";

function props(): JoyrideProps {
  if (joyride.props === null) throw new Error("Joyride not rendered");
  return joyride.props;
}

function currentProps(): JoyrideProps {
  return props();
}

/** Fires an event the way react-joyride 3.2 would for the current step. */
function emit(
  overrides: Partial<EventData> & { readonly type: EventData["type"] },
  from: JoyrideProps,
): void {
  const stepIndex = from.stepIndex ?? 0;
  const step = from.steps[stepIndex];
  if (step === undefined) throw new Error("no step at index");
  const data: EventData = {
    type: overrides.type,
    action: overrides.action ?? "update",
    status: overrides.status ?? "running",
    lifecycle: overrides.lifecycle ?? "tooltip",
    index: overrides.index ?? stepIndex,
    size: from.steps.length,
    origin: overrides.origin ?? null,
    controlled: true,
    scrolling: false,
    waiting: false,
    error: null,
    scroll: null,
    step: overrides.step ?? {
      ...step,
      arrowBase: 32,
      arrowColor: "#fff",
      arrowSize: 16,
      arrowSpacing: 12,
      backgroundColor: "#fff",
      beaconSize: 36,
      beaconTrigger: "click",
      beforeTimeout: 5000,
      buttons: ["primary", "skip", "close"],
      closeButtonAction: "close",
      skipBeacon: true,
      dismissKeyAction: "close",
      disableFocusTrap: true,
      hideOverlay: false,
      skipScroll: false,
      blockTargetInteraction: false,
      isFixed: false,
      loaderDelay: 300,
      locale: {},
      offset: 10,
      overlayClickAction: false,
      overlayColor: "#000",
      placement: step.placement ?? "bottom",
      primaryColor: "#000",
      scrollDuration: 300,
      scrollOffset: 20,
      showProgress: false,
      spotlightRadius: 8,
      targetWaitTimeout: 8000,
      textColor: "#000",
      zIndex: 45,
      spotlightPadding: { top: 8, right: 8, bottom: 8, left: 8 },
      styles: {
        arrow: {},
        beacon: {},
        beaconInner: {},
        beaconOuter: {},
        beaconWrapper: {},
        buttonBack: {},
        buttonClose: {},
        buttonPrimary: {},
        buttonSkip: {},
        floater: {},
        loader: {},
        overlay: {},
        spotlight: {},
        tooltip: {},
        tooltipContainer: {},
        tooltipContent: {},
        tooltipFooter: {},
        tooltipFooterSpacer: {},
        tooltipTitle: {},
      },
    },
  };
  act(() => {
    from.onEvent?.(data, {
      close: () => undefined,
      go: () => undefined,
      info: () => {
        throw new Error("unused");
      },
      next: () => undefined,
      open: () => undefined,
      prev: () => undefined,
      replay: () => undefined,
      reset: () => undefined,
      skip: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    });
  });
}

/** A DOM change plus the microtask the MutationObserver delivers on. */
async function mutate(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

function next(): void {
  emit({ type: "step:after", action: "next", origin: "button_primary" }, currentProps());
}

function present(): void {
  emit({ type: "tooltip" }, currentProps());
}

// ── DOM fixtures ────────────────────────────────────────────────────────────

function sized(element: HTMLElement): HTMLElement {
  element.getBoundingClientRect = () => new DOMRect(10, 10, 120, 32);
  return element;
}

interface Surface {
  readonly root: HTMLElement;
  readonly anchors: Readonly<Record<string, HTMLElement>>;
  readonly remove: () => void;
}

function mountDraftSurface(
  draftId: string,
  anchors: ReadonlyArray<TourAnchor>,
  visible: boolean,
): Surface {
  const surface = document.createElement("div");
  surface.setAttribute("data-surface-ref", `draft:${draftId}`);
  surface.setAttribute("data-visible", visible ? "true" : "false");
  const root = sized(document.createElement("div"));
  root.setAttribute("data-testid", "landing-draft-surface");
  surface.append(root);
  const made: Record<string, HTMLElement> = {};
  for (const anchor of anchors) {
    const node = sized(document.createElement("button"));
    node.setAttribute("data-tour", anchor);
    node.textContent = anchor;
    root.append(node);
    made[anchor] = node;
  }
  document.body.append(surface);
  return {
    root,
    anchors: made,
    remove: () => {
      surface.remove();
    },
  };
}

function mountEpicSurface(tabId: string, collapsed: boolean): Surface {
  const surface = document.createElement("div");
  surface.setAttribute("data-surface-ref", `epic:${tabId}`);
  surface.setAttribute("data-visible", "true");
  const root = sized(document.createElement("div"));
  root.setAttribute("data-epic-surface", tabId);
  surface.append(root);
  const column = sized(document.createElement("div"));
  column.setAttribute("data-tour", "epic-sidebar-column");
  const rail = sized(document.createElement("div"));
  rail.setAttribute("data-tour", "epic-sidebar-rail");
  if (collapsed) column.hidden = true;
  root.append(column, rail);
  document.body.append(surface);
  return {
    root,
    anchors: { column, rail },
    remove: () => {
      surface.remove();
    },
  };
}

function focusDraftTab(draftId: string): void {
  const ref = { kind: "draft" as const, id: draftId };
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
}

function focusEpicTab(tabId: string, epicId: string): void {
  const ref = { kind: "epic" as const, id: tabId };
  useEpicCanvasStore.setState({
    tabsById: { [tabId]: { tabId, epicId, name: "Epic" } },
    openTabOrder: [tabId],
    activeTabId: tabId,
    mostRecentTabIdByEpicId: { [epicId]: tabId },
  });
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
}

function startChain(branch: "no-sessions" | "sessions"): void {
  act(() => {
    useOnboardingFlowStore.getState().finishModal(branch);
    useOnboardingFlowStore.getState().setContext({ draftId: DRAFT_ID, hostId: HOST_ID });
  });
}

function flow() {
  return useOnboardingFlowStore.getState();
}

function folderInfo(path: string) {
  return { path, name: path, repoIdentifier: null, hostId: HOST_ID };
}

const surfaces: Surface[] = [];
function keep(surface: Surface): Surface {
  surfaces.push(surface);
  return surface;
}

beforeEach(() => {
  window.localStorage.clear();
  joyride.props = null;
  joyride.mounts = 0;
  analyticsTrack.mockClear();
  resetTourDismissalForTests();
  resetModalPresenceForTests();
  useOnboardingFlowStore.setState({ ...INITIAL_FLOW });
  useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
  useLandingReceiptsStore.getState().reset();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useTabsStore.setState({
    items: [],
    activeItemId: null,
    systemTabs: { history: null, settings: null },
    stripOrder: [],
  });
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
  });
  useSettingsStore.setState({ composerMode: "chat" });
  useRemoteFolderPickerStore.getState().settle(null);
  if (typeof Element.prototype.checkVisibility !== "function") {
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) {
        return !this.closest("[hidden]");
      },
    });
  }
  useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
  focusDraftTab(DRAFT_ID);
});

afterEach(() => {
  cleanup();
  for (const surface of surfaces.splice(0)) surface.remove();
});

describe("run gating and controlled props", () => {
  it("renders nothing while the chain is not active", () => {
    render(<OnboardingTour />);
    expect(joyride.props).toBeNull();
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
  });

  it("runs the active chain: stepIndex is the tour's position in the branch order, tourBusy is on", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const p = props();
    expect(p.run).toBe(true);
    expect(p.stepIndex).toBe(0);
    expect(p.steps.map((step) => step.id)).toEqual([
      "add-folder",
      "terminal-mode",
      "submit-prompt",
      "task-panels",
    ]);
    expect(p.continuous).toBe(true);
    expect(p.options?.disableFocusTrap).toBe(true);
    expect(p.options?.overlayClickAction).toBe(false);
    expect(p.options?.zIndex).toBe(45);
    expect(p.options?.targetWaitTimeout).toBe(8000);
    expect(p.options?.dismissKeyAction).toBe("close");
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
  });

  it("a Settings replay is a one-step order", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      flow().replayTour("task-panels");
    });
    expect(props().steps.map((step) => step.id)).toEqual(["task-panels"]);
    expect(props().stepIndex).toBe(0);
  });

  it("suspends while a modal is presented or the picker is open, and resumes one macrotask after they clear (F2)", async () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    expect(props().run).toBe(true);
    let release: () => void = () => undefined;
    act(() => {
      release = registerPresentedModal();
    });
    expect(props().run).toBe(false);
    expect(props().options?.dismissKeyAction).toBe(false);
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
    act(() => {
      release();
    });
    // Same task: still suspended.
    expect(props().run).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(props().run).toBe(true);
    expect(props().options?.dismissKeyAction).toBe("close");

    act(() => {
      useRemoteFolderPickerStore.setState({ open: true });
    });
    expect(props().run).toBe(false);
    act(() => {
      useRemoteFolderPickerStore.setState({ open: false });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(props().run).toBe(true);
    // The lesson never moved through any of it.
    expect(flow().activeTourId).toBe("add-folder");
  });
});

describe("event adapter", () => {
  it("Next (step:after / next / running) advances the expected step and tracks it", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add", "landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    present();
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["add-folder"].status).toBe("done");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "next",
    });
    expect(props().stepIndex).toBe(1);
  });

  it("ignores a step:after carrying a stale action during suspension (F1)", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit({ type: "step:after", action: "next", status: "paused" }, currentProps());
    expect(flow().activeTourId).toBe("add-folder");
    expect(analyticsTrack).not.toHaveBeenCalled();
  });

  it("ignores a duplicate / late event for a step that already advanced", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add", "landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const before = currentProps();
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
    // The same event again, from the renderer that was built for add-folder.
    emit({ type: "step:after", action: "next", origin: "button_primary" }, before);
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["terminal-mode"].status).toBe("active");
  });

  it("ignores events from a replaced renderer (old epoch)", async () => {
    const surface = keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const old = currentProps();
    // Detach the target: the resolver re-presents under a new epoch.
    await mutate(() => {
      surface.anchors["landing-folder-add"]?.remove();
    });
    expect(currentProps().onEvent).not.toBe(old.onEvent);
    // A replay of the old renderer's Next must not advance anything.
    emit({ type: "step:after", action: "next", origin: "button_primary" }, old);
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("Esc / Pause tour (step:after / close) pauses the chain at its step and marks the launch", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit({ type: "step:after", action: "close", origin: "keyboard" }, currentProps());
    expect(flow().chain).toBe("paused");
    expect(flow().activeTourId).toBe("add-folder");
    expect(wasTourDismissedThisLaunch()).toBe(true);
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "pause",
    });
    expect(joyride.props?.run ?? false).toBe(false);
  });

  it("Skip arrives as tour:end/skipped only (F3) and ends the chain for good", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit({ type: "tour:end", action: "skip", status: "skipped", origin: "button_skip" }, currentProps());
    expect(flow().chain).toBe("skipped");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "skip",
    });
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_chain_ended", {
      reason: "skipped",
      branch: "no-sessions",
    });
  });

  it("a finished tour:end after the last Next changes nothing the flow did not already do", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      // A replay from Settings after the branch chain ran.
      flow().finishModal("no-sessions");
      flow().skipChain();
      flow().replayTour("task-panels");
    });
    const p = currentProps();
    next();
    expect(flow().chain).toBe("completed");
    emit({ type: "tour:end", action: "next", status: "finished" }, p);
    expect(flow().chain).toBe("completed");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_chain_ended", {
      reason: "completed",
      branch: "no-sessions",
    });
    expect(analyticsTrack).toHaveBeenCalledTimes(2);
  });
});

describe("targets and presentation", () => {
  it("resolves the anchor inside the VISIBLE surface of the context draft, never a hidden duplicate", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], false));
    const visible = keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    keep(mountDraftSurface("other-draft", ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const step = props().steps[0];
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(visible.anchors["landing-folder-add"]);
    expect(step.placement).toBe("bottom");
  });

  it("keeps resolving (anchored step, null target) while the target is missing; target_not_found swaps in the centred fallback without touching progress", () => {
    render(<OnboardingTour />);
    startChain("no-sessions");
    const step = props().steps[0];
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBeNull();
    const epochBefore = joyride.mounts;
    emit({ type: "error:target_not_found", lifecycle: "ready" }, currentProps());
    const fallback = props().steps[0];
    expect(fallback?.placement).toBe("center");
    expect(fallback?.hideOverlay).toBe(true);
    expect(fallback?.id).toBe("add-folder");
    expect(joyride.mounts).toBeGreaterThan(epochBefore);
    expect(flow().activeTourId).toBe("add-folder");
    // Next on the unanchored card still acknowledges the lesson.
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
  });

  it("a target that detaches after presenting drops to the fallback at once, and returns anchored when it is back", async () => {
    const surface = keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    present();
    const anchor = surface.anchors["landing-folder-add"];
    if (anchor === undefined) throw new Error("anchor missing");
    await mutate(() => {
      anchor.remove();
    });
    expect(props().steps[0]?.placement).toBe("center");
    expect(props().steps[0]?.hideOverlay).toBe(true);
    expect(flow().activeTourId).toBe("add-folder");
    await mutate(() => {
      surface.root.append(anchor);
    });
    const back = props().steps[0];
    if (back === undefined || typeof back.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(back.placement).toBe("bottom");
    expect(back.target()).toBe(anchor);
  });

  it("submit-prompt falls back to the mode switch while terminal mode hides Send", () => {
    const surface = keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    const step = props().steps[props().stepIndex ?? 0];
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(surface.anchors["landing-terminal-switch"]);
  });

  it("task-panels spotlights the column, else the rail, inside the context epic surface; mounting never finishes it", () => {
    const surface = keep(mountEpicSurface(EPIC_TAB_ID, true));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      flow().replayTour("task-panels");
    });
    const step = props().steps[0];
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(surface.anchors.rail);
    expect(flow().context).toMatchObject({ epicId: EPIC_ID, tabId: EPIC_TAB_ID });
    present();
    expect(flow().chain).toBe("active");
    next();
    expect(flow().chain).toBe("completed");
  });
});

describe("lesson predicates", () => {
  it("add-folder: a path absent at entry auto-advances; re-adding an existing one or an equal count does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/a"), folderInfo("/b")]);
    });
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      useLandingDraftStore.getState().removeDraftFolder(DRAFT_ID, "/a");
      useLandingDraftStore.getState().addDraftResolvedFolders(DRAFT_ID, [folderInfo("/a")]);
    });
    expect(flow().activeTourId).toBe("add-folder");
    act(() => {
      useLandingDraftStore.getState().removeDraftFolder(DRAFT_ID, "/b");
      useLandingDraftStore.getState().addDraftResolvedFolders(DRAFT_ID, [folderInfo("/c")]);
    });
    // Count unchanged (2 -> 2), path new.
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "auto",
    });
  });

  it("add-folder: a Settings replay starts a fresh baseline - the folders already there do not count, a new one does", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    act(() => {
      useLandingDraftStore.getState().addDraftResolvedFolders(DRAFT_ID, [folderInfo("/a")]);
    });
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().skipChain();
      flow().replayTour("add-folder");
    });
    // Replay cleared the context; the focused draft is re-captured.
    expect(flow().context?.draftId).toBe(DRAFT_ID);
    expect(flow().activeTourId).toBe("add-folder");
    act(() => {
      useLandingDraftStore.getState().addDraftResolvedFolders(DRAFT_ID, [folderInfo("/b")]);
    });
    expect(flow().chain).toBe("completed");
  });

  it("a Next that races an auto-advance of the same step cannot advance twice", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add", "landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const before = currentProps();
    act(() => {
      useLandingDraftStore.getState().addDraftResolvedFolders(DRAFT_ID, [folderInfo("/new")]);
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    emit({ type: "step:after", action: "next", origin: "button_primary" }, before);
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["terminal-mode"].status).toBe("active");
  });

  it("add-folder: a folder added to a DIFFERENT draft is not this lesson's", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId("other", null);
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      useLandingDraftStore.getState().addDraftResolvedFolders("other", [folderInfo("/x")]);
    });
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("terminal-mode: the bound draft switching to terminal auto-advances; the mode is never reset", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    act(() => {
      useLandingDraftStore.getState().setDraftComposerMode(DRAFT_ID, "terminal");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === DRAFT_ID)?.composerMode,
    ).toBe("terminal");
  });

  it("submit-prompt: only a prompt-accepted receipt matching draft/host/attempt advances and records the destination; optimistic navigation does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-send"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Optimistic navigation to some epic is not acceptance.
    act(() => {
      focusEpicTab("tab-optimistic", "epic-optimistic");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    const receipts = useLandingReceiptsStore.getState();
    // A create for another draft: announced, accepted, irrelevant.
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-other",
        draftId: "other-draft",
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-other",
          draftId: "other-draft",
          epicId: "e-other",
          tabId: "t-other",
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    expect(flow().context?.attemptId).toBeNull();
    // The right attempt on the WRONG host is not this lesson's either.
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-host",
        draftId: DRAFT_ID,
        hostId: "host-other",
      });
    });
    expect(flow().context?.attemptId).toBe("attempt-host");
    act(() => {
      flow().setContext({ hostId: HOST_ID });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-host",
          draftId: DRAFT_ID,
          epicId: "e-host",
          tabId: "t-host",
          hostId: "host-other",
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // This draft's attempt: captured at dispatch...
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-1",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
    });
    expect(flow().context?.attemptId).toBe("attempt-1");
    // ...refused: retired, lesson stays, Next still works.
    act(() => {
      receipts.retire("attempt-1");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Re-sent and accepted this time.
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-2",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-2",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
      hostId: HOST_ID,
      attemptId: null,
    });
    // Consumed once; the unrelated draft's receipt is simply never matched.
    expect(Object.keys(useLandingReceiptsStore.getState().byAttemptId)).toEqual([
      "attempt-other",
      "attempt-host",
    ]);
  });

  it("A2: an accepted terminal Start during terminal-mode detours to the panels and bypasses the prompt; a rejected one keeps the checkpoint", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
    });
    const receipts = useLandingReceiptsStore.getState();
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "tui-accepted",
        attemptId: "start-1",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
    });
    expect(flow().context?.attemptId).toBe("start-1");
    // The pending Start freezes the ordinary mode predicate...
    act(() => {
      useLandingDraftStore.getState().setDraftComposerMode(DRAFT_ID, "terminal");
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    // ...a rejected create keeps the checkpoint and unfreezes it.
    act(() => {
      receipts.retire("start-1");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Start again from the prompt lesson, accepted: detour.
    act(() => {
      generation = receipts.announce({
        kind: "tui-accepted",
        attemptId: "start-2",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "tui-accepted",
          attemptId: "start-2",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().tours["submit-prompt"].status).toBe("bypassed");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "submit-prompt",
      step: "submit-prompt",
      action: "auto",
    });
  });

  it("history: a task the user opens (new focused epic with its surface mounted) advances to the panels with that epic as context; the epic focused at entry does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-history"], true));
    render(<OnboardingTour />);
    startChain("sessions");
    expect(flow().activeTourId).toBe("history");
    // The surface for the epic must be mounted, not just the tab focused.
    act(() => {
      focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    });
    expect(flow().activeTourId).toBe("history");
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    act(() => {
      // Any store tick re-checks; the observer does too.
      useTabsStore.setState({ ...useTabsStore.getState() });
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().context).toMatchObject({ epicId: EPIC_ID, tabId: EPIC_TAB_ID });
  });

  it("history: an epic already focused at entry is not a user-opened transition", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    startChain("sessions");
    act(() => {
      useTabsStore.setState({ ...useTabsStore.getState() });
    });
    expect(flow().activeTourId).toBe("history");
  });
});
