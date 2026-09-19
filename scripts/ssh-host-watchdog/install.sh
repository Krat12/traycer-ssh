#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Read metadata locally; no account secrets or Host binary changes.
host_id="$(python3 - <<'PY'
import json,re
from pathlib import Path
value=json.loads((Path.home()/'.traycer/host/pid.json').read_text())['hostId']
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}', value):
    raise SystemExit('Invalid Host identity')
print(value)
PY
)"
python3 "$script_dir/watchdog.py" --host-id "$host_id" --check
install -d -m 700 "$HOME/.local/lib/traycer-host-watchdog" "$HOME/.config/systemd/user"
install -m 700 "$script_dir/watchdog.py" "$HOME/.local/lib/traycer-host-watchdog/watchdog.py"
cat > "$HOME/.config/systemd/user/traycer-host-watchdog.service" <<EOF
[Unit]
Description=Traycer Host liveness and bounded recovery

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 %h/.local/lib/traycer-host-watchdog/watchdog.py --host-id $host_id
TimeoutStartSec=150
UMask=0077
Nice=10
EOF
cat > "$HOME/.config/systemd/user/traycer-host-watchdog.timer" <<'EOF'
[Unit]
Description=Check Traycer Host every 30 seconds

[Timer]
OnStartupSec=30
OnUnitInactiveSec=30
AccuracySec=1
Unit=traycer-host-watchdog.service

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now traycer-host-watchdog.timer
