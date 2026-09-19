import type {
  ISshHostManager,
  SshHostConnection,
  SshHostProfile,
} from "@traycer-clients/shared/platform/ssh-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { SshProfileStore } from "./ssh-profile-store";
import type { SshTransport, SshTunnel } from "./openssh-transport";
import { parseSshProfile, SshConnectionError } from "./ssh-validation";
import { reportHostTransportDiagnostic } from "@traycer-clients/shared/host-transport/transport-diagnostics";
import type { RemoteSshDiagnosticSnapshot } from "./ssh-remote-diagnostics";

interface Entry {
  connection: SshHostConnection;
  abort: AbortController;
  tunnel: SshTunnel | null;
  retry: NodeJS.Timeout | null;
  attempts: number;
  healthTimer: NodeJS.Timeout | null;
  healthFailures: number;
}

/** One owner per app. Renderer windows only observe its snapshots. */
export class SshHostManager implements ISshHostManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<
    (connections: readonly SshHostConnection[]) => void
  >();
  private ready: Promise<void> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly store: SshProfileStore,
    private readonly transport: SshTransport,
    private readonly remoteDiagnostic:
      | ((profile: SshHostProfile) => Promise<RemoteSshDiagnosticSnapshot>)
      | null,
    private readonly probe:
      | ((url: string, signal: AbortSignal) => Promise<boolean>)
      | null,
  ) {}

  start(): Promise<void> {
    this.ready ??= this.restore();
    return this.ready;
  }

  snapshot(): readonly SshHostConnection[] {
    return [...this.entries.values()].map((entry) => entry.connection);
  }

  async list(): Promise<readonly SshHostConnection[]> {
    await this.start();
    return this.snapshot();
  }

  onChange(
    handler: (connections: readonly SshHostConnection[]) => void,
  ): Disposable {
    this.listeners.add(handler);
    return {
      dispose: () => {
        this.listeners.delete(handler);
      },
    };
  }

  save(value: SshHostProfile): Promise<void> {
    const profile = parseSshProfile(value);
    return this.mutate(async () => {
      const profiles = this.snapshot()
        .map((connection) => connection.profile)
        .filter((row) => row.hostId !== profile.hostId);
      if (profiles.length >= 32)
        throw new Error("At most 32 SSH devices can be saved.");
      await this.store.save([...profiles, profile]);
      const previous = this.entries.get(profile.hostId);
      if (previous) this.stop(previous);
      if (!this.disposed) this.add(profile);
    });
  }

  remove(hostId: string): Promise<void> {
    return this.mutate(async () => {
      const entry = this.entries.get(hostId);
      if (!entry) return;
      await this.store.save(
        this.snapshot()
          .map((row) => row.profile)
          .filter((row) => row.hostId !== hostId),
      );
      this.stop(entry);
      this.entries.delete(hostId);
      this.publish();
    });
  }

  reconnect(hostId: string): Promise<void> {
    return this.mutate(async () => {
      const entry = this.entries.get(hostId);
      if (!entry) throw new Error("SSH device was removed.");
      this.stop(entry);
      entry.attempts = 0;
      void this.captureRemoteDiagnostic(entry.connection.profile);
      void this.begin(entry);
    });
  }

  /** Wake invalidates old TCP connections without touching the remote Host. */
  resume(): void {
    for (const entry of this.entries.values()) {
      this.stop(entry);
      entry.attempts = 0;
      void this.begin(entry);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) this.stop(entry);
    this.listeners.clear();
  }

  private async restore(): Promise<void> {
    const profiles = await this.store.load();
    if (this.disposed) return;
    for (const profile of profiles) this.add(profile);
  }

  private add(profile: SshHostProfile): void {
    const entry: Entry = {
      connection: {
        profile,
        state: "connecting",
        websocketUrl: null,
        version: null,
        message: null,
      },
      abort: new AbortController(),
      tunnel: null,
      retry: null,
      attempts: 0,
      healthTimer: null,
      healthFailures: 0,
    };
    this.entries.set(profile.hostId, entry);
    void this.begin(entry);
  }

  private async begin(entry: Entry): Promise<void> {
    if (this.disposed) return;
    const abort = new AbortController();
    entry.abort = abort;
    entry.connection = {
      ...entry.connection,
      state: entry.attempts ? "reconnecting" : "connecting",
      websocketUrl: null,
    };
    reportHostTransportDiagnostic({
      plane: "ssh",
      event: "manager-attempt",
      hostId: entry.connection.profile.hostId,
      attempt: entry.attempts,
      state: entry.attempts ? "reconnecting" : "connecting",
    });
    this.publish();
    try {
      const tunnel = await this.transport.connect(
        entry.connection.profile,
        abort.signal,
      );
      if (abort.signal.aborted || this.disposed || entry.abort !== abort) {
        tunnel.dispose();
        return;
      }
      entry.tunnel = tunnel;
      entry.attempts = 0;
      entry.connection = {
        ...entry.connection,
        state: "connected",
        websocketUrl: tunnel.websocketUrl,
        version: tunnel.version,
        message: null,
      };
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "manager-connected",
        hostId: entry.connection.profile.hostId,
        state: "connected",
      });
      this.publish();
      this.scheduleHealth(entry, abort, tunnel);
      void tunnel.closed.then((error) => {
        if (!abort.signal.aborted && entry.abort === abort && !this.disposed)
          this.failed(entry, error);
      });
    } catch (error) {
      if (!abort.signal.aborted && entry.abort === abort && !this.disposed)
        this.failed(entry, error);
    }
  }

  private failed(entry: Entry, error: unknown): void {
    this.stop(entry);
    const failure =
      error instanceof SshConnectionError
        ? error
        : new SshConnectionError(
            "SSH connection failed. Reconnect to try again.",
            false,
          );
    const hostId = entry.connection.profile.hostId;
    entry.connection = {
      ...entry.connection,
      state: failure.retryable ? "reconnecting" : "error",
      websocketUrl: null,
      message: failure.message,
    };
    if (failure.retryable) {
      const delay = Math.min(1_000 * 2 ** Math.min(entry.attempts, 5), 30_000);
      entry.attempts += 1;
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "manager-retry-scheduled",
        hostId,
        attempt: entry.attempts,
        delayMs: delay,
        state: "reconnecting",
        retryable: true,
        reason: failure.message,
      });
      entry.retry = setTimeout(() => {
        entry.retry = null;
        void this.begin(entry);
      }, delay);
    } else {
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "manager-terminal-failure",
        hostId,
        attempt: entry.attempts,
        state: "error",
        retryable: false,
        reason: failure.message,
      });
    }
    this.publish();
  }

  private stop(entry: Entry): void {
    if (entry.healthTimer) clearTimeout(entry.healthTimer);
    entry.healthTimer = null;
    entry.healthFailures = 0;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    entry.abort.abort();
    entry.tunnel?.dispose();
    entry.tunnel = null;
  }

  private scheduleHealth(
    entry: Entry,
    abort: AbortController,
    tunnel: SshTunnel,
  ): void {
    if (this.probe === null) return;
    entry.healthTimer = setTimeout(() => {
      entry.healthTimer = null;
      void this.checkHealth(entry, abort, tunnel);
    }, 30_000);
  }

  private async checkHealth(
    entry: Entry,
    abort: AbortController,
    tunnel: SshTunnel,
  ): Promise<void> {
    const healthy = await this.probe?.(tunnel.websocketUrl, abort.signal).catch(
      () => false,
    );
    if (abort.signal.aborted || entry.abort !== abort || this.disposed) return;
    entry.healthFailures = healthy ? 0 : entry.healthFailures + 1;
    reportHostTransportDiagnostic({
      plane: "ssh",
      event: "host-health",
      hostId: entry.connection.profile.hostId,
      state: healthy ? "responsive" : "unresponsive",
      attempt: entry.healthFailures,
    });
    if (entry.healthFailures >= 3) {
      // SSH may remain alive across a Host restart. Re-read metadata to learn
      // its new port instead of forever forwarding into the old listener.
      this.failed(
        entry,
        new SshConnectionError(
          "Host is not responding. Rediscovering its SSH endpoint.",
          true,
        ),
      );
      return;
    }
    this.scheduleHealth(entry, abort, tunnel);
  }

  private async captureRemoteDiagnostic(
    profile: SshHostProfile,
  ): Promise<void> {
    if (this.remoteDiagnostic === null) return;
    try {
      const snapshot = await this.remoteDiagnostic(profile);
      const service = Object.entries(snapshot.service)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      const pid = Object.entries(snapshot.pid)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "remote-snapshot",
        hostId: profile.hostId,
        state: snapshot.timedOut
          ? "timed-out"
          : snapshot.aborted
            ? "aborted"
            : "complete",
        reason: `exit=${snapshot.exitCode ?? "none"}; service=${service || "none"}; pid=${pid || "none"}; sockets=${snapshot.sockets.length}; processes=${snapshot.processes.length}`,
      });
      for (const socket of snapshot.sockets)
        reportHostTransportDiagnostic({
          plane: "ssh",
          event: "remote-socket",
          hostId: profile.hostId,
          reason: socket,
        });
      for (const process of snapshot.processes)
        reportHostTransportDiagnostic({
          plane: "ssh",
          event: "remote-process",
          hostId: profile.hostId,
          reason: process,
        });
    } catch (error) {
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "remote-snapshot-failed",
        hostId: profile.hostId,
        reason: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  private mutate(action: () => Promise<void>): Promise<void> {
    const operation = this.mutations.then(async () => {
      await this.start();
      if (this.disposed) throw new Error("SSH manager is shutting down.");
      await action();
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
