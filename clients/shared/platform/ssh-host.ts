import type { Disposable } from "./uri-callback";

/** A route to an existing, signed-in Linux Host; never a new Host identity. */
export interface SshHostProfile {
  readonly hostId: string;
  readonly label: string;
  /** An OpenSSH config alias or user@hostname, interpreted by system OpenSSH. */
  readonly target: string;
}

export type SshHostConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SshHostConnection {
  readonly profile: SshHostProfile;
  readonly state: SshHostConnectionState;
  readonly websocketUrl: string | null;
  readonly version: string | null;
  /** Sanitized, user-facing status; never raw SSH output or credentials. */
  readonly message: string | null;
}

/** Persisted profiles connect on launch. Removing one restores the cloud route. */
export interface ISshHostManager {
  list(): Promise<readonly SshHostConnection[]>;
  save(profile: SshHostProfile): Promise<void>;
  remove(hostId: string): Promise<void>;
  reconnect(hostId: string): Promise<void>;
  onChange(
    handler: (connections: readonly SshHostConnection[]) => void,
  ): Disposable;
}
