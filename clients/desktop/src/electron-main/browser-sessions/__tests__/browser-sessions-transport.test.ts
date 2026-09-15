import { afterEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { openBrowserSessionsTransport } from "../browser-sessions-transport";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

afterEach(() => retireAllRemoteSessions());

describe("main browser transport ownership", () => {
  it("closes its stream client immediately while a sibling holds the remote session", () => {
    const target: RemoteHostDirectoryEntry = {
      hostId: "browser-host",
      label: "Linux",
      kind: "remote",
      websocketUrl: "wss://relay.test/attach",
      version: "1.3.1",
      transportDialability: "dialable",
      publicKey: Buffer.alloc(32, 1).toString("base64"),
      relayFuseGrace: false,
      recentHostCheckIn: false,
      planAllowsRemote: true,
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.3.1",
        lastSeenAt: null,
      },
    };
    const lease = new MutableBearerLease("test-bearer", "user-a");
    const deps = {
      authnBaseUrl: () => "https://auth.test",
      bearer: () => lease,
      // Exercise ownership before dialing; no cloud grant or network is used.
      cloudAuthorized: () => false,
      endpoint: () => null,
      appVersion: "1.3.1",
    };
    const first = openBrowserSessionsTransport(target, "user-a", deps);
    const sibling = openBrowserSessionsTransport(target, "user-a", deps);
    if (first === null || sibling === null)
      throw new Error("Expected remote transports");
    const closed = vi.fn();
    first.wsStreamClient.onClosed(closed);

    first.close();
    first.close();

    expect(first.wsStreamClient.isClosed()).toBe(true);
    expect(first.wsStreamClient.getClosedReason()).toBe(
      "browser-sessions-stream-closed",
    );
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sibling.wsStreamClient.isClosed()).toBe(false);
    sibling.close();
  });
});
