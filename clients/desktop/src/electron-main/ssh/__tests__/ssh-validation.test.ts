// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifySshFailure,
  parseRemoteSshHost,
  parseSshProfile,
} from "../ssh-validation";
import {
  discoveryArgs,
  tunnelArgs,
  SSH_DISCOVERY_COMMAND,
} from "../openssh-transport";

const profile = { hostId: "host-123", label: "Linux", target: "igor@dev-vm" };
function metadata(websocketUrl: string, hostId: string): string {
  return JSON.stringify({ hostId, websocketUrl, version: "1.2.3" });
}

describe("SSH route validation", () => {
  it.each([
    "-oProxyCommand=evil",
    "dev;touch /tmp/owned",
    "$(evil)",
    "dev\nother",
    "ssh://dev",
    "user@dev:22",
    "user@dev /bin/sh",
  ])("rejects options, URLs and shell syntax in destinations: %s", (target) => {
    expect(() => parseSshProfile({ ...profile, target })).toThrow();
  });
  it.each(["dev-vm", "igor@dev-vm", "192.168.0.13", "my.ssh.alias"])(
    "accepts a single SSH destination %s",
    (target) => {
      expect(parseSshProfile({ ...profile, target }).target).toBe(target);
    },
  );
  it("binds discovery to the existing registered Host identity", () => {
    expect(() =>
      parseRemoteSshHost(
        metadata("ws://127.0.0.1:7777/rpc", "other-host"),
        profile.hostId,
      ),
    ).toThrow("different Host");
    expect(
      parseRemoteSshHost(
        metadata("ws://127.0.0.1:7777/rpc", profile.hostId),
        profile.hostId,
      ),
    ).toEqual({ hostname: "127.0.0.1", port: 7777, version: "1.2.3" });
  });
  it.each([
    "ws://evil.example:7777/rpc",
    "ws://0.0.0.0:7777/rpc",
    "ws://localhost:7777/rpc",
    "wss://127.0.0.1:7777/rpc",
    "ws://127.0.0.1:7777/admin",
    "ws://127.0.0.1:7777/rpc?secret=1",
    "ws://user:secret@127.0.0.1:7777/rpc",
    "ws://127.0.0.1:7777/rpc#secret",
  ])("refuses an endpoint outside the loopback RPC surface: %s", (url) => {
    expect(() =>
      parseRemoteSshHost(metadata(url, profile.hostId), profile.hostId),
    ).toThrow();
  });
  it("bounds discovery output and rejects non-JSON login banners", () => {
    expect(() =>
      parseRemoteSshHost("x".repeat(16_385), profile.hostId),
    ).toThrow("too large");
    expect(() =>
      parseRemoteSshHost("Welcome to Linux!\n{}", profile.hostId),
    ).toThrow("Cannot read");
  });
  it("pins SSH verification and isolates multiplexing, binds forwarding only to loopback", () => {
    const args = tunnelArgs(profile.target, 12345, {
      hostname: "[::1]",
      port: 7777,
      version: null,
    });
    for (const flag of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "ControlPath=none",
      "ForwardAgent=no",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "ExitOnForwardFailure=yes",
    ])
      expect(args).toContain(flag);
    expect(args).toContain("127.0.0.1:12345:[::1]:7777");
    expect(args.slice(-2)).toEqual(["--", profile.target]);
    expect(discoveryArgs(profile.target).slice(-2)).toEqual([
      profile.target,
      SSH_DISCOVERY_COMMAND,
    ]);
    expect(SSH_DISCOVERY_COMMAND).not.toMatch(
      /install|restart|update|kill|credentials/,
    );
  });
  it.each([
    { operation: "discovery", args: discoveryArgs(profile.target) },
    {
      operation: "tunnel",
      args: tunnelArgs(profile.target, 12345, {
        hostname: "127.0.0.1",
        port: 7777,
        version: null,
      }),
    },
  ])(
    "allows only the pre-8.7 compatibility exception before its option for $operation",
    ({ args }) => {
      expect(args.filter((arg) => arg.startsWith("IgnoreUnknown="))).toEqual([
        "IgnoreUnknown=ForkAfterAuthentication",
      ]);
      const ignoreIndex = args.indexOf("IgnoreUnknown=ForkAfterAuthentication");
      const forkIndex = args.indexOf("ForkAfterAuthentication=no");
      expect(ignoreIndex).toBeGreaterThan(0);
      expect(ignoreIndex).toBeLessThan(forkIndex);
      expect(args[ignoreIndex - 1]).toBe("-o");
      expect(args[forkIndex - 1]).toBe("-o");
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).toContain("BatchMode=yes");
    },
  );
  it("never forwards raw SSH diagnostics, paths or tokens to the renderer", () => {
    const raw =
      "/home/secret/key: Permission denied https://private.invalid?token=SECRET";
    const error = classifySshFailure(raw);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("key authentication failed");
    expect(error.message).not.toMatch(/SECRET|\/home|private.invalid/);
  });
});
