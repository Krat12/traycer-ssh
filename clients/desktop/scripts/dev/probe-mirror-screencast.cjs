#!/usr/bin/env bun
"use strict";

/**
 * T08 step 0 (critique-2 B13): does `Page.startScreencast` on a `<webview>`
 * guest deliver `Page.screencastFrame`, and does it keep delivering when the
 * window is minimized or occluded?
 *
 * Nothing in this tree has ever asked a guest's `webContents.debugger` for a
 * screencast, and the whole hidden-window fallback in the mirror source exists
 * because of that doubt. This probe answers it on a real Electron with a real
 * guest. It changes nothing in the app and imports nothing from it.
 *
 *   bun clients/desktop/scripts/dev/probe-mirror-screencast.cjs
 *
 * It re-execs itself under the workspace's Electron, so there is no build step
 * and no dev server. Three phases of 10 s each - visible, minimized, and one
 * where YOU cover the window with another app full-screen - then a
 * `Emulation.setPageScaleFactor` check (T10/T13's precondition). Each phase
 * prints screencast frames, polled `capturePage` frames, and the fps for both,
 * so a zero in the screencast column and a non-zero in the capture column is
 * the result that makes the fallback load-bearing rather than belt-and-braces.
 *
 * Record the output in `specs/mobile-browser/research/08-electron-screencast-probe.md`.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const PHASE_MS = 10_000;
const POLL_MS = 200;
const SCREENCAST_PARAMS = {
  format: "jpeg",
  quality: 55,
  maxWidth: 900,
  maxHeight: 1600,
  everyNthFrame: 1,
};

if (process.versions.electron === undefined) {
  reexecUnderElectron();
} else {
  void runProbe();
}

function reexecUnderElectron() {
  const workspaceRoot = path.resolve(__dirname, "..", "..");
  const {
    prepareElectronBinary,
    shouldDisableChromiumSandbox,
  } = require("./electron-binary.cjs");
  const electronBin = prepareElectronBinary(
    require("electron"),
    workspaceRoot,
    null,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (
    env.ELECTRON_DISABLE_SANDBOX === undefined &&
    shouldDisableChromiumSandbox(electronBin)
  ) {
    env.ELECTRON_DISABLE_SANDBOX = "1";
  }
  const result = spawnSync(electronBin, [__filename], {
    stdio: "inherit",
    env,
  });
  process.exit(result.status === null ? 1 : result.status);
}

async function runProbe() {
  const { app, BrowserWindow } = require("electron");
  // Occlusion only reports honestly when Chromium is allowed to notice it, so
  // the probe must NOT set `disable-backgrounding-occluded-windows`: measuring
  // the throttled state is the entire point.
  await app.whenReady();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-mirror-probe-"));
  const guestPath = path.join(dir, "guest.html");
  const hostPath = path.join(dir, "host.html");
  // An animating guest, so "no frames" can only mean the screencast stopped -
  // a static page legitimately produces nothing.
  fs.writeFileSync(
    guestPath,
    `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;font:48px system-ui;background:#123">
<div id="t" style="color:#0f0"></div>
<script>
  let n = 0;
  function tick() {
    n += 1;
    document.getElementById("t").textContent = "frame " + n;
    requestAnimationFrame(tick);
  }
  tick();
</script>`,
  );
  fs.writeFileSync(
    hostPath,
    `<!doctype html><body style="margin:0">
<webview style="width:100%;height:100vh" src="file://${guestPath}"></webview>`,
  );

  const window = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { webviewTag: true, nodeIntegration: false },
  });

  const guest = await new Promise((resolve) => {
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") resolve(contents);
    });
    void window.loadFile(hostPath);
  });
  await new Promise((resolve) => {
    if (!guest.isLoading()) {
      resolve();
      return;
    }
    guest.once("did-finish-load", () => resolve());
  });

  const counters = { screencast: 0, captured: 0, captureErrors: 0 };
  guest.debugger.attach("1.3");
  guest.debugger.on("message", (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    counters.screencast += 1;
    // Chromium stops after two unacked frames, so the probe must ack or every
    // phase measures the same two frames.
    void guest.debugger
      .sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => undefined);
  });
  await guest.debugger.sendCommand("Page.enable");
  await guest.debugger.sendCommand("Page.startScreencast", SCREENCAST_PARAMS);

  const poller = setInterval(() => {
    // Zero-arg, exactly as the mirror's fallback and PiP capture call it:
    // Electron then forces a paint of a hidden page, which is the behaviour
    // D09 needs. `{ stayHidden: true }` would measure the opposite.
    guest
      .capturePage()
      .then((image) => {
        if (!image.isEmpty() && image.toJPEG(55).byteLength > 0) {
          counters.captured += 1;
        }
      })
      .catch(() => {
        counters.captureErrors += 1;
      });
  }, POLL_MS);

  await phase("visible", counters, () => undefined);
  await phase("minimized", counters, () => {
    window.minimize();
  });
  window.restore();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  console.log(
    "\n>>> Now cover this window completely with another app (full-screen) and leave it there for 10s.",
  );
  await phase("occluded", counters, () => undefined);

  clearInterval(poller);
  await probePageScaleFactor(guest);
  await guest.debugger
    .sendCommand("Page.stopScreencast")
    .catch(() => undefined);
  guest.debugger.detach();
  fs.rmSync(dir, { recursive: true, force: true });
  app.quit();
}

async function phase(name, counters, enter) {
  const before = { ...counters };
  enter();
  await new Promise((resolve) => setTimeout(resolve, PHASE_MS));
  const screencast = counters.screencast - before.screencast;
  const captured = counters.captured - before.captured;
  const errors = counters.captureErrors - before.captureErrors;
  const seconds = PHASE_MS / 1_000;
  console.log(
    `[${name}] screencastFrame=${screencast} (${(screencast / seconds).toFixed(1)} fps)  ` +
      `capturePage=${captured} (${(captured / seconds).toFixed(1)} fps)  captureErrors=${errors}`,
  );
}

/**
 * T10/T13's precondition: visual (pinch) zoom without reflow. `setZoom` on the
 * mirror is `Emulation.setPageScaleFactor`, and it is unprobed on a `<webview>`.
 */
async function probePageScaleFactor(guest) {
  const before = await guest.executeJavaScript("visualViewport.scale");
  let accepted = true;
  try {
    await guest.debugger.sendCommand("Emulation.setPageScaleFactor", {
      pageScaleFactor: 1.5,
    });
  } catch (error) {
    accepted = false;
    console.log(`[pageScaleFactor] REJECTED: ${String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await guest.executeJavaScript("visualViewport.scale");
  console.log(
    `[pageScaleFactor] accepted=${accepted} visualViewport.scale ${before} -> ${after}`,
  );
}
