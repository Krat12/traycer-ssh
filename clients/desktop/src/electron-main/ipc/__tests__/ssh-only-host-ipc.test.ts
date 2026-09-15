import { describe, expect, it } from "vitest";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerSshOnlyHostIpc } from "../ssh-only-host-ipc";

describe("SSH edition local Host boundary", () => {
  it("publishes no local Host and refuses install, restart, uninstall and CLI writes", () => {
    const handlers = new Map<string, () => unknown>();
    registerSshOnlyHostIpc({
      handleInvoke: (channel, handler) => {
        handlers.set(channel, handler);
      },
      fanOut: () => undefined,
    });
    expect(handlers.get(RunnerHostInvoke.localHostSnapshot)?.()).toBeNull();
    expect(handlers.get(RunnerHostInvoke.lastKnownLocalHostId)?.()).toBeNull();
    expect(
      handlers.get(RunnerHostInvoke.traycerHostControllerStatusGet)?.(),
    ).toMatchObject({
      reachable: false,
      installedVersion: null,
      removedByUser: true,
    });
    for (const channel of [
      RunnerHostInvoke.requestHostRespawn,
      RunnerHostInvoke.traycerHostConvergeReady,
      RunnerHostInvoke.traycerHostApplyStaged,
      RunnerHostInvoke.traycerHostInstallVersion,
      RunnerHostInvoke.traycerAppUninstall,
      RunnerHostInvoke.traycerServiceRegister,
      RunnerHostInvoke.traycerServiceDeregister,
      RunnerHostInvoke.traycerConfigShellSet,
    ]) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      expect(() => handler?.()).toThrow("official Traycer application");
    }
  });
});
