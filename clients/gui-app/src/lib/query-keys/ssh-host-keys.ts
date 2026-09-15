import type { ISshHostManager } from "@traycer-clients/shared/platform/ssh-host";
import { supportBridgeQueryScopeId } from "./runner-mutation-keys";

export const sshHostKeys = {
  list: (manager: ISshHostManager | null) =>
    ["runner.sshHosts", supportBridgeQueryScopeId(manager)] as const,
  change: (hostId: string) => ["runner.sshHosts.change", hostId] as const,
};
