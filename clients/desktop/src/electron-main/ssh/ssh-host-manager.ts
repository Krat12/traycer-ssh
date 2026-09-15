import type {
  ISshHostManager,
  SshHostConnection,
  SshHostProfile,
} from "@traycer-clients/shared/platform/ssh-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { SshProfileStore } from "./ssh-profile-store";
import type { SshTransport, SshTunnel } from "./openssh-transport";
import { parseSshProfile, SshConnectionError } from "./ssh-validation";

interface Entry {
  connection: SshHostConnection;
  abort: AbortController;
  tunnel: SshTunnel | null;
  retry: NodeJS.Timeout | null;
  attempts: number;
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
      this.publish();
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
    entry.tunnel = null;
    const failure =
      error instanceof SshConnectionError
        ? error
        : new SshConnectionError(
            "SSH connection failed. Reconnect to try again.",
            false,
          );
    entry.connection = {
      ...entry.connection,
      state: failure.retryable ? "reconnecting" : "error",
      websocketUrl: null,
      message: failure.message,
    };
    if (failure.retryable) {
      const delay = Math.min(1_000 * 2 ** Math.min(entry.attempts, 5), 30_000);
      entry.attempts += 1;
      entry.retry = setTimeout(() => {
        entry.retry = null;
        void this.begin(entry);
      }, delay);
    }
    this.publish();
  }

  private stop(entry: Entry): void {
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    entry.abort.abort();
    entry.tunnel?.dispose();
    entry.tunnel = null;
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
