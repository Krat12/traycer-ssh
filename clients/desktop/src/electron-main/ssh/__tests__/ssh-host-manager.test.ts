// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshHostProfile } from "@traycer-clients/shared/platform/ssh-host";
import { SshHostManager } from "../ssh-host-manager";
import type { SshProfileStore } from "../ssh-profile-store";
import type { SshTransport, SshTunnel } from "../openssh-transport";
import { SshConnectionError } from "../ssh-validation";
import { setHostTransportDiagnosticSink } from "@traycer-clients/shared/host-transport/transport-diagnostics";

const profile: SshHostProfile = {
  hostId: "linux-host",
  label: "Development Linux",
  target: "dev-vm",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function tunnel(
  port: number,
): SshTunnel & { fail: (error: SshConnectionError) => void } {
  const close = deferred<SshConnectionError>();
  return {
    websocketUrl: `ws://127.0.0.1:${port}/rpc`,
    version: "1.2.3",
    closed: close.promise,
    dispose: vi.fn(),
    fail: close.resolve,
  };
}

function setup(profiles: readonly SshHostProfile[]) {
  const requests: {
    signal: AbortSignal;
    result: {
      promise: Promise<SshTunnel>;
      resolve: (value: SshTunnel) => void;
      reject: (error: Error) => void;
    };
  }[] = [];
  const store: SshProfileStore = {
    load: vi.fn(async () => profiles),
    save: vi.fn(async () => {}),
  };
  const transport: SshTransport = {
    connect: vi.fn((_profile, signal) => {
      const result = deferred<SshTunnel>();
      requests.push({ signal, result });
      return result.promise;
    }),
  };
  const manager = new SshHostManager(store, transport, null);
  return { manager, store, transport, requests };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SshHostManager", () => {
  it("emits safe lifecycle events for one tunnel and its retry", async () => {
    const events: Array<{ event: string; attempt?: number; reason?: string }> =
      [];
    const restore = setHostTransportDiagnosticSink((event) => {
      events.push({
        event: event.event,
        attempt: event.attempt,
        reason: event.reason,
      });
    });
    try {
      const { manager, requests } = setup([profile]);
      await manager.start();
      const first = tunnel(43000);
      requests[0]!.result.resolve(first);
      await settle();
      first.fail(new SshConnectionError("socket dropped", true));
      await settle();
      expect(events.map(({ event }) => event)).toEqual([
        "manager-attempt",
        "manager-connected",
        "manager-retry-scheduled",
      ]);
      expect(events[2]).toMatchObject({
        attempt: 1,
        reason: "socket dropped",
      });
      manager.dispose();
    } finally {
      restore();
    }
  });

  it("has no constructor side effects and restores routes exactly once before start returns", async () => {
    const { manager, store, transport } = setup([profile]);
    expect(store.load).not.toHaveBeenCalled();
    await Promise.all([manager.start(), manager.start()]);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toEqual([
      {
        profile,
        state: "connecting",
        websocketUrl: null,
        version: null,
        message: null,
      },
    ]);
    manager.dispose();
  });

  it("retains the SSH route during outage and rediscovers after a bounded backoff", async () => {
    vi.useFakeTimers();
    const { manager, requests } = setup([profile]);
    await manager.start();
    const first = tunnel(43000);
    requests[0]!.result.resolve(first);
    await settle();
    expect(manager.snapshot()[0]?.state).toBe("connected");
    first.fail(new SshConnectionError("Connection interrupted.", true));
    await settle();
    expect(manager.snapshot()[0]).toMatchObject({
      profile,
      state: "reconnecting",
      websocketUrl: null,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    requests[1]!.result.resolve(tunnel(43001));
    await settle();
    expect(manager.snapshot()[0]?.websocketUrl).toBe(
      "ws://127.0.0.1:43001/rpc",
    );
    manager.dispose();
  });

  it("does not retry host identity/key failures or silently discard the route", async () => {
    vi.useFakeTimers();
    const { manager, requests } = setup([profile]);
    await manager.start();
    requests[0]!.result.reject(
      new SshConnectionError("Host identity mismatch.", false),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);
    expect(manager.snapshot()[0]).toMatchObject({
      profile,
      state: "error",
      websocketUrl: null,
    });
    manager.dispose();
  });

  it("removal cancels discovery and refuses its late tunnel result", async () => {
    const { manager, requests, store } = setup([profile]);
    await manager.start();
    await manager.remove(profile.hostId);
    expect(store.save).toHaveBeenCalledWith([]);
    expect(requests[0]!.signal.aborted).toBe(true);
    const stale = tunnel(43000);
    requests[0]!.result.resolve(stale);
    await settle();
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(await manager.list()).toEqual([]);
    manager.dispose();
  });

  it("waking cancels only owned tunnels and stale close events cannot poison a replacement", async () => {
    const { manager, requests } = setup([profile]);
    await manager.start();
    const first = tunnel(43000);
    requests[0]!.result.resolve(first);
    await settle();
    manager.resume();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(requests[0]!.signal.aborted).toBe(true);
    const replacement = tunnel(43001);
    requests[1]!.result.resolve(replacement);
    first.fail(new SshConnectionError("old disconnect", true));
    await settle();
    expect(manager.snapshot()[0]).toMatchObject({
      state: "connected",
      websocketUrl: replacement.websocketUrl,
    });
    manager.dispose();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it("failed persistence preserves the existing tunnel and profile", async () => {
    const { manager, requests, store } = setup([profile]);
    await manager.start();
    const first = tunnel(43000);
    requests[0]!.result.resolve(first);
    await settle();
    vi.mocked(store.save).mockRejectedValue(new Error("disk unavailable"));
    await expect(
      manager.save({ ...profile, target: "other-vm" }),
    ).rejects.toThrow("disk unavailable");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(manager.snapshot()[0]?.profile).toEqual(profile);
    manager.dispose();
  });

  it("corrupt persisted routes block startup instead of appearing as an empty fleet", async () => {
    const { manager, store, transport } = setup([]);
    vi.mocked(store.load).mockRejectedValue(
      new Error("Invalid saved profiles"),
    );
    await expect(manager.start()).rejects.toThrow("Invalid saved profiles");
    await expect(manager.list()).rejects.toThrow("Invalid saved profiles");
    expect(transport.connect).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("serializes concurrent profile writes so saving a second device cannot lose the first", async () => {
    const { manager, store } = setup([]);
    await manager.start();
    const other = { ...profile, hostId: "other-host", target: "other-vm" };
    await Promise.all([manager.save(profile), manager.save(other)]);
    expect(vi.mocked(store.save).mock.calls[1]?.[0]).toEqual([profile, other]);
    manager.dispose();
  });
});
