// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagnosticArgs,
  parseDiagnosticOutput,
  SSH_DIAGNOSTIC_COMMAND,
  collectRemoteSshDiagnostic,
} from "../ssh-remote-diagnostics";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

class Child extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => mock.spawn.mockReset());

describe("remote SSH diagnostics", () => {
  it("uses a fixed read-only command and separates target argv", () => {
    const args = diagnosticArgs("user@devvm");
    expect(args.at(-2)).toBe("user@devvm");
    expect(args.at(-1)).toBe(SSH_DIAGNOSTIC_COMMAND);
    expect(SSH_DIAGNOSTIC_COMMAND).toContain("systemctl --user show");
    expect(SSH_DIAGNOSTIC_COMMAND).toContain("ss -Htanp");
    expect(SSH_DIAGNOSTIC_COMMAND).not.toMatch(
      /restart|kill|pkill|systemctl stop/,
    );
  });

  it("parses service, pid, socket and process sections and redacts token-like values", () => {
    const parsed = parseDiagnosticOutput(
      [
        "__TRAYCER_SSH_DIAGNOSTIC_V1__",
        "[service]",
        "ActiveState=active",
        "NRestarts=0",
        "[pid]",
        '{"hostId":"h","version":"1.3.1","pid":42,"token":"secret"}',
        "[sockets]",
        'ESTAB 0 0 127.0.0.1:1 127.0.0.1:2 users:(("sshd",pid=3,fd=4))',
        "[processes]",
        " 42 1 MainThread 99.0 2.0 10",
      ].join("\n"),
    );
    expect(parsed.service).toEqual({ ActiveState: "active", NRestarts: "0" });
    expect(parsed.pid).toEqual({ version: "1.3.1", pid: "42" });
    expect(parsed.sockets).toHaveLength(1);
    expect(parsed.processes[0]).toContain("MainThread");
  });

  it("bounds and settles a diagnostic subprocess on timeout", async () => {
    vi.useFakeTimers();
    const child = new Child();
    mock.spawn.mockReturnValue(child);
    const resultPromise = collectRemoteSshDiagnostic(
      { target: "devvm" },
      { timeoutMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;
    expect(result.timedOut).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
