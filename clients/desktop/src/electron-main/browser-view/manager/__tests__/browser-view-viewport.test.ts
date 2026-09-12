import { describe, expect, it } from "vitest";
import type { BrowserViewportGeometry } from "@traycer/protocol/host/browser/viewport";
import type { BrowserViewElectronViewport } from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../../ipc-contracts/ipc-channels";
import { FakeWebContents } from "../../debug/__tests__/browser-debug-session-test-support";
import type { BrowserViewEntry } from "../browser-view-entry";
import { BrowserViewAnnotationHost } from "../browser-view-annotation-host";
import { BrowserViewEntryRegistry } from "../browser-view-entry-registry";
import { BrowserViewDebugSessions } from "../debug-session-for";
import { BrowserViewViewport } from "../browser-view-viewport";
import {
  createTestEntry,
  ReadbackWebContents,
} from "./browser-view-entry-test-support";

class RejectingWebContents extends FakeWebContents {
  executeJavaScript(_script: string, _userGesture: boolean): Promise<unknown> {
    return Promise.reject(new Error("initial geometry script rejected"));
  }
}

interface ViewportHarness {
  readonly viewport: BrowserViewViewport;
  readonly entry: BrowserViewEntry;
  /**
   * Interleaved CDP commands (`debug:<method>`) and renderer presentations, so
   * a test can assert the ORDER of the clear/present/override sequence rather
   * than only that each step happened.
   */
  readonly order: string[];
}

/**
 * A viewport whose renderer confirms every presentation immediately.
 *
 * Production's `present()` waits on an IPC round trip to the window's
 * `<webview>` host; answering it inline is what lets these tests reach the
 * read-back-and-override half of an apply at all.
 */
function createViewportHarness(webContents: FakeWebContents): ViewportHarness {
  const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  const debugSessions = new BrowserViewDebugSessions({
    onDetached: () => undefined,
  });
  const annotations = new BrowserViewAnnotationHost({
    entries,
    debugSessions,
    send: () => false,
  });
  const order: string[] = [];
  let viewport: BrowserViewViewport;
  viewport = new BrowserViewViewport(
    entries,
    annotations,
    debugSessions,
    (windowId, channel, payload) => {
      if (channel !== RunnerHostEvent.browserViewGuestViewportRequested)
        return true;
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("requestId" in payload) ||
        typeof payload.requestId !== "string" ||
        !("registrationId" in payload) ||
        typeof payload.registrationId !== "string" ||
        !("revision" in payload) ||
        typeof payload.revision !== "number"
      )
        return false;
      order.push("presentation");
      viewport.reportPresentation(windowId, {
        requestId: payload.requestId,
        registrationId: payload.registrationId,
        revision: payload.revision,
        applied: true,
      });
      return true;
    },
  );
  const entry = createTestEntry(webContents);
  webContents.debugger.onSendCommand = (command) => {
    order.push(`debug:${command.method}`);
  };
  entries.register(entry);
  return { viewport, entry, order };
}

function viewportInput(): BrowserViewElectronViewport {
  const geometry: BrowserViewportGeometry = {
    width: 390,
    height: 844,
    dpr: 1,
  };
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    connectionId: "connection-1",
    revision: 1,
    intent: { mode: "fixed", width: 390, height: 844 },
    geometry,
    emulation: null,
  };
}

function methodsSent(webContents: FakeWebContents): readonly string[] {
  return webContents.debugger.commands.map((command) => command.method);
}

describe("BrowserViewViewport", () => {
  it("preserves the first geometry script error instead of masking it in rollback", async () => {
    const harness = createViewportHarness(new RejectingWebContents());

    await expect(
      harness.viewport.apply(harness.entry, viewportInput()),
    ).rejects.toThrow("initial geometry script rejected");
  });

  it("clears device metrics before presenting an acknowledged native readback", async () => {
    const readback: BrowserViewportGeometry = {
      width: 412,
      height: 732,
      dpr: 1.25,
    };
    const webContents = new ReadbackWebContents(readback);
    const harness = createViewportHarness(webContents);
    const input = {
      ...viewportInput(),
      intent: { mode: "fixed", width: 412, height: 732 },
      geometry: { width: 412, height: 732, dpr: 1 },
    } satisfies BrowserViewElectronViewport;

    await expect(harness.viewport.apply(harness.entry, input)).resolves.toEqual(
      readback,
    );
    const clearIndex = harness.order.indexOf(
      "debug:Emulation.clearDeviceMetricsOverride",
    );
    const presentationIndex = harness.order.indexOf("presentation");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(presentationIndex).toBeGreaterThan(clearIndex);
    // `emulation: null` is the pre-emulation behaviour: neither half of the
    // device override is written, so a desktop on the 2.1 line that never sees
    // the field behaves exactly as it did before it existed.
    expect(methodsSent(webContents)).not.toContain(
      "Emulation.setDeviceMetricsOverride",
    );
    expect(methodsSent(webContents)).not.toContain(
      "Emulation.setTouchEmulationEnabled",
    );
    expect(harness.viewport.emulation(harness.entry)).toBeNull();
  });

  it("writes the device override exactly once, after the clear and the confirmed readback", async () => {
    const readback: BrowserViewportGeometry = {
      width: 390,
      height: 844,
      dpr: 3,
    };
    const webContents = new ReadbackWebContents(readback);
    const harness = createViewportHarness(webContents);
    const input = {
      ...viewportInput(),
      intent: { mode: "fixed", width: 390, height: 844 },
      geometry: { width: 390, height: 844, dpr: 1 },
      emulation: { mobile: true, touch: true },
    } satisfies BrowserViewElectronViewport;

    await expect(harness.viewport.apply(harness.entry, input)).resolves.toEqual(
      readback,
    );

    const overrides = webContents.debugger.commands.filter(
      (command) => command.method === "Emulation.setDeviceMetricsOverride",
    );
    // Exactly one writer of device metrics per guest (D02): the apply that
    // changed the guest's size. A second writer - the mirror source, say -
    // would be wiped by the clear the NEXT resize issues.
    expect(overrides).toHaveLength(1);
    // The geometry the guest actually committed, so the override changes the
    // layout MODE and nothing about the size.
    expect(overrides[0]?.params).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    expect(
      webContents.debugger.commands
        .filter(
          (command) => command.method === "Emulation.setTouchEmulationEnabled",
        )
        .map((command) => command.params),
    ).toEqual([{ enabled: true, maxTouchPoints: 1 }]);

    const order = methodsSent(webContents);
    expect(order.indexOf("Emulation.setDeviceMetricsOverride")).toBeGreaterThan(
      order.indexOf("Emulation.clearDeviceMetricsOverride"),
    );
    expect(
      harness.order.indexOf("debug:Emulation.setDeviceMetricsOverride"),
    ).toBeGreaterThan(harness.order.indexOf("presentation"));
    expect(harness.viewport.emulation(harness.entry)).toEqual({
      mobile: true,
      touch: true,
    });
  });

  it("reads outerWidth once a mobile override is live and innerWidth inside the apply that clears it", async () => {
    const readback: BrowserViewportGeometry = {
      width: 390,
      height: 844,
      dpr: 3,
    };
    const webContents = new ReadbackWebContents(readback);
    const harness = createViewportHarness(webContents);
    const input = {
      ...viewportInput(),
      // `fit` so the post-apply refresh re-reads the geometry instead of
      // re-landing it - which is the only way to observe a readback taken while
      // the override is still live.
      intent: { mode: "fit" },
      emulation: { mobile: true, touch: true },
    } satisfies BrowserViewElectronViewport;

    await harness.viewport.apply(harness.entry, input);

    // Every read inside the apply happens after `clearDeviceMetricsOverride`,
    // so no override is live and the layout viewport IS the device viewport.
    expect(webContents.scripts.length).toBeGreaterThan(0);
    for (const script of webContents.scripts) {
      expect(script).toContain("innerWidth");
      expect(script).not.toContain("outerWidth");
    }

    const insideApply = webContents.scripts.length;
    await harness.viewport.refreshAfterNavigation(harness.entry);

    // With `mobile: true` live, a page with no viewport meta gets a wide
    // layout viewport Chromium then scales down: `innerWidth` would report
    // that layout width, `outerWidth` still reports the emulated device width.
    expect(webContents.scripts).toHaveLength(insideApply + 1);
    expect(webContents.scripts[insideApply]).toContain("outerWidth");
    expect(webContents.scripts[insideApply]).not.toContain("innerWidth");
  });
});
