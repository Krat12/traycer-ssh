import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import type { SshHostProfile } from "@traycer-clients/shared/platform/ssh-host";
import { reportHostTransportDiagnostic } from "@traycer-clients/shared/host-transport/transport-diagnostics";
import {
  classifySshFailure,
  parseRemoteSshHost,
  SshConnectionError,
  type RemoteSshHost,
} from "./ssh-validation";

// No profile data ever enters a remote command. This reads one bounded file;
// it never invokes Traycer CLI, installs a Host, or changes the remote machine.
export const SSH_DISCOVERY_COMMAND =
  'test "$(uname -s)" = Linux && test -f "$HOME/.traycer/host/pid.json" && head -c 16385 -- "$HOME/.traycer/host/pid.json"';

const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ConnectionAttempts=1",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
  "-o",
  // Windows can ship OpenSSH older than 8.7, when this option was added.
  // Known options still apply; older clients cannot fork via their config.
  "IgnoreUnknown=ForkAfterAuthentication",
  "-o",
  "ForkAfterAuthentication=no",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "RemoteCommand=none",
  "-o",
  "LogLevel=ERROR",
] as const;

export interface SshTunnel {
  readonly websocketUrl: string;
  readonly version: string | null;
  readonly closed: Promise<SshConnectionError>;
  dispose(): void;
}

export interface SshTransport {
  connect(profile: SshHostProfile, signal: AbortSignal): Promise<SshTunnel>;
}

function sshExecutable(): string {
  // Do not resolve ssh.exe beside a workspace executable on Windows.
  return process.platform === "win32"
    ? join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "OpenSSH",
        "ssh.exe",
      )
    : "/usr/bin/ssh";
}

export function discoveryArgs(target: string): string[] {
  return [
    ...SSH_OPTIONS,
    "-o",
    "PermitLocalCommand=no",
    "--",
    target,
    SSH_DISCOVERY_COMMAND,
  ];
}

export function tunnelArgs(
  target: string,
  localPort: number,
  remote: RemoteSshHost,
): string[] {
  return [
    ...SSH_OPTIONS,
    "-o",
    "PermitLocalCommand=yes",
    "-o",
    "LocalCommand=echo TRAYCER_SSH_FORWARD_READY",
    "-N",
    "-L",
    `127.0.0.1:${localPort}:${remote.hostname}:${remote.port}`,
    "--",
    target,
  ];
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new SshConnectionError(
          "Cannot allocate a local SSH tunnel port.",
          true,
        ),
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new SshConnectionError(
            "Cannot allocate a local SSH tunnel port.",
            true,
          ),
        );
        return;
      }
      server.close((error) =>
        error
          ? reject(
              new SshConnectionError(
                "Cannot allocate a local SSH tunnel port.",
                true,
              ),
            )
          : resolve(address.port),
      );
    });
  });
}

function readRemoteMetadata(
  target: string,
  hostId: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SshConnectionError("SSH connection cancelled.", false));
      return;
    }
    reportHostTransportDiagnostic({
      plane: "ssh",
      event: "discovery-start",
      hostId,
    });
    const child = spawn(sshExecutable(), discoveryArgs(target), {
      windowsHide: true,
      stdio: "pipe",
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const complete = (error: SshConnectionError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      child.kill();
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "discovery-finish",
        hostId,
        state: error === null ? "success" : "failed",
        retryable: error?.retryable,
        reason: error?.message,
      });
      if (error) reject(error);
      else resolve(stdout);
    };
    const abort = (): void =>
      complete(new SshConnectionError("SSH connection cancelled.", false));
    const deadline = setTimeout(
      () =>
        complete(
          new SshConnectionError(
            "SSH discovery timed out. Retrying automatically.",
            true,
          ),
        ),
      20_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 16_384)
        complete(
          new SshConnectionError("Remote Host metadata is too large.", false),
        );
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-32_768);
    });
    child.once("error", () =>
      complete(
        new SshConnectionError(
          "Cannot start system OpenSSH. Install the OpenSSH Client Windows feature.",
          false,
        ),
      ),
    );
    child.once("close", (code) =>
      complete(
        code === 0
          ? null
          : code === 255
            ? classifySshFailure(stderr)
            : new SshConnectionError(
                "Cannot read Linux Host metadata. Check the SSH account and that Traycer Host is running; retrying automatically.",
                true,
              ),
      ),
    );
  });
}

function openTunnel(
  target: string,
  hostId: string,
  localPort: number,
  remote: RemoteSshHost,
  signal: AbortSignal,
): Promise<SshTunnel> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SshConnectionError("SSH connection cancelled.", false));
      return;
    }
    reportHostTransportDiagnostic({
      plane: "ssh",
      event: "tunnel-start",
      hostId,
    });
    const child = spawn(
      sshExecutable(),
      tunnelArgs(target, localPort, remote),
      { windowsHide: true, stdio: "pipe" },
    );
    child.stdin.end();
    let stderr = "";
    let stdout = "";
    let ready = false;
    let finished = false;
    let closeTunnel: (error: SshConnectionError) => void = () => {};
    const closed = new Promise<SshConnectionError>((close) => {
      closeTunnel = close;
    });
    const finish = (error: SshConnectionError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      child.kill();
      reportHostTransportDiagnostic({
        plane: "ssh",
        event: "tunnel-finish",
        hostId,
        state: ready ? "closed" : "failed",
        retryable: error.retryable,
        reason: error.message,
      });
      if (!ready) reject(error);
      closeTunnel(error);
    };
    const abort = (): void =>
      finish(new SshConnectionError("SSH connection cancelled.", false));
    const deadline = setTimeout(
      () =>
        finish(
          new SshConnectionError(
            "SSH tunnel timed out. Retrying automatically.",
            true,
          ),
        ),
      20_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-32_768);
      // Forward failures can occur after SSH itself connected (e.g. a Host
      // restart changed its port). Reconnect rediscovers current pid metadata.
      if (ready && /open failed:|administratively prohibited/.test(stderr))
        finish(classifySshFailure(stderr));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-256);
      // LocalCommand runs after authentication and local forward setup. With
      // -N there is no remote stdout; this marker is emitted by our fixed
      // local echo, supported by Windows OpenSSH's system(args) and POSIX sh.
      // Probing the freed port could mistake a competing listener for our SSH.
      if (
        !ready &&
        !finished &&
        stdout.trim() === "TRAYCER_SSH_FORWARD_READY"
      ) {
        ready = true;
        clearTimeout(deadline);
        reportHostTransportDiagnostic({
          plane: "ssh",
          event: "tunnel-ready",
          hostId,
        });
        resolve({
          websocketUrl: `ws://127.0.0.1:${localPort}/rpc`,
          version: remote.version,
          closed,
          dispose: abort,
        });
      }
    });
    child.once("error", () =>
      finish(
        new SshConnectionError(
          "Cannot start system OpenSSH. Install the OpenSSH Client Windows feature.",
          false,
        ),
      ),
    );
    child.once("close", () => finish(classifySshFailure(stderr)));
  });
}

export class OpenSshTransport implements SshTransport {
  async connect(
    profile: SshHostProfile,
    signal: AbortSignal,
  ): Promise<SshTunnel> {
    const raw = await readRemoteMetadata(
      profile.target,
      profile.hostId,
      signal,
    );
    const remote = parseRemoteSshHost(raw, profile.hostId);
    const port = await reservePort();
    return await openTunnel(
      profile.target,
      profile.hostId,
      port,
      remote,
      signal,
    );
  }
}
