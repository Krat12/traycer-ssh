#!/usr/bin/env python3
"""Independent, credential-free liveness watchdog for an existing Linux Host."""
import argparse
import datetime
import fcntl
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

UNIT = 'ai.traycer.host.service'
THRESHOLD = 3
GRACE = 120
COOLDOWN = 900
HOUR = 3600


def service():
    result = subprocess.run(
        ['systemctl', '--user', 'show', UNIT, '-p', 'ActiveState', '-p', 'SubState',
         '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'NRestarts', '-p', 'Result'],
        capture_output=True, text=True, timeout=5, check=True)
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def host_process(home, host_id, info):
    raw = (home / '.traycer/host/pid.json').read_bytes()
    if len(raw) > 16384:
        raise ValueError('metadata-too-large')
    meta = json.loads(raw)
    if meta.get('hostId') != host_id:
        raise ValueError('host-identity-mismatch')
    pid = meta['pid']
    if type(pid) is not int or pid <= 1:
        raise ValueError('invalid-pid')
    group = info.get('ControlGroup')
    cgroups = Path(f'/proc/{pid}/cgroup').read_text().splitlines()
    if not group or not any(line.split(':', 2)[-1] == group for line in cgroups):
        raise ValueError('pid-outside-service')
    # Process start ticks survive stale metadata timestamps and PID reuse.
    stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    uptime = float(Path('/proc/uptime').read_text().split()[0])
    age = uptime - int(stat[19]) / os.sysconf('SC_CLK_TCK')
    return meta, f'{pid}:{stat[19]}', int(age)


def observe(home, host_id):
    """Any HTTP response proves the Host event loop answered; TCP accept does not."""
    info = service()
    result = {'service': info, 'verdict': 'skip', 'reason': 'service-not-running'}
    # Respect an intentional stop, upgrades and systemd's own crash recovery.
    if (info.get('ActiveState'), info.get('SubState')) != ('active', 'running'):
        return result
    meta, generation, age = host_process(home, host_id, info)
    result.update(pid=meta['pid'], generation=generation, ageSeconds=age)
    if age < GRACE:
        result['reason'] = 'startup-grace'
        return result
    url = urlsplit(meta['websocketUrl'])
    if (url.scheme != 'ws' or url.hostname not in ('127.0.0.1', '::1')
            or not url.port or url.path != '/rpc' or url.query or url.fragment
            or url.username or url.password):
        raise ValueError('invalid-loopback-endpoint')
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=8)
    try:
        connection.request('GET', '/rpc', headers={'Connection': 'close'})
        response = connection.getresponse()
        result.update(verdict='healthy', reason='http-response', status=response.status)
    except (OSError, http.client.HTTPException):
        result.update(verdict='unhealthy', reason='no-http-response')
    finally:
        connection.close()
    return result


def decide(state, sample, now):
    """Mutate persisted policy state. Reserve the restart BEFORE executing it."""
    history = [stamp for stamp in state.get('restarts', []) if now - stamp < HOUR]
    state['restarts'] = history
    previous_generation = state.get('generation')
    previous_check = state.get('checkedAt', 0)
    state['checkedAt'] = now
    state['generation'] = sample.get('generation')
    if (sample['verdict'] != 'unhealthy'
            or previous_generation != sample.get('generation')
            or now - previous_check > 180 or now < previous_check):
        state['failures'] = 0
    if sample['verdict'] != 'unhealthy':
        return 'none'
    state['failures'] = min(state.get('failures', 0) + 1, THRESHOLD)
    if state['failures'] < THRESHOLD:
        return 'retry'
    if history and (now - history[-1] < COOLDOWN or len(history) >= 3):
        return 'cooldown'
    history.append(now)
    state['failures'] = 0
    return 'restart'


def save_state(path, state):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as output:
        json.dump(state, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def snapshot(directory, sample):
    # Aggregate socket states only: no prompts, environment, bearer or raw logs.
    socket_states = {}
    pid = sample.get('pid')
    for table in ('tcp', 'tcp6'):
        try:
            for line in Path(f'/proc/{pid}/net/{table}').read_text().splitlines()[1:]:
                state = line.split()[3]
                socket_states[state] = socket_states.get(state, 0) + 1
        except OSError:
            pass
    detail = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sample': sample, 'networkNamespaceTcpStates': socket_states}
    if pid:
        for name in ('status', 'stat', 'wchan'):
            try:
                detail[name] = Path(f'/proc/{pid}/{name}').read_text()[:16384]
            except OSError:
                pass
    path = directory / f'snapshot-{time.time_ns()}.json'
    path.write_text(json.dumps(detail, indent=2))
    for old in sorted(directory.glob('snapshot-*.json'))[:-20]:
        old.unlink()
    return path


def tick(home, host_id, directory):
    path = directory / 'state.json'
    # Corrupt policy state must not silently erase the persisted rate limit.
    state = json.loads(path.read_text()) if path.exists() else {}
    try:
        sample = observe(home, host_id)
    except Exception:
        state['failures'] = 0
        state['generation'] = None
        save_state(path, state)
        raise
    action = decide(state, sample, time.time())
    save_state(path, state)
    logging.info(json.dumps({'sample': sample, 'action': action,
                             'failures': state['failures']}))
    if action != 'restart':
        return
    # If diagnostic persistence fails, do not destroy evidence with a restart.
    saved = snapshot(directory, sample)
    # Recheck service identity/generation after diagnostics, without another probe.
    current = service()
    if (current.get('ActiveState') != 'active'
            or current.get('SubState') != 'running'
            or current.get('MainPID') != sample['service'].get('MainPID')):
        logging.warning('Restart cancelled: service changed during diagnostics')
        return
    _, generation, age = host_process(home, host_id, current)
    if generation != sample['generation'] or age < GRACE:
        logging.warning('Restart cancelled: Host process changed during diagnostics')
        return
    logging.warning('Restarting %s; snapshot=%s', UNIT, saved)
    result = subprocess.run(['systemctl', '--user', 'restart', UNIT],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=120, check=False)
    logging.warning('Restart finished; exit=%s', result.returncode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host-id', required=True)
    parser.add_argument('--check', action='store_true', help='Read-only health check')
    args = parser.parse_args()
    os.umask(0o077)
    home = Path.home()
    if args.check:
        print(json.dumps(observe(home, args.host_id)))
        return
    directory = home / '.local/state/traycer-host-watchdog'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    handler = RotatingFileHandler(directory / 'watchdog.log', maxBytes=1048576,
                                  backupCount=3)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
                        handlers=[handler, logging.StreamHandler()])
    with (directory / 'watchdog.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            tick(home, args.host_id, directory)
        except Exception as error:
            # Exception strings may include metadata; keep a closed diagnostic.
            logging.error('Watchdog check failed: %s; no further action', type(error).__name__)
            raise SystemExit(1) from None


if __name__ == '__main__':
    main()
