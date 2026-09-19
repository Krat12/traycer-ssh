# SSH Host recovery

Owner request: after repeated failures, restart an unresponsive Linux Traycer
Host automatically, accepting interruption of running agents. Keep diagnostics
before recovery and prevent restart loops. The earlier dead-process-only policy
is superseded. Two independent reviews are required.

## Two independent mechanisms

- Linux watchdog: `scripts/ssh-host-watchdog/watchdog.py`, a systemd user timer.
  It checks the existing service every 30 seconds after the preceding check ends.
  Three consecutive HTTP failures (8-second socket timeout) for the same Host
  process authorize restarting **only** `ai.traycer.host.service`. Allow 120
  seconds for a new process to start. Normally this detects a persistent hang
  in about two minutes; systemd can then spend up to 90 seconds stopping it.
- Windows SSH manager: checks the forwarded HTTP listener every 30 seconds.
  After three failures, closes its own tunnel and re-reads Host metadata over SSH
  before reconnecting. A living SSH process does not prove the Host is responsive.
  Rediscovery is necessary because a Host restart changes its listening port.

The watchdog runs even when Windows is disconnected. SSH/network/cloud failures
alone do not restart a locally responsive Host. An intentionally stopped service
is not started. Ordinary process crashes remain systemd's `Restart=on-failure`
responsibility. No Host binary, account or subscription is changed.

A valid HTTP response (including the `/rpc` endpoint's normal HTTP 404) proves
that the Host event loop serviced the request. No bearer or RPC is needed. This
is aimed at the observed event-loop stall, **not** proof that every agent/RPC is
healthy. A partial RPC-only failure can escape this check. This is recovery from
a hang, not a fix for the closed-source Host's underlying CPU/SQLite/JSON issue.

## Rate limits and evidence

Restart reservations are persisted **before** sending the systemd restart:
minimum 15 minutes between attempts, maximum three attempts in a rolling hour,
including failed attempts. Failed metadata/identity checks never authorize a
restart; a corrupt state file fails closed. Changing process generation or a
long observation gap resets the failure streak. A lock prevents overlapping
manual and timer runs. A systemd restart can terminate running agents; the owner
explicitly accepted this tradeoff.

On Linux: `~/.local/state/traycer-host-watchdog/`

- `watchdog.log`, rotating at 1 MiB, three backups: check verdicts, failure counts,
  rate-limit decisions and restart outcomes. Also mirrored to the user journal.
- `state.json`: failure streak, process identity and restart timestamps.
- `snapshot-*.json`: last 20 pre-restart snapshots, service state, process
  status/stat/wchan and network-namespace TCP state totals. Those totals are
  **not** a count of agents or exclusively of Host sockets.

Directory mode 0700, new files 0600. No credentials, prompts, environment or raw
Host journal is collected. If snapshot/state persistence fails, no restart runs.
The Windows `traycer-desktop.log` now retains main-process and production-renderer
transport diagnostics, including `host-health` and tunnel rediscovery.

## Install / operate

Run as the **same Linux user who runs the Host**, with Python 3 and user systemd:

```sh
./scripts/ssh-host-watchdog/install.sh
systemctl --user status traycer-host-watchdog.timer
journalctl --user -u traycer-host-watchdog.service --since '10 minutes ago'
```

Installation pins the Host ID from local metadata and makes a read-only check.
It installs the script in `~/.local/lib/traycer-host-watchdog/` and enables the
user timer. It does not restart the healthy Host. To pause automatic recovery:

```sh
systemctl --user stop traycer-host-watchdog.timer traycer-host-watchdog.service
systemctl --user disable traycer-host-watchdog.timer
```

A restart already submitted to systemd may still complete when the watchdog is
stopped. Do not delete `state.json` just to circumvent the cooldown.

Install the updated Traycer SSH Windows build for automatic port rediscovery.
An old client may need **Reconnect SSH** manually after a Host restart. The
Linux watchdog works independently of that client update.

## Verification

```sh
python3 -m unittest discover -s scripts/ssh-host-watchdog -v
# from clients/desktop (Bun on PATH):
bunx vitest run src/electron-main/ssh/__tests__ src/electron-main/app/__tests__/logger-sanitizing-hook.test.ts src/electron-main/windows/__tests__/window-factory.test.ts --maxWorkers=2
```

The Python probe test uses an actual loopback HTTP server and a listening TCP
socket that never answers HTTP. Restart tests substitute systemctl; they never
stop real agents. Live verification checks only a healthy Host and the timer.
