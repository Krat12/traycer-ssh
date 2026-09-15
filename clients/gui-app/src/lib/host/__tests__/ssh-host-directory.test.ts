import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  RemoteHostDirectoryEntry,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  hostUnavailability,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  ISshHostManager,
  SshHostConnection,
} from "@traycer-clients/shared/platform/ssh-host";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import {
  dialableHostEndpoint,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";
import { buildHostKeyRotationSweep } from "@/lib/host/host-key-rotation-sweep";

// Only the persistence key belongs to this directory test. Importing the
// barrel's wipe implementation also boots unrelated draft/image stores.
vi.mock("@/lib/persist", () => import("@/lib/persist/keys"));

const registeredEntry: RemoteHostDirectoryEntry = {
  ...mockRemoteHostEntry,
  publicKey: "registered-linux-key",
  relayFuseGrace: false,
  recentHostCheckIn: false,
  planAllowsRemote: true,
  transportDialability: "not-dialable",
  remoteStatus: {
    connectivity: "offline",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: "1.3.1",
    lastSeenAt: null,
  },
};

const directories: HostDirectoryService[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) directory.dispose();
  window.localStorage.clear();
});

function connection(
  state: SshHostConnection["state"],
  port: number,
): SshHostConnection {
  return {
    profile: {
      hostId: mockRemoteHostEntry.hostId,
      label: "Linux dev",
      target: "linux-dev",
    },
    state,
    websocketUrl: state === "connected" ? `ws://127.0.0.1:${port}/rpc` : null,
    version: "1.3.1",
    message: null,
  };
}

function harness() {
  let connections: readonly SshHostConnection[] = [
    connection("connected", 44001),
  ];
  const listeners = new Set<(value: readonly SshHostConnection[]) => void>();
  const manager: ISshHostManager = {
    list: () => Promise.resolve(connections),
    save: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(() => Promise.resolve()),
    onChange: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://auth.test/sign-in",
      authnBaseUrl: "https://auth.test",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: false,
      traycerCli: undefined,
    }),
    { sshHosts: manager },
  );
  let outcome: RemoteHostFetchOutcome = {
    kind: "hosts",
    entries: [registeredEntry],
  };
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () => Promise.resolve(outcome),
    onRegistryPollTick: null,
    authContextId: null,
    credentialGeneration: null,
    localHostIdSeeder: () => Promise.resolve(null),
  });
  directories.push(directory);
  return {
    directory,
    manager,
    listeners,
    setOutcome: (next: RemoteHostFetchOutcome) => {
      outcome = next;
    },
    push: (next: readonly SshHostConnection[]) => {
      connections = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe("SSH route over an existing account Host", () => {
  it("never publishes the relay while persisted SSH profiles are still loading", async () => {
    const fixture = harness();
    let resolveProfiles: (
      connections: readonly SshHostConnection[],
    ) => void = () => undefined;
    vi.spyOn(fixture.manager, "list").mockReturnValue(
      new Promise((resolve) => {
        resolveProfiles = resolve;
      }),
    );
    const published: HostDirectoryEntry[] = [];
    fixture.directory.onChange((entries) => {
      published.push(...entries);
    });
    const start = fixture.directory.startSeeded();
    // A cached registry can also arrive from a caller independent of startup.
    // Even that immediate result must not get ahead of the SSH route choice.
    await fixture.directory.refresh();
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)).toBeNull();
    expect(fixture.directory.hasSettledFleet()).toBe(false);
    expect(fixture.directory.getCardinality()).toBe("unknown");
    resolveProfiles([connection("connected", 44001)]);
    await start;
    await fixture.directory.refresh();
    expect(published.some((entry) => entry.kind === "ssh")).toBe(true);
    expect(published.some((entry) => entry.kind === "remote")).toBe(false);
  });

  it("does not fall back to relay when the initial SSH profile read fails", async () => {
    const fixture = harness();
    vi.spyOn(fixture.manager, "list").mockRejectedValue(
      new Error("IPC failed"),
    );
    await fixture.directory.start();
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)).toBeNull();
    expect(fixture.directory.hasSettledFleet()).toBe(false);
    fixture.push([connection("connected", 44002)]);
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)?.kind).toBe(
      "ssh",
    );
    expect(fixture.directory.hasSettledFleet()).toBe(true);
  });

  it("keeps Linux identity and SSH available when the cloud listing fails", async () => {
    const fixture = harness();
    await fixture.directory.start();
    const entry = fixture.directory.findById(mockRemoteHostEntry.hostId);
    expect(entry).toMatchObject({
      hostId: mockRemoteHostEntry.hostId,
      kind: "ssh",
      transportDialability: "dialable",
      publicKey: registeredEntry.publicKey,
    });
    expect(entry).not.toHaveProperty("remoteStatus");
    expect(entry).not.toHaveProperty("planAllowsRemote");
    expect(entry !== null && isRemoteHostDirectoryEntry(entry)).toBe(false);
    expect(dialableHostEndpoint(entry)?.websocketUrl).toBe(
      "ws://127.0.0.1:44001/rpc",
    );
    expect(fixture.directory.getLocalEntry()).toBeNull();
    expect(fixture.directory.getLocalHostId()).toBeNull();
    fixture.setOutcome({ kind: "failed" });
    await fixture.directory.refresh();
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)).toEqual(
      entry,
    );
  });

  it("holds the owner across an outage, follows a new tunnel port and restores relay only on removal", async () => {
    const fixture = harness();
    await fixture.directory.start();
    const first = fixture.directory.findById(mockRemoteHostEntry.hostId);
    const owner = remoteAwareOwnerIdentityKey(first, "user-1");
    fixture.push([connection("reconnecting", 44001)]);
    const reconnecting = fixture.directory.findById(mockRemoteHostEntry.hostId);
    expect(reconnecting?.kind).toBe("ssh");
    expect(dialableHostEndpoint(reconnecting)).toBeNull();
    expect(
      reconnecting === null ? null : hostUnavailability(reconnecting),
    ).toBe("indeterminate");
    expect(remoteAwareOwnerIdentityKey(reconnecting, "user-1")).toBe(owner);
    fixture.push([connection("connected", 44002)]);
    const recovered = fixture.directory.findById(mockRemoteHostEntry.hostId);
    expect(dialableHostEndpoint(recovered)?.websocketUrl).toBe(
      "ws://127.0.0.1:44002/rpc",
    );
    expect(remoteAwareOwnerIdentityKey(recovered, "user-1")).toBe(owner);
    fixture.push([]);
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)).toEqual(
      registeredEntry,
    );
  });

  it("publishes and sweeps an SSH Host re-enrollment even when its tunnel endpoint stays unchanged", async () => {
    const fixture = harness();
    const sweepHostScope = vi.fn();
    const sweep = buildHostKeyRotationSweep({ sweepHostScope });
    const changes = vi.fn((entries: readonly HostDirectoryEntry[]) =>
      sweep(entries),
    );
    fixture.directory.onChange(changes);
    await fixture.directory.start();
    const before = fixture.directory.findById(mockRemoteHostEntry.hostId);
    changes.mockClear();
    const reenrolledEntry: RemoteHostDirectoryEntry = {
      ...registeredEntry,
      publicKey: "reenrolled-key",
    };
    fixture.setOutcome({
      kind: "hosts",
      entries: [reenrolledEntry],
    });
    await fixture.directory.refresh();
    const after = fixture.directory.findById(mockRemoteHostEntry.hostId);
    expect(after).toMatchObject({
      kind: "ssh",
      publicKey: "reenrolled-key",
      websocketUrl: before?.websocketUrl,
    });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(sweepHostScope).toHaveBeenCalledExactlyOnceWith(
      mockRemoteHostEntry.hostId,
    );
    expect(remoteAwareOwnerIdentityKey(after, "user-1")).not.toBe(
      remoteAwareOwnerIdentityKey(before, "user-1"),
    );
    await fixture.directory.refresh();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(sweepHostScope).toHaveBeenCalledTimes(1);
  });

  it("cannot introduce unregistered hosts and releases its native subscription", async () => {
    const fixture = harness();
    fixture.setOutcome({ kind: "hosts", entries: [] });
    await fixture.directory.start();
    expect(await fixture.directory.list()).toEqual([]);
    fixture.setOutcome({ kind: "hosts", entries: [registeredEntry] });
    await fixture.directory.refresh();
    expect(await fixture.directory.list()).toHaveLength(1);
    fixture.setOutcome({ kind: "signed-out" });
    await fixture.directory.refresh();
    expect(await fixture.directory.list()).toEqual([]);
    fixture.directory.dispose();
    expect(fixture.listeners.size).toBe(0);
  });

  it("never substitutes relay for a saved SSH profile when an injected registry row is incomplete", async () => {
    const fixture = harness();
    fixture.setOutcome({ kind: "hosts", entries: [mockRemoteHostEntry] });
    await fixture.directory.start();
    expect(fixture.directory.findById(mockRemoteHostEntry.hostId)).toBeNull();
    fixture.setOutcome({ kind: "hosts", entries: [registeredEntry] });
    await fixture.directory.refresh();
    expect(
      fixture.directory.findById(mockRemoteHostEntry.hostId),
    ).toMatchObject({
      kind: "ssh",
      publicKey: registeredEntry.publicKey,
    });
  });
});
