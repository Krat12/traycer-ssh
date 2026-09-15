import { describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.0-ssh.1",
    getPath: () => "/tmp/traycer-ssh-test",
  },
}));
vi.mock("electron-updater", () => ({ autoUpdater: updater }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../notifications", () => ({ showSimpleNotification: vi.fn() }));

describe("SSH edition updater", () => {
  it("answers checks and recovery without initialization, downloads or a release-feed request", async () => {
    const api = await import("../updater");
    expect((await api.checkForUpdatesNow(false, "manual")).status).toBe(
      "unavailable",
    );
    expect((await api.setAllowPrereleaseUpdates(true)).outcome).toBe(
      "unchanged",
    );
    expect(
      await api.resolveCompatRecovery({
        minimumEpoch: 99,
        hostAllowsRcRecovery: true,
      }),
    ).toEqual({
      route: "manual",
      rcCandidateVersion: null,
      stagedVersion: null,
    });
    api.startUpdateDownload();
    api.installDownloadedUpdate();
    for (const operation of Object.values(updater))
      expect(operation).not.toHaveBeenCalled();
  });
});
