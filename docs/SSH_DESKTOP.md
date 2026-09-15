# Traycer SSH

Independent Windows desktop fork of Traycer. It keeps the Traycer account,
subscription, interface and existing Linux Host, and adds an OpenSSH route
between Windows and that Host. This is an experimental fork, not an official
Traycer release.

## Install and connect

1. Install the `Traycer-SSH-…-win-x64.exe` build. The application is named
   **Traycer SSH** and can run alongside the official Traycer app.
2. Sign in to the same Traycer account through the browser. The fork uses a
   separate login; return to its window after approving the device code.
3. In Windows Terminal, verify that the system OpenSSH client can log in to the
   Linux account that runs your existing Host. Use key authentication or
   `ssh-agent`; the application does not show password/passphrase prompts.
4. Open **Settings → Host**, select the Linux device, and open **Overview**.
   In **Connection**, enter its SSH config alias or `user@hostname`, then choose
   **Use SSH**. Confirm the server in the native dialog.
5. Wait for **Connected via SSH**. Open or continue a task on that device.

Example Windows `%USERPROFILE%\.ssh\config`:

```sshconfig
Host linux-dev
    HostName YOUR_LINUX_ADDRESS
    User YOUR_LINUX_USER
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Verify the server key against the Linux machine when connecting for the first
time. Then test from Windows Terminal:

```powershell
& "$env:WINDIR\System32\OpenSSH\ssh.exe" linux-dev
```

Use `linux-dev` as the target in the application. Non-default ports, IPv6
addresses and jump hosts belong in the SSH config (`Port`, `HostName`,
`ProxyJump`). The application intentionally accepts one destination rather than
an arbitrary command line.

The Linux Host must already be running under that SSH user, with metadata at
`~/.traycer/host/pid.json`. No new Host, service, agent, or remote package is
installed. The selected account device must match the `hostId` in that file.

## Reconnection and limits

- SSH uses loopback-only local forwarding, keepalives and automatic reconnect
  with a delay capped at 30 seconds. Each attempt rereads the Host endpoint.
- The existing Traycer RPC and stream implementations handle subscriptions,
  task snapshots and terminal acknowledgements. Task ownership stays attached
  to the original Linux `hostId` when the local tunnel port changes.
- **Reconnect SSH** retries immediately. **Use Traycer connection** removes the
  SSH profile and restores the original relay route for that device.
- When SSH is selected, failure does not silently switch back to the relay.
- Account login, initial account device discovery, token renewal, and other
  cloud features still need Traycer services. SSH bypasses the relay transport;
  it does not replace those services or a subscription.
- SSH cannot fix a stopped or unresponsive Host. A Host restart can also end
  processes that the Host itself owned. Losing the SSH tunnel does not request
  a Host restart.
- Browser sessions use the same SSH route, with their cookie-bearing stream
  still owned by Electron main. Trust the SSH server you approve.
- This first build requires the system Windows OpenSSH Client. Older OpenSSH
  versions that reject required options need an update. Password prompts are
  not supported.

## Isolation

| Item                          | Fork                                        |
| ----------------------------- | ------------------------------------------- |
| Application                   | Traycer SSH                                 |
| Windows app ID                | `io.github.krat12.traycer-ssh`              |
| Data and single-instance lock | `%APPDATA%\Traycer SSH`                     |
| Login credentials             | `%APPDATA%\Traycer SSH\auth\credentials`    |
| SSH profiles                  | `%APPDATA%\Traycer SSH\ssh-hosts.json`      |
| URL scheme                    | `traycer-ssh`                               |
| Updater                       | Disabled; install a new fork build manually |
| Local Host lifecycle          | Disabled                                    |
| Bundled CLI / Host            | None                                        |
| Global shortcut               | Disabled by default                         |

Uninstalling the fork does not stop or uninstall the official Host and keeps
its own user data for a later reinstall. The existing `%USERPROFILE%\.traycer`
and Linux `~/.traycer` installation are not migrated or modified by setup.

## Build

Use Node 24 and Bun 1.3.12. Install dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

Build on Windows from `clients/desktop`:

```powershell
$env:TRAYCER_SSH_VERSION = "0.1.0-ssh.1"
$env:VITE_DESKTOP_LOCAL_STORAGE_KEY = "YOUR_STABLE_BUILD_KEY"
bun run package:ssh
```

Keep the local-storage build key stable across upgrades; changing it makes
previous encrypted renderer preferences unreadable. It is embedded in the
application and does not replace OS account/file permissions. The GitHub
workflow obtains its stable key from the fork repository's
`TRAYCER_SSH_STORAGE_KEY` secret.

The script stamps the fork identity, builds the app, and restores source config
in `finally`. It does not invoke the upstream deployment stamper or
`make dev-desktop`, which provisions the official Host. Output is in
`clients/desktop/release/`. The installer is unsigned.

Source and Windows artifacts:
[Traycer SSH repository](https://github.com/Krat12/traycer-ssh) ·
[Windows build workflow](https://github.com/Krat12/traycer-ssh/actions/workflows/ssh-windows.yml).
