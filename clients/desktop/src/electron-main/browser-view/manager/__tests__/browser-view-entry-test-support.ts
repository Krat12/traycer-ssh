import type { BrowserViewportGeometry } from "@traycer/protocol/host/browser/viewport";
import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserViewWebContents } from "../../browser-view-port";
import { FakeWebContents } from "../../debug/__tests__/browser-debug-session-test-support";
import type { BrowserViewEntry } from "../browser-view-entry";
import type { BrowserViewEntryKey } from "../browser-view-entry-registry";
import { NativeBrowserViewLifecycle } from "../native-browser-view-lifecycle";

/**
 * A guest whose viewport readback answers a geometry the suite chooses, and
 * which keeps every script it was handed.
 *
 * The scripts matter because the readback expression is not fixed: it reads
 * `outerWidth`/`outerHeight` while a mobile device-metrics override is live and
 * `innerWidth`/`innerHeight` otherwise, and which one was evaluated is the only
 * observable difference between the two.
 */
export class ReadbackWebContents extends FakeWebContents {
  readonly scripts: string[] = [];
  private geometry: BrowserViewportGeometry;

  constructor(geometry: BrowserViewportGeometry) {
    super();
    this.geometry = geometry;
  }

  /** The next readback's answer, for a resize the guest is meant to report. */
  setReadbackGeometry(geometry: BrowserViewportGeometry): void {
    this.geometry = geometry;
  }

  executeJavaScript(script: string, _userGesture: boolean): Promise<unknown> {
    this.scripts.push(script);
    return Promise.resolve(this.geometry);
  }
}

/** The native tab identity every entry this module mints is bound to. */
export const TEST_NATIVE_TAB: BrowserViewNativeTabCapability = {
  hostId: "host-1",
  sessionId: "session-1",
  tabId: "tab-1",
  registrationId: "registration-1",
};

/**
 * One accepted, surface-bound entry around `webContents`.
 *
 * Shared by the viewport and mirror-capture suites: both drive a collaborator
 * that takes an entry and nothing else, and an entry assembled two ways is a
 * fixture that can drift from `BrowserViewEntry` in one suite only.
 */
export function createTestEntry(
  webContents: BrowserViewWebContents,
): BrowserViewEntry {
  const key: BrowserViewEntryKey = {
    windowId: "window-1",
    viewTabId: "view-tab-1",
    paneId: "pane-1",
    tileInstanceId: "tile-1",
    pageSessionId: "page-1",
  };
  const lifecycle = new NativeBrowserViewLifecycle();
  lifecycle.completeProvisioning(TEST_NATIVE_TAB, null);
  lifecycle.accept();
  return {
    surface: key,
    surfaceBindingId: "binding-1",
    guestKey: "guest-1",
    identity: {
      key: TEST_NATIVE_TAB,
      ...TEST_NATIVE_TAB,
      lifecycleWindowId: "window-1",
      lifecycle,
    },
    profile: "primary",
    webContents,
    listeners: {},
    desiredVisible: true,
    requestedUrl: "https://example.test/",
    currentUrl: "https://example.test/",
    currentTitle: "Example",
    status: "ready",
    statusReason: null,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    annotationSession: null,
    devToolsWindow: null,
    rendererResetPending: false,
    internalNavigation: false,
    succeededByReplacement: false,
    closePromise: null,
  };
}
