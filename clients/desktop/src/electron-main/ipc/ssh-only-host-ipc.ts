import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { HostControllerStatus } from "../host/host-controller-types";

interface SshOnlyHostIpcBridge {
  handleInvoke(channel: string, handler: () => unknown): void;
  fanOut(channel: string, payload: unknown): void;
}

/** Publish absence without reading or changing the official local installation. */
export function registerSshOnlyHostIpc(bridge: SshOnlyHostIpcBridge): void {
  const status: HostControllerStatus = {
    localAttempt: null,
    download: null,
    mutation: null,
    installedVersion: null,
    latestVersion: null,
    stagedVersion: null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady: false,
    activation: "unavailable",
    reachable: false,
    removedByUser: true,
    checkedAt: new Date().toISOString(),
  };
  const readChannels = new Set<string>([
    RunnerHostInvoke.traycerHostControllerStatusGet,
    RunnerHostInvoke.traycerHostRemovalGet,
    RunnerHostInvoke.traycerHostInstalled,
  ]);
  bridge.handleInvoke(RunnerHostInvoke.lastKnownLocalHostId, () => null);
  bridge.handleInvoke(RunnerHostInvoke.localHostSnapshot, () => null);
  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostControllerStatusGet,
    () => status,
  );
  bridge.handleInvoke(RunnerHostInvoke.traycerHostRemovalGet, () => ({
    removedByUser: true,
  }));
  bridge.handleInvoke(RunnerHostInvoke.traycerHostInstalled, () => []);
  bridge.handleInvoke(RunnerHostInvoke.migrationGetRunningSnapshot, () => null);
  const refuse = (): never => {
    throw new Error(
      "Traycer SSH connects to existing devices. Manage the local Host in the official Traycer application.",
    );
  };
  bridge.handleInvoke(RunnerHostInvoke.requestHostRespawn, refuse);
  bridge.handleInvoke(RunnerHostInvoke.migrationAnnounceRunning, refuse);
  for (const channel of Object.values(RunnerHostInvoke)) {
    if (
      channel.startsWith("runnerHost:traycer:") &&
      !readChannels.has(channel)
    ) {
      bridge.handleInvoke(channel, refuse);
    }
  }
  bridge.fanOut(RunnerHostEvent.localHostChange, null);
  bridge.fanOut(RunnerHostEvent.hostControllerStatusChange, status);
}
