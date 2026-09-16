import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SshHostProfile } from "@traycer-clients/shared/platform/ssh-host";

/**
 * Fixed, read-only command used for incident evidence on a Linux Host.
 *
 * It deliberately does not invoke Traycer CLI, restart a service, signal a
 * process, read command lines, or print environment variables. The socket
 * listing is limited to loopback and the process listing contains only stable
 * accounting fields, so this can be safely attached to a connection report.
 */
export const SSH_DIAGNOSTIC_COMMAND = [
  "printf '%s\\n' '__TRAYCER_SSH_DIAGNOSTIC_V1__'",
  "printf '%s\\n' '[service]'",
  "systemctl --user show ai.traycer.host.service -p ActiveState -p SubState -p MainPID -p NRestarts -p Result --no-pager 2>/dev/null || true",
  "printf '%s\\n' '[pid]'",
  "head -c 16385 -- \"$HOME/.traycer/host/pid.json\" 2>/dev/null || true; printf '\\n'",
  "printf '%s\\n' '[sockets]'",
  "ss -Htanp 2>/dev/null | awk '$4 ~ /^127\\.0\\.0\\.1:/ || $5 ~ /^127\\.0\\.0\\.1:/ {print}' | head -n 256 || true",
  "printf '%s\\n' '[processes]'",
  "ps -eo pid=,ppid=,comm=,pcpu=,pmem=,etimes= --sort=-pcpu 2>/dev/null | head -n 48 || true",
].join("; ");

const MAX_STDOUT_BYTES = 96 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

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
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
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

function sshExecutable(): string {
  return process.platform === "win32"
    ? join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "OpenSSH",
        "ssh.exe",
      )
    : "/usr/bin/ssh";
}

/** Kept separate from discoveryArgs so this diagnostic cannot affect tunnel setup. */
export function diagnosticArgs(target: string): string[] {
  return [
    ...SSH_OPTIONS,
    "-o",
    "PermitLocalCommand=no",
    "--",
    target,
    SSH_DIAGNOSTIC_COMMAND,
  ];
}

export interface RemoteSshDiagnosticSnapshot {
  readonly capturedAt: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly service: Readonly<Record<string, string>>;
  readonly pid: Readonly<Record<string, string>>;
  readonly sockets: readonly string[];
  readonly processes: readonly string[];
  readonly stderr: string;
}

function boundedAppend(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  const value = current + chunk;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(-maxBytes).toString("utf8");
}

function safeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:token|key|secret|password)[=:])[^,\s]+/gi, "$1[redacted]");
}

function parseKeyValue(lines: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) result[match[1]!] = safeText(match[2]!);
  }
  return result;
}

function parsePid(lines: readonly string[]): Record<string, string> {
  const text = lines.join("\n").trim();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const safeKeys = ["version", "pid", "startedAt"] as const;
    const result: Record<string, string> = {};
    for (const key of safeKeys) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === "string" || typeof field === "number")
        result[key] = safeText(String(field));
    }
    return result;
  } catch {
    return { parseError: "invalid pid metadata" };
  }
}

export function parseDiagnosticOutput(
  output: string,
): Omit<
  RemoteSshDiagnosticSnapshot,
  "capturedAt" | "exitCode" | "timedOut" | "aborted" | "stderr"
> {
  const sections: Record<string, string[]> = {
    service: [],
    pid: [],
    sockets: [],
    processes: [],
  };
  let section: keyof typeof sections | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line === "__TRAYCER_SSH_DIAGNOSTIC_V1__") continue;
    if (
      line === "[service]" ||
      line === "[pid]" ||
      line === "[sockets]" ||
      line === "[processes]"
    ) {
      section = line.slice(1, -1) as keyof typeof sections;
      continue;
    }
    if (section) sections[section]!.push(safeText(line));
  }
  return {
    service: parseKeyValue(sections.service!),
    pid: parsePid(sections.pid!),
    sockets: sections.sockets!.filter(Boolean).slice(0, 256),
    processes: sections.processes!.filter(Boolean).slice(0, 48),
  };
}

export interface CollectDiagnosticOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Collects one bounded snapshot; it never mutates the remote machine. */
export async function collectRemoteSshDiagnostic(
  profile: Pick<SshHostProfile, "target">,
  options: CollectDiagnosticOptions,
): Promise<RemoteSshDiagnosticSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  const capturedAt = new Date().toISOString();
  if (signal?.aborted)
    return {
      capturedAt,
      exitCode: null,
      timedOut: false,
      aborted: true,
      ...parseDiagnosticOutput(""),
      stderr: "",
    };

  return await new Promise((resolve) => {
    const child = spawn(sshExecutable(), diagnosticArgs(profile.target), {
      windowsHide: true,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({
        capturedAt,
        exitCode,
        timedOut,
        aborted,
        ...parseDiagnosticOutput(stdout),
        stderr: safeText(stderr),
      });
    };
    const abort = (): void => {
      aborted = true;
      child.kill();
      finish(null);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk, MAX_STDOUT_BYTES);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, MAX_STDERR_BYTES);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) =>
      finish(typeof code === "number" ? code : null),
    );
  });
}
