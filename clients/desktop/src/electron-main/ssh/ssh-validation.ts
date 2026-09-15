import type { SshHostProfile } from "@traycer-clients/shared/platform/ssh-host";

export class SshConnectionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SshConnectionError";
  }
}

export function parseSshProfile(value: unknown): SshHostProfile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("hostId" in value) ||
    typeof value.hostId !== "string" ||
    !("label" in value) ||
    typeof value.label !== "string" ||
    !("target" in value) ||
    typeof value.target !== "string"
  )
    throw new Error("Invalid SSH profile.");
  const { hostId, label, target } = value;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(hostId)) {
    throw new Error("Invalid Host identity.");
  }
  if (!label.trim() || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new Error("Enter a device name of up to 100 characters.");
  }
  // A single OpenSSH destination, never options, a URL, or shell syntax.
  // Custom ports, identity files and jump hosts belong in ~/.ssh/config.
  if (
    !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(
      target,
    ) ||
    target.length > 253
  ) {
    throw new Error(
      "Use an SSH config alias or user@hostname. Set ports and keys in your SSH config.",
    );
  }
  return { hostId, label: label.trim(), target };
}

export interface RemoteSshHost {
  readonly hostname: "127.0.0.1" | "[::1]";
  readonly port: number;
  readonly version: string | null;
}

export function parseRemoteSshHost(
  raw: string,
  expectedHostId: string,
): RemoteSshHost {
  if (Buffer.byteLength(raw) > 16_384)
    throw new SshConnectionError("Remote Host metadata is too large.", false);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SshConnectionError(
      "Cannot read Linux Host metadata. Check that Traycer Host is running.",
      false,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("hostId" in value) ||
    value.hostId !== expectedHostId
  ) {
    throw new SshConnectionError(
      "The SSH server runs a different Host. Select its matching device in your account.",
      false,
    );
  }
  if (!("websocketUrl" in value) || typeof value.websocketUrl !== "string") {
    throw new SshConnectionError(
      "Remote Host has no valid loopback endpoint.",
      false,
    );
  }
  let url: URL;
  try {
    url = new URL(value.websocketUrl);
  } catch {
    throw new SshConnectionError(
      "Remote Host has no valid loopback endpoint.",
      false,
    );
  }
  if (
    url.protocol !== "ws:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.pathname !== "/rpc" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    Number(url.port) < 1
  ) {
    throw new SshConnectionError(
      "Remote Host endpoint must be ws://127.0.0.1:PORT/rpc or IPv6 loopback.",
      false,
    );
  }
  const version =
    "version" in value &&
    typeof value.version === "string" &&
    /^[0-9A-Za-z.+-]{1,80}$/.test(value.version)
      ? value.version
      : null;
  return { hostname: url.hostname, port: Number(url.port), version };
}

/** Only closed, useful diagnoses cross IPC; raw OpenSSH output is discarded. */
export function classifySshFailure(stderr: string): SshConnectionError {
  if (
    /Bad configuration option|Bad SSH2|Unsupported option|unsupported option/i.test(
      stderr,
    )
  ) {
    return new SshConnectionError(
      "System OpenSSH does not support the required options. Update the OpenSSH Client and retry.",
      false,
    );
  }
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(
      stderr,
    )
  ) {
    return new SshConnectionError(
      "SSH host key is unknown or changed. Verify the server and connect once using Windows OpenSSH before retrying.",
      false,
    );
  }
  if (
    /Permission denied|Too many authentication failures|no supported authentication methods/i.test(
      stderr,
    )
  ) {
    return new SshConnectionError(
      "SSH key authentication failed. Check your SSH config and ssh-agent; password prompts are not supported.",
      false,
    );
  }
  if (
    /administratively prohibited|port forwarding failed|cannot listen to port/i.test(
      stderr,
    )
  ) {
    return new SshConnectionError(
      "SSH port forwarding was refused. Check the server forwarding policy and reconnect.",
      false,
    );
  }
  return new SshConnectionError(
    "SSH connection interrupted. Retrying automatically.",
    true,
  );
}
