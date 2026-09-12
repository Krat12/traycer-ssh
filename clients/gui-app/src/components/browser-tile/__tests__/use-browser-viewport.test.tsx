import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewportState } from "@traycer/protocol/host/browser/viewport";
import { BrowserViewportToolbar } from "../browser-viewport-toolbar";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  PaneSurfaceActivityContext,
  type PaneSurfaceActivity,
} from "@/components/epic-tabs/pane-visibility-context";
import { useBrowserViewport } from "../use-browser-viewport";

const desktopWindowId = vi.hoisted(() => ({ value: "window-a" }));
const coordinatorSnapshot = vi.hoisted(() => ({
  value: null as BrowserSessionsState | null,
}));

const viewportResizeObservers: ControllableViewportResizeObserver[] = [];

class ControllableViewportResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    viewportResizeObservers.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {}

  disconnect(): void {}

  trigger(): void {
    if (this.target === null) throw new Error("viewport target is not mounted");
    this.callback([], this);
  }
}

function triggerLastViewportResize(): void {
  const observer = viewportResizeObservers.at(-1);
  if (observer === undefined)
    throw new Error("viewport observer is not mounted");
  observer.trigger();
}

vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => desktopWindowId.value,
  readDesktopWindowId: () => desktopWindowId.value,
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
      >();
    return {
      ...actual,
      browserSessionsCoordinatorState: () => coordinatorSnapshot.value,
    };
  },
);

function viewportState(): BrowserViewportState {
  return {
    sessionId: "session-1",
    tabId: "tab-1",
    intent: { mode: "fit" },
    applied: null,
    revision: 1,
    source: "user",
    fitOwnerId: null,
  };
}

function readOnlyViewportState(): BrowserViewportState {
  return {
    ...viewportState(),
    applied: { width: 390, height: 312, dpr: 1 },
  };
}

function fixedViewportState(): BrowserViewportState {
  return {
    ...viewportState(),
    intent: { mode: "fixed", width: 390, height: 844 },
    applied: { width: 390, height: 844, dpr: 1 },
  };
}

function sessionsState(
  setViewport: BrowserSessionsState["setViewport"],
  viewport: BrowserViewportState,
  reportViewport: BrowserSessionsState["reportViewport"],
  releaseViewport: BrowserSessionsState["releaseViewport"],
): BrowserSessionsState {
  return {
    viewports: { "tab-1": viewport },
    setViewport,
    reportViewport,
    releaseViewport,
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: true,
    connectionGeneration: 1,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("unused")),
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.resolve(),
    moveTab: () => Promise.resolve(),
  };
}

function ViewportProbe(): ReactElement {
  const presentation = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    registrationId: null,
    visible: true,
    disabled: false,
    pageZoom: 1,
    native: true,
  });
  const controller = presentation.controller;
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <button type="button" onClick={controller.open}>
        Open viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.reset().catch(() => undefined)}
      >
        Reset viewport
      </button>
      <button
        type="button"
        onClick={() =>
          void controller.resize(1, 1, null).catch(() => undefined)
        }
      >
        Invalid viewport
      </button>
      <button
        type="button"
        onClick={() =>
          void controller.resize(640, 480, null).catch(() => undefined)
        }
      >
        Resize viewport
      </button>
      <button
        type="button"
        onClick={() =>
          void controller.resize(640, 480, null).catch(() => undefined)
        }
      >
        Resize A
      </button>
      <button
        type="button"
        onClick={() =>
          void controller.resize(800, 600, null).catch(() => undefined)
        }
      >
        Resize B
      </button>
      <output data-testid="expanded">
        {controller.expanded ? "expanded" : "collapsed"}
      </output>
      <output data-testid="error">{controller.error ?? ""}</output>
    </>
  );
}

function ToolbarProbe(): ReactElement {
  const { controller } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    registrationId: null,
    visible: true,
    disabled: false,
    pageZoom: 1,
    native: false,
  });
  return (
    <>
      <BrowserViewportToolbar controller={controller} />
      <output data-testid="toolbar-size">
        {controller?.size === null || controller === null
          ? "none"
          : `${controller.size.width}x${controller.size.height}`}
      </output>
    </>
  );
}

function renderProbe(setViewport: BrowserSessionsState["setViewport"]): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          viewportState(),
          () => undefined,
          () => undefined,
        )}
      >
        <ViewportProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

interface MeasuredViewportProbeProps {
  readonly instanceId: string;
  readonly pageZoom: number;
  readonly registrationId: string | null;
  readonly visible: boolean;
}

function MeasuredViewportProbe(
  input: MeasuredViewportProbeProps,
): ReactElement {
  const { areaRef, controller } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: input.instanceId,
    registrationId: input.registrationId,
    visible: input.visible,
    disabled: false,
    pageZoom: input.pageZoom,
    native: true,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <div data-testid="viewport-measurement" ref={areaRef} />
      <button
        type="button"
        onClick={() =>
          void controller.resize(1, 1, null).catch(() => undefined)
        }
      >
        Invalid measured viewport
      </button>
      <output data-testid="measured-error">{controller.error ?? ""}</output>
    </>
  );
}

function toolbarProbeTree(
  queryClient: QueryClient,
  setViewport: BrowserSessionsState["setViewport"],
  viewport: BrowserViewportState,
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          viewport,
          () => undefined,
          () => undefined,
        )}
      >
        <ToolbarProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>
  );
}

interface MeasuredViewportTreeOptions {
  readonly activity: PaneSurfaceActivity;
  readonly probe: MeasuredViewportProbeProps;
}

function measuredViewportTree(
  queryClient: QueryClient,
  sessions: BrowserSessionsState,
  options: MeasuredViewportTreeOptions,
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider value={sessions}>
        <PaneSurfaceActivityContext.Provider value={options.activity}>
          <MeasuredViewportProbe {...options.probe} />
        </PaneSurfaceActivityContext.Provider>
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>
  );
}

function ReadOnlyViewportProbe(): ReactElement {
  const { areaRef, controller, paintedSize } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    registrationId: null,
    visible: true,
    disabled: true,
    pageZoom: 1,
    native: false,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <div data-testid="measurement-area" ref={areaRef} />
      <button type="button" onClick={controller.open}>
        Open viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.reset().catch(() => undefined)}
      >
        Reset viewport
      </button>
      <button
        type="button"
        onClick={() =>
          void controller.resize(640, 480, null).catch(() => undefined)
        }
      >
        Resize viewport
      </button>
      <button type="button" onClick={controller.claim}>
        Claim viewport
      </button>
      <output data-testid="disabled">{String(controller.disabled)}</output>
      <output data-testid="painted-width">
        {paintedSize?.width ?? "none"}
      </output>
      <output data-testid="error">{controller.error ?? ""}</output>
    </>
  );
}

function renderReadOnlyProbe(
  setViewport: BrowserSessionsState["setViewport"],
  reportViewport: BrowserSessionsState["reportViewport"],
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          readOnlyViewportState(),
          reportViewport,
          () => undefined,
        )}
      >
        <ReadOnlyViewportProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

function PreviewScaleProbe(): ReactElement {
  const { areaRef, controller, guestViewport, paintedSize, scrollRef } =
    useBrowserViewport({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      instanceId: "instance-1",
      registrationId: null,
      visible: true,
      disabled: false,
      pageZoom: 1,
      native: true,
    });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <div data-testid="measurement-area" ref={areaRef}>
      <div data-testid="scroll-area" ref={scrollRef}>
        <button type="button" onClick={() => controller.setPreviewScale(1.5)}>
          Set 150% preview scale
        </button>
        <button type="button" onClick={() => controller.setPreviewScale(0.5)}>
          Set 50% preview scale
        </button>
        <button
          type="button"
          onClick={() => void controller.reset().catch(() => undefined)}
        >
          Reset preview scale
        </button>
        <output data-testid="preview-scale-setting">
          {controller.previewScaleSetting === null
            ? "auto"
            : String(controller.previewScaleSetting)}
        </output>
        <output data-testid="preview-expanded">
          {controller.expanded ? "expanded" : "collapsed"}
        </output>
        <output data-testid="resize-scale">{controller.resizeScale}</output>
        <output data-testid="guest-size">
          {guestViewport === null
            ? "none"
            : `${guestViewport.width}x${guestViewport.height}`}
        </output>
        <output data-testid="guest-auto-fit">
          {guestViewport === null ? "none" : String(guestViewport.autoFit)}
        </output>
        <output data-testid="painted-size">
          {paintedSize === null
            ? "none"
            : `${paintedSize.width}x${paintedSize.height}`}
        </output>
      </div>
    </div>
  );
}

function renderPreviewScaleProbe(
  setViewport: BrowserSessionsState["setViewport"],
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          fixedViewportState(),
          () => undefined,
          () => undefined,
        )}
      >
        <PreviewScaleProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

function InteractionProbe(): ReactElement {
  const { areaRef, controller, onInteraction, scrollRef } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    registrationId: null,
    visible: true,
    disabled: false,
    pageZoom: 1,
    native: false,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <div
      data-testid="viewport-scroll"
      ref={scrollRef}
      onFocusCapture={onInteraction}
      onPointerDownCapture={onInteraction}
    >
      <div data-testid="measurement-area" ref={areaRef} />
      <BrowserViewportToolbar controller={controller} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  coordinatorSnapshot.value = null;
  viewportResizeObservers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBrowserViewport", () => {
  it("validates an invalid resize before claiming the measured Fit viewport", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            viewportState(),
            reportViewport,
            () => undefined,
          )}
        >
          <MeasuredViewportProbe
            instanceId="instance-invalid"
            pageZoom={1}
            registrationId={null}
            visible
          />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    triggerLastViewportResize();
    fireEvent.click(
      screen.getByRole("button", { name: "Invalid measured viewport" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("measured-error").textContent).not.toBe("");
    });
    expect(setViewport).not.toHaveBeenCalled();
    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(0);
  });

  it("keeps a newer mutation failure when an older resize rejects later", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let callCount = 0;
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() => {
      callCount += 1;
      return (callCount === 1 ? first : second).promise;
    });
    const firstError = new Error("resize A failed late");
    const secondError = new Error("resize B failed first");
    renderProbe(setViewport);

    fireEvent.click(screen.getByRole("button", { name: "Resize A" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize B" }));
    await waitFor(() => expect(setViewport).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.reject(secondError);
      await second.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        secondError.message,
      );
    });

    await act(async () => {
      first.reject(firstError);
      await first.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        secondError.message,
      );
    });
  });

  it("claims Fit for a focused reopened instance but not a background split viewer", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    const oldViewerId = JSON.stringify(["window-a", "instance-old"]);
    const state = {
      ...viewportState(),
      fitOwnerId: oldViewerId,
    } satisfies BrowserViewportState;
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient();
    const view = render(
      measuredViewportTree(
        queryClient,
        sessionsState(setViewport, state, reportViewport, () => undefined),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-old",
            pageZoom: 1,
            registrationId: "registration-old",
            visible: true,
          },
        },
      ),
    );

    await waitFor(() => {
      expect(
        reportViewport.mock.calls.some(
          ([input]) => input.viewerId === oldViewerId && input.claim,
        ),
      ).toBe(true);
    });

    reportViewport.mockClear();
    view.rerender(
      measuredViewportTree(
        queryClient,
        sessionsState(setViewport, state, reportViewport, () => undefined),
        {
          activity: { visible: true, focused: false },
          probe: {
            instanceId: "instance-new",
            pageZoom: 1,
            registrationId: "registration-new",
            visible: true,
          },
        },
      ),
    );
    triggerLastViewportResize();
    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(0);

    reportViewport.mockClear();
    view.rerender(
      measuredViewportTree(
        queryClient,
        sessionsState(setViewport, state, reportViewport, () => undefined),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-new",
            pageZoom: 1,
            registrationId: "registration-new",
            visible: true,
          },
        },
      ),
    );
    await waitFor(() => {
      expect(
        reportViewport.mock.calls.some(
          ([input]) =>
            input.viewerId === JSON.stringify(["window-a", "instance-new"]) &&
            input.claim,
        ),
      ).toBe(true);
    });
    expect(setViewport).not.toHaveBeenCalled();
  });

  it("claims when a returning focused pane receives its first valid geometry", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    let width = 0;
    let height = 0;
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => width,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      () => height,
    );
    const queryClient = new QueryClient();
    const view = render(
      measuredViewportTree(
        queryClient,
        sessionsState(
          setViewport,
          viewportState(),
          reportViewport,
          () => undefined,
        ),
        {
          activity: { visible: true, focused: false },
          probe: {
            instanceId: "instance-returning",
            pageZoom: 1,
            registrationId: "registration-returning",
            visible: true,
          },
        },
      ),
    );
    expect(reportViewport).not.toHaveBeenCalled();

    width = 640;
    height = 480;
    view.rerender(
      measuredViewportTree(
        queryClient,
        sessionsState(
          setViewport,
          viewportState(),
          reportViewport,
          () => undefined,
        ),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-returning",
            pageZoom: 1,
            registrationId: "registration-returning",
            visible: true,
          },
        },
      ),
    );
    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({
          claim: true,
          geometry: { width: 640, height: 480, dpr: 1 },
        }),
      );
    });
  });

  it("drops a latched activation claim when OS focus leaves before measurement", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    let width = 0;
    let height = 0;
    let windowFocused = true;
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => width,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      () => height,
    );
    const queryClient = new QueryClient();
    render(
      measuredViewportTree(
        queryClient,
        sessionsState(
          setViewport,
          viewportState(),
          reportViewport,
          () => undefined,
        ),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-os-focus-race",
            pageZoom: 1,
            registrationId: "registration-os-focus-race",
            visible: true,
          },
        },
      ),
    );

    await act(async () => {
      triggerLastViewportResize();
      await Promise.resolve();
    });
    expect(reportViewport).not.toHaveBeenCalled();

    width = 640;
    height = 480;
    windowFocused = false;
    await act(async () => {
      triggerLastViewportResize();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({
          claim: false,
          geometry: { width: 640, height: 480, dpr: 1 },
        }),
      );
    });
  });

  it("keeps a remeasure passive after activation until a focus edge occurs", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient();
    const activity = {
      visible: true,
      focused: true,
    } satisfies PaneSurfaceActivity;
    const state = viewportState();
    const view = render(
      measuredViewportTree(
        queryClient,
        sessionsState(setViewport, state, reportViewport, () => undefined),
        {
          activity,
          probe: {
            instanceId: "instance-remeasure",
            pageZoom: 1,
            registrationId: "registration-remeasure",
            visible: true,
          },
        },
      ),
    );

    await waitFor(() => {
      expect(reportViewport.mock.calls.some(([input]) => input.claim)).toBe(
        true,
      );
    });
    reportViewport.mockClear();

    view.rerender(
      measuredViewportTree(
        queryClient,
        sessionsState(setViewport, state, reportViewport, () => undefined),
        {
          activity,
          probe: {
            instanceId: "instance-remeasure",
            pageZoom: 2,
            registrationId: "registration-remeasure",
            visible: true,
          },
        },
      ),
    );

    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({
          claim: false,
          geometry: { width: 320, height: 240, dpr: 1 },
        }),
      );
    });
    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(0);
  });

  it("drops a hidden draft and reopens with the latest agent dimensions", () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const initial = fixedViewportState();
    const fitUpdate = {
      ...viewportState(),
      revision: 2,
      source: "agent",
    } satisfies BrowserViewportState;
    const fixedUpdate = {
      ...fitUpdate,
      intent: { mode: "fixed", width: 412, height: 915 },
      applied: { width: 412, height: 915, dpr: 1 },
      revision: 3,
    } satisfies BrowserViewportState;
    const view = render(toolbarProbeTree(queryClient, setViewport, initial));

    const width = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Viewport width",
    });
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "640" } });
    expect(width.value).toBe("640");

    view.rerender(toolbarProbeTree(queryClient, setViewport, fitUpdate));
    expect(
      screen.queryByRole("spinbutton", { name: "Viewport width" }),
    ).toBeNull();

    view.rerender(toolbarProbeTree(queryClient, setViewport, fixedUpdate));
    expect(
      screen.getByRole<HTMLInputElement>("spinbutton", {
        name: "Viewport width",
      }).value,
    ).toBe("412");
    expect(
      screen.getByRole<HTMLInputElement>("spinbutton", {
        name: "Viewport height",
      }).value,
    ).toBe("915");
    expect(screen.getByTestId("toolbar-size").textContent).toBe("412x915");
  });

  it("waits for the viewport mutation acknowledgement before expanding", async () => {
    const acknowledgement = Promise.withResolvers<void>();
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(
      () => acknowledgement.promise,
    );

    renderProbe(setViewport);
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));

    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fit",
      });
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("expanded").textContent).toBe("expanded");
    });
  });

  it("does not apply a stale open after reset and exposes validation errors", async () => {
    const openAcknowledgement = Promise.withResolvers<void>();
    const resetAcknowledgement = Promise.withResolvers<void>();
    let callCount = 0;
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() => {
      callCount += 1;
      return (callCount === 1 ? openAcknowledgement : resetAcknowledgement)
        .promise;
    });

    renderProbe(setViewport);
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset viewport" }));
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      openAcknowledgement.resolve();
      await openAcknowledgement.promise;
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");

    await act(async () => {
      resetAcknowledgement.resolve();
      await resetAcknowledgement.promise;
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");
    expect(setViewport).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Invalid viewport" }));
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).not.toBe("");
    });
    expect(setViewport).toHaveBeenCalledTimes(2);
  });

  it("shows a host failure at its rollback revision and hides it after a later update", async () => {
    const rejection = Promise.withResolvers<void>();
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(
      () => rejection.promise,
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const initial = viewportState();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            initial,
            () => undefined,
            () => undefined,
          )}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resize viewport" }));
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fixed",
        width: 640,
        height: 480,
      });
    });

    const rollback = {
      ...initial,
      revision: 2,
      applied: { width: 390, height: 844, dpr: 1 },
    } satisfies BrowserViewportState;
    coordinatorSnapshot.value = sessionsState(
      setViewport,
      rollback,
      () => undefined,
      () => undefined,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            rollback,
            () => undefined,
            () => undefined,
          )}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await act(async () => {
      rejection.reject(new Error("viewport was rolled back"));
      await rejection.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "viewport was rolled back",
      );
    });

    const later = { ...rollback, revision: 3 } satisfies BrowserViewportState;
    coordinatorSnapshot.value = sessionsState(
      setViewport,
      later,
      () => undefined,
      () => undefined,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            later,
            () => undefined,
            () => undefined,
          )}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("keeps local measurement while read-only controls cannot report, claim, or mutate", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);

    renderReadOnlyProbe(setViewport, reportViewport);

    await waitFor(() => {
      expect(screen.getByTestId("painted-width").textContent).toBe("390");
    });
    expect(screen.getByTestId("disabled").textContent).toBe("true");
    expect(reportViewport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Claim viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize viewport" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "Viewport controls are unavailable",
      );
    });
    expect(setViewport).not.toHaveBeenCalled();
    expect(reportViewport).not.toHaveBeenCalled();
  });

  it("changes preview scale locally and reset returns to auto fit", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement): number {
        return this.dataset.testid === "scroll-area" ? 590 : 640;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);

    renderPreviewScaleProbe(setViewport);

    await waitFor(() => {
      expect(screen.getByTestId("guest-size").textContent).toBe("390x844");
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "auto",
      );
    });
    expect(setViewport).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Set 150% preview scale" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "1.5",
      );
      expect(screen.getByTestId("resize-scale").textContent).toBe("1.5");
      expect(screen.getByTestId("guest-size").textContent).toBe("390x844");
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("false");
      expect(screen.getByTestId("painted-size").textContent).toBe("585x1266");
    });
    expect(setViewport).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Reset preview scale" }),
    );
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fit",
      });
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "auto",
      );
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("true");
    });
  });

  it("resets a manual preview scale when an agent returns the viewport to Fit", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const queryClient = new QueryClient();
    const fixedAgent = {
      ...fixedViewportState(),
      source: "agent",
    } satisfies BrowserViewportState;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            fixedAgent,
            () => undefined,
            () => undefined,
          )}
        >
          <PreviewScaleProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-expanded").textContent).toBe(
        "expanded",
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Set 50% preview scale" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "0.5",
      );
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("false");
    });

    const fitAgent = {
      ...fixedAgent,
      applied: null,
      intent: { mode: "fit" },
      revision: fixedAgent.revision + 1,
    } satisfies BrowserViewportState;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            fitAgent,
            () => undefined,
            () => undefined,
          )}
        >
          <PreviewScaleProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-expanded").textContent).toBe(
        "collapsed",
      );
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "auto",
      );
      expect(screen.getByTestId("guest-size").textContent).toBe("none");
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("none");
      expect(screen.getByTestId("painted-size").textContent).toBe("none");
    });
  });

  it("does not claim while inspecting toolbar controls but claims a committed resize", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            fixedViewportState(),
            reportViewport,
            () => undefined,
          )}
        >
          <InteractionProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({ claim: false }),
      );
    });
    const scroll = screen.getByTestId("viewport-scroll");
    fireEvent.focus(scroll);
    fireEvent.pointerDown(scroll, { button: 0 });
    const scaleTrigger = screen.getByRole("button", { name: "Preview scale" });
    fireEvent.focus(scaleTrigger);
    fireEvent.pointerDown(scaleTrigger, { button: 0 });
    await waitFor(() => {
      expect(screen.getByRole("menuitemradio", { name: "200%" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "200%" }));

    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(0);

    const width = screen.getByRole("spinbutton", { name: "Viewport width" });
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });
    fireEvent.keyDown(width, { key: "Enter" });
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fixed",
        width: 500,
        height: 844,
      });
    });
    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(1);
  });
});

/**
 * The global test shim (`test-browser-apis.ts`) answers every media query
 * with `matches: false`, so every OTHER test in this file - and every test in
 * this suite that came before D02 - measures on a fine pointer without
 * knowing it. This narrows just the coarse-pointer query, the same helper
 * `coarse-pointer-autofocus.test.tsx` uses, so the rest of the app's queries
 * keep the shim's answer.
 */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * D02: the Fit report carries the viewer's pointer class, because a
 * coarse-pointer owner is what makes the host apply phone-shaped emulation to
 * the tab. `measuredViewportTree` is the same harness the "claim" suite above
 * uses - stubbed `ResizeObserver` plus `clientWidth`/`clientHeight` spies -
 * so the only new variable here is the pointer query.
 */
describe("pointer class on the Fit report (D02)", () => {
  afterEach(() => {
    stubCoarsePointer(false);
  });

  it("reports pointer: coarse when matchMedia reports a coarse pointer", async () => {
    stubCoarsePointer(true);
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient();
    render(
      measuredViewportTree(
        queryClient,
        sessionsState(
          setViewport,
          viewportState(),
          reportViewport,
          () => undefined,
        ),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-pointer-coarse",
            pageZoom: 1,
            registrationId: "registration-pointer-coarse",
            visible: true,
          },
        },
      ),
    );

    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({ pointer: "coarse" }),
      );
    });
  });

  it("reports pointer: fine when matchMedia reports no coarse pointer", async () => {
    stubCoarsePointer(false);
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.stubGlobal("ResizeObserver", ControllableViewportResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient();
    render(
      measuredViewportTree(
        queryClient,
        sessionsState(
          setViewport,
          viewportState(),
          reportViewport,
          () => undefined,
        ),
        {
          activity: { visible: true, focused: true },
          probe: {
            instanceId: "instance-pointer-fine",
            pageZoom: 1,
            registrationId: "registration-pointer-fine",
            visible: true,
          },
        },
      ),
    );

    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({ pointer: "fine" }),
      );
    });
  });
});

interface ReleaseViewportProbeProps {
  readonly pageZoom: number;
}

/**
 * Exposes only `controller.open` and its `expanded` readback: the release
 * effect's dep array (`use-browser-viewport.ts`) is deliberately narrower
 * than the measure effect's, and `expanded` is one of the four inputs this
 * suite proves does NOT belong to it.
 */
function ReleaseViewportProbe(props: ReleaseViewportProbeProps): ReactElement {
  const { controller } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-release",
    registrationId: null,
    visible: true,
    disabled: false,
    pageZoom: props.pageZoom,
    native: true,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <button type="button" onClick={controller.open}>
        Open viewport
      </button>
      <output data-testid="release-probe-expanded">
        {controller.expanded ? "expanded" : "collapsed"}
      </output>
    </>
  );
}

function releaseViewportTree(
  queryClient: QueryClient,
  sessions: BrowserSessionsState,
  options: {
    readonly activity: PaneSurfaceActivity;
    readonly pageZoom: number;
  },
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider value={sessions}>
        <PaneSurfaceActivityContext.Provider value={options.activity}>
          <ReleaseViewportProbe pageZoom={options.pageZoom} />
        </PaneSurfaceActivityContext.Provider>
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * Critique-2 B6, pinned directly: `releaseViewport` is its own effect
 * (`use-browser-viewport.ts`) precisely so an expand, a pane-focus change, a
 * `pageZoom` change or a sessions reconnect cannot fire it - each of those
 * DOES belong to the eleven-input measure effect, and folding release into
 * that effect's cleanup would drop this viewer's own Fit ownership mid-
 * session on every one of them. Only unmount may fire it, and it must fire
 * exactly once.
 */
describe("releaseViewport fires only on unmount (D03, critique-2 B6)", () => {
  it("does not fire on expand, pane-focus, pageZoom or a sessions reconnect - only on unmount, exactly once", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const releaseViewport = vi.fn<BrowserSessionsState["releaseViewport"]>();
    const queryClient = new QueryClient();
    const baseState = (): BrowserSessionsState =>
      sessionsState(
        setViewport,
        viewportState(),
        () => undefined,
        releaseViewport,
      );

    const view = render(
      releaseViewportTree(queryClient, baseState(), {
        activity: { visible: true, focused: true },
        pageZoom: 1,
      }),
    );
    expect(releaseViewport).not.toHaveBeenCalled();

    // Expand: `controller.open()` flips `expanded`, one of the measure
    // effect's eleven deps - not one of the release effect's four.
    await act(async () => {
      screen.getByRole("button", { name: "Open viewport" }).click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("release-probe-expanded").textContent).toBe(
        "expanded",
      );
    });
    expect(releaseViewport).not.toHaveBeenCalled();

    // Pane focus changes.
    view.rerender(
      releaseViewportTree(queryClient, baseState(), {
        activity: { visible: true, focused: false },
        pageZoom: 1,
      }),
    );
    expect(releaseViewport).not.toHaveBeenCalled();

    // `pageZoom` changes.
    view.rerender(
      releaseViewportTree(queryClient, baseState(), {
        activity: { visible: true, focused: false },
        pageZoom: 2,
      }),
    );
    expect(releaseViewport).not.toHaveBeenCalled();

    // The sessions connection reconnects - a new `connectionGeneration`,
    // exactly what a `browser.sessions` re-subscribe bumps.
    view.rerender(
      releaseViewportTree(
        queryClient,
        { ...baseState(), connectionGeneration: 2 },
        { activity: { visible: true, focused: false }, pageZoom: 2 },
      ),
    );
    expect(releaseViewport).not.toHaveBeenCalled();

    view.unmount();
    expect(releaseViewport).toHaveBeenCalledTimes(1);
    expect(releaseViewport).toHaveBeenCalledWith({
      sessionId: "session-1",
      tabId: "tab-1",
      viewerId: JSON.stringify(["window-a", "instance-release"]),
    });
  });
});
