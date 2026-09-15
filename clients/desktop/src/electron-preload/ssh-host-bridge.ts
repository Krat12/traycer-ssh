import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  ISshHostManager,
  SshHostConnection,
} from "../ipc-contracts/ssh-host-types";

export function buildSshHostBridge(): ISshHostManager {
  const list = (): Promise<readonly SshHostConnection[]> =>
    ipcRenderer.invoke(RunnerHostInvoke.sshHostsList) as Promise<
      readonly SshHostConnection[]
    >;
  return {
    list,
    save: (profile) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sshHostsSave,
        profile,
      ) as Promise<void>,
    remove: (hostId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sshHostsRemove,
        hostId,
      ) as Promise<void>,
    reconnect: (hostId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sshHostsReconnect,
        hostId,
      ) as Promise<void>,
    onChange: (handler) => {
      let disposed = false;
      let pushed = false;
      const listener = (
        _event: unknown,
        snapshot: readonly SshHostConnection[],
      ): void => {
        pushed = true;
        if (!disposed) handler(snapshot);
      };
      ipcRenderer.on(RunnerHostEvent.sshHostsChanged, listener);
      // Subscribe before the pull, and never overwrite a newer push with the
      // in-flight pull. Reloaded/new windows do not depend on another state edge.
      void list()
        .then((snapshot) => {
          if (!disposed && !pushed) handler(snapshot);
        })
        .catch(() => {});
      return {
        dispose: () => {
          disposed = true;
          ipcRenderer.removeListener(RunnerHostEvent.sshHostsChanged, listener);
        },
      };
    },
  };
}
