import { randomUUID } from "node:crypto";
import {
  browserViewportGeometrySchema,
  type BrowserViewportGeometry,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewElectronViewport,
  BrowserViewGuestViewportResult,
  BrowserViewGuestViewportRequested,
  BrowserViewViewportEmulation,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type { BrowserViewWebContents } from "../browser-view-port";
import type { BrowserViewEntry, BrowserViewSend } from "./browser-view-entry";
import type { BrowserViewEntryRegistry } from "./browser-view-entry-registry";
import type { BrowserViewAnnotationHost } from "./browser-view-annotation-host";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import { applyEntryZoom } from "./browser-view-entry-factory";

interface ViewportEntry {
  latest: BrowserViewElectronViewport;
  confirmed: BrowserViewElectronViewport | null;
  confirmedZoom: number | null;
  /**
   * The device-metrics override that is LIVE on the guest right now, not the
   * one the latest request asked for. The two differ for the whole middle of
   * an apply: it clears the override before resizing and re-sends it only
   * after the resize is confirmed, and a geometry read in between must be read
   * the un-emulated way.
   */
  emulated: BrowserViewViewportEmulation | null;
  work: Promise<void>;
}

class UnrepresentableViewportError extends Error {}

interface PendingPresentation {
  readonly entry: BrowserViewEntry;
  readonly revision: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Orders native metrics with the persistent renderer guest's intrinsic size. */
export class BrowserViewViewport {
  private readonly states = new Map<BrowserViewEntry, ViewportEntry>();
  private readonly pending = new Map<string, PendingPresentation>();

  constructor(
    private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>,
    private readonly annotations: BrowserViewAnnotationHost,
    private readonly debugSessions: BrowserViewDebugSessions,
    private readonly send: BrowserViewSend,
  ) {}

  apply(
    entry: BrowserViewEntry,
    input: BrowserViewElectronViewport,
  ): Promise<BrowserViewportGeometry> {
    const state = this.states.get(entry) ?? {
      latest: input,
      confirmed: null,
      confirmedZoom: null,
      emulated: null,
      work: Promise.resolve(),
    };
    if (
      input.connectionId === state.latest.connectionId &&
      input.revision < state.latest.revision
    ) {
      return Promise.reject(
        new Error("A newer viewport request already exists."),
      );
    }
    state.latest = input;
    this.states.set(entry, state);
    const applied = state.work.then(async () => {
      this.requireCurrent(entry, state, input);
      await this.annotations.preserveBeforeViewportChange(entry);
      this.requireCurrent(entry, state, input);
      const before = state.confirmed ?? {
        ...input,
        intent: { mode: "fit" as const },
        geometry: await this.readGeometry(entry, state),
      };
      try {
        const geometry = await this.land(entry, state, input);
        this.requireCurrent(entry, state, input);
        state.confirmed = { ...input, geometry };
        state.confirmedZoom = entry.webContents.getZoomFactor();
        return geometry;
      } catch (error) {
        if (this.entries.isCurrent(entry)) {
          try {
            await this.land(entry, state, {
              ...before,
              revision: input.revision,
            });
          } catch {
            state.confirmed = null;
            throw new Error(
              "The previous viewport could not be restored. Reset to Fit to recover.",
            );
          }
        }
        throw error;
      }
    });
    state.work = applied.then(
      () => undefined,
      () => undefined,
    );
    return applied;
  }

  setZoom(entry: BrowserViewEntry, factor: number): Promise<void> {
    const state = this.states.get(entry);
    if (state === undefined) {
      applyEntryZoom(entry, factor);
      return Promise.resolve();
    }
    const work = state.work.then(async () => {
      if (!this.entries.isCurrent(entry) || this.states.get(entry) !== state) {
        throw new Error("The browser tab is no longer available.");
      }
      const previous = entry.webContents.getZoomFactor();
      if (!applyEntryZoom(entry, factor)) return;
      try {
        await this.refreshConfirmed(entry, state);
      } catch (error) {
        applyEntryZoom(entry, previous);
        await this.refreshConfirmed(entry, state);
        throw error;
      }
    });
    state.work = work.catch(() => undefined);
    return work;
  }

  /** Whether recovery changed page zoom after navigation published status. */
  refreshAfterNavigation(entry: BrowserViewEntry): Promise<boolean> {
    const state = this.states.get(entry);
    if (state === undefined) return Promise.resolve(false);
    const work = state.work.then(async () => {
      const previousZoom = state.confirmedZoom;
      try {
        await this.refreshConfirmed(entry, state);
        return false;
      } catch (error) {
        if (
          !(error instanceof UnrepresentableViewportError) ||
          previousZoom === null
        ) {
          throw error;
        }
        // Electron can choose a saved origin zoom on navigation. Keep the
        // tab's last working zoom if that origin cannot represent its size.
        const originZoom = entry.webContents.getZoomFactor();
        entry.webContents.setZoomFactor(previousZoom);
        await this.refreshConfirmed(entry, state);
        return entry.webContents.getZoomFactor() !== originZoom;
      }
    });
    state.work = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async refreshConfirmed(
    entry: BrowserViewEntry,
    state: ViewportEntry,
  ): Promise<void> {
    const confirmed = state.confirmed;
    if (
      confirmed === null ||
      !this.entries.isCurrent(entry) ||
      this.states.get(entry) !== state
    )
      return;
    const geometry =
      confirmed.intent.mode === "fixed"
        ? await this.land(entry, state, {
            ...confirmed,
            revision: state.latest.revision,
          })
        : await this.readGeometry(entry, state);
    state.confirmed = { ...confirmed, geometry };
    state.confirmedZoom = entry.webContents.getZoomFactor();
  }

  reportPresentation(
    windowId: string,
    result: BrowserViewGuestViewportResult,
  ): void {
    const pending = this.pending.get(result.requestId);
    if (
      pending === undefined ||
      pending.entry.identity.lifecycleWindowId !== windowId ||
      pending.entry.identity.registrationId !== result.registrationId ||
      pending.revision !== result.revision
    )
      return;
    this.pending.delete(result.requestId);
    clearTimeout(pending.timer);
    if (result.applied && this.entries.isCurrent(pending.entry))
      pending.resolve();
    else
      pending.reject(
        new Error("The browser guest could not apply its viewport."),
      );
  }

  forget(entry: BrowserViewEntry): void {
    this.states.delete(entry);
    for (const [requestId, pending] of this.pending) {
      if (pending.entry !== entry) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(
        new Error("The browser guest closed during viewport resize."),
      );
    }
  }

  private requireCurrent(
    entry: BrowserViewEntry,
    state: ViewportEntry,
    input: BrowserViewElectronViewport,
  ): void {
    if (!this.entries.isCurrent(entry) || this.states.get(entry) !== state) {
      throw new Error("The browser tab is no longer available.");
    }
    if (state.latest !== input) {
      throw new Error("A newer viewport request superseded this resize.");
    }
  }

  private land(
    entry: BrowserViewEntry,
    state: ViewportEntry,
    input: BrowserViewElectronViewport,
  ): Promise<BrowserViewportGeometry> {
    return withinViewportDeadline((signal) =>
      this.applyNativeGeometry(entry, state, input, signal),
    );
  }

  private async applyNativeGeometry(
    entry: BrowserViewEntry,
    state: ViewportEntry,
    input: BrowserViewElectronViewport,
    signal: AbortSignal,
  ): Promise<BrowserViewportGeometry> {
    const zoom = entry.webContents.getZoomFactor();
    let width = Math.max(1, Math.round(input.geometry.width * zoom));
    let height = Math.max(1, Math.round(input.geometry.height * zoom));
    const debug = this.debugSessions.ensure(entry);
    await debug.enableAfterCommit();
    signal.throwIfAborted();
    // The guest's intrinsic CSS size is the native viewport authority. Clear
    // stale agent/device metrics before changing that size, so Chromium never
    // paints an old emulated layout into a differently scaled new surface.
    await debug.sendCommand(
      "Emulation.clearDeviceMetricsOverride",
      {},
      undefined,
    );
    state.emulated = null;
    signal.throwIfAborted();
    if (!this.entries.isCurrent(entry))
      throw new Error("The browser tab closed during resize.");
    // Chromium takes whole native pixels. Try the adjacent pixel if rounding
    // misses; below 100% some CSS widths have no exact native representation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.present(entry, {
        revision: input.revision,
        intent: input.intent,
        zoom,
        width,
        height,
      });
      signal.throwIfAborted();
      const applied = await this.readGeometry(entry, state);
      signal.throwIfAborted();
      if (input.intent.mode === "fit") {
        await this.applyEmulation(entry, state, input, applied);
        return applied;
      }
      if (
        applied.width === input.intent.width &&
        applied.height === input.intent.height
      ) {
        await this.applyEmulation(entry, state, input, applied);
        return applied;
      }
      width += Math.sign(input.intent.width - applied.width);
      height += Math.sign(input.intent.height - applied.height);
    }
    throw new UnrepresentableViewportError(
      "This viewport cannot be represented exactly at the current page zoom. Change page zoom and try again.",
    );
  }

  private readGeometry(
    entry: BrowserViewEntry,
    state: ViewportEntry,
  ): Promise<BrowserViewportGeometry> {
    return withinViewportDeadline((signal) =>
      readGuestViewportGeometry(
        entry.webContents,
        state.emulated?.mobile === true,
        signal,
      ),
    );
  }

  /**
   * The one `setDeviceMetricsOverride` writer for a guest, issued AFTER the
   * resize it belongs to has been presented and read back.
   *
   * Before, and it would be wiped by the `clearDeviceMetricsOverride` this
   * method's caller runs on the next resize; from the mirror source instead,
   * and there would be two writers racing the same override. `width`/`height`/
   * `deviceScaleFactor` are the geometry the guest actually committed, so the
   * override changes the layout MODE and nothing about the size.
   */
  private async applyEmulation(
    entry: BrowserViewEntry,
    state: ViewportEntry,
    input: BrowserViewElectronViewport,
    applied: BrowserViewportGeometry,
  ): Promise<void> {
    const emulation = input.emulation;
    if (emulation === null) return;
    const debug = this.debugSessions.ensure(entry);
    await debug.sendCommand(
      "Emulation.setDeviceMetricsOverride",
      {
        width: applied.width,
        height: applied.height,
        deviceScaleFactor: applied.dpr,
        mobile: emulation.mobile,
      },
      undefined,
    );
    state.emulated = emulation;
    await debug.sendCommand(
      "Emulation.setTouchEmulationEnabled",
      { enabled: emulation.touch, maxTouchPoints: 1 },
      undefined,
    );
  }

  /**
   * The device emulation currently live on a guest, for a reader that has to
   * measure the page the same way this class does (the mirror's per-frame
   * geometry). `null` when none is applied.
   */
  emulation(entry: BrowserViewEntry): BrowserViewViewportEmulation | null {
    return this.states.get(entry)?.emulated ?? null;
  }

  private present(
    entry: BrowserViewEntry,
    presentation: Omit<
      BrowserViewGuestViewportRequested,
      "requestId" | "registrationId"
    >,
  ): Promise<void> {
    const requestId = randomUUID();
    const { revision } = presentation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The browser did not confirm its viewport in time."));
      }, 4_000);
      this.pending.set(requestId, { entry, revision, resolve, reject, timer });
      if (
        !this.send(
          entry.identity.lifecycleWindowId,
          RunnerHostEvent.browserViewGuestViewportRequested,
          {
            requestId,
            registrationId: entry.identity.registrationId,
            ...presentation,
          },
        )
      ) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new Error("The browser window is unavailable for viewport resize."),
        );
      }
    });
  }
}

/**
 * The guest's own report of its CSS viewport, in the one expression both the
 * viewport authority and the mirror read it with.
 *
 * `mobile` selects `outerWidth`/`outerHeight` over `innerWidth`/`innerHeight`,
 * and it is not a preference: under
 * `setDeviceMetricsOverride({ mobile: true })` a page with no viewport meta
 * gets a wide layout viewport (980 CSS px, or more) that Chromium then scales
 * down, so `innerWidth` reports the layout width while `outerWidth` still
 * reports the emulated device width the caller asked for. Reading `inner*`
 * there would record a viewport nobody requested and make every fixed-size
 * apply unrepresentable. Same rule as the headless driver's readback.
 */
export async function readGuestViewportGeometry(
  webContents: Pick<BrowserViewWebContents, "executeJavaScript">,
  mobile: boolean,
  signal: AbortSignal,
): Promise<BrowserViewportGeometry> {
  const edges = mobile
    ? "width:outerWidth,height:outerHeight"
    : "width:innerWidth,height:innerHeight";
  const value = await webContents.executeJavaScript(
    `({${edges},dpr:Math.round(devicePixelRatio*1000000)/1000000})`,
    false,
  );
  signal.throwIfAborted();
  const parsed = browserViewportGeometrySchema.safeParse(value);
  if (!parsed.success)
    throw new Error("The browser did not report a valid viewport.");
  return parsed.data;
}

function withinViewportDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        "The browser did not apply its viewport in time.",
      );
      controller.abort(error);
      reject(error);
    }, 4_000);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
