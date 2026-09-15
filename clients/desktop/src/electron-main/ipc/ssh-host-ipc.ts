import { app, dialog, powerMonitor } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import { getSshHostManager } from "../ssh/ssh-host-service";
import { parseSshProfile } from "../ssh/ssh-validation";
import type { SshHostManager } from "../ssh/ssh-host-manager";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export interface SshHostIpcBridge {
  readonly disposeFns: Array<() => void>;
  handleInvoke(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
  fanOut(channel: string, payload: unknown): void;
}

export function registerSshHostIpc(
  bridge: RunnerIpcBridge | SshHostIpcBridge,
): void {
  // Lazy access also keeps bridge-only test fixtures independent of disk/SSH.
  let activeManager: SshHostManager | null = null;
  const manager = (): SshHostManager => {
    activeManager ??= getSshHostManager();
    return activeManager;
  };
  let unsubscribe: (() => void) | null = null;
  const subscribe = (): void => {
    if (unsubscribe) return;
    const disposable = manager().onChange((snapshot) =>
      bridge.fanOut(RunnerHostEvent.sshHostsChanged, snapshot),
    );
    unsubscribe = () => disposable.dispose();
  };
  bridge.handleInvoke(RunnerHostInvoke.sshHostsList, async () => {
    subscribe();
    return await manager().list();
  });
  bridge.handleInvoke(
    RunnerHostInvoke.sshHostsSave,
    async (_event, value: unknown) => {
      subscribe();
      const profile = parseSshProfile(value);
      const current = (await manager().list()).find(
        (row) => row.profile.hostId === profile.hostId,
      );
      // Browser session ownership is in main. A renderer cannot redirect that
      // cookie-bearing stream to an unapproved SSH destination by invoking IPC.
      if (!current || current.profile.target !== profile.target) {
        const answer = await dialog.showMessageBox({
          type: "question",
          title: "Connect this device through SSH?",
          message: `Connect ${profile.label} through ${profile.target}?`,
          detail: `Host identity: ${profile.hostId}\nOnly approve an SSH server you trust. This connection carries your tasks, files, and browser sessions.`,
          buttons: ["Cancel", "Connect"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1)
          throw new Error("SSH connection was not approved.");
      }
      await manager().save(profile);
    },
  );
  bridge.handleInvoke(
    RunnerHostInvoke.sshHostsRemove,
    async (_event, value: unknown) => {
      await manager().remove(readHostId(value));
    },
  );
  bridge.handleInvoke(
    RunnerHostInvoke.sshHostsReconnect,
    async (_event, value: unknown) => {
      await manager().reconnect(readHostId(value));
    },
  );
  const resume = (): void => manager().resume();
  const quit = (): void => manager().dispose();
  powerMonitor.on("resume", resume);
  app.once("will-quit", quit);
  bridge.disposeFns.push(() => {
    unsubscribe?.();
    powerMonitor.removeListener("resume", resume);
    app.removeListener("will-quit", quit);
    manager().dispose();
  });
}

function readHostId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value)
  )
    throw new Error("Invalid SSH Host identity.");
  return value;
}
