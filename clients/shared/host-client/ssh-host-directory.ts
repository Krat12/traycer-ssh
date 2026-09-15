import type { SshHostConnection } from "../platform/ssh-host";
import type { HostDirectoryEntry } from "./host-directory";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "./remote-fetcher";

export interface SshHostDirectoryEntry extends HostDirectoryEntry {
  readonly kind: "ssh";
  /** Registry incarnation identity; SSH still uses the direct bearer transport. */
  readonly publicKey: string;
}

/** The same registered Host keeps its incarnation identity across route changes. */
export function hostRegistryPublicKey(
  entry: HostDirectoryEntry,
): string | null {
  if (isRemoteHostDirectoryEntry(entry)) return entry.publicKey;
  if (
    entry.kind === "ssh" &&
    "publicKey" in entry &&
    typeof entry.publicKey === "string"
  ) {
    return entry.publicKey;
  }
  return null;
}

/** SSH is a route to another machine, never this shell's local Host. */
export function sshHostDirectoryEntry(
  connection: SshHostConnection,
  registered: RemoteHostDirectoryEntry,
): SshHostDirectoryEntry {
  return {
    hostId: registered.hostId,
    label: connection.profile.label,
    kind: "ssh",
    publicKey: registered.publicKey,
    websocketUrl:
      connection.state === "connected" ? connection.websocketUrl : null,
    version: connection.version,
    transportDialability:
      connection.state === "connected" && connection.websocketUrl !== null
        ? "dialable"
        : "not-dialable",
  };
}
