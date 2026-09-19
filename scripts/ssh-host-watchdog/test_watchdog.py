import http.server
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import watchdog as w


def sample(verdict):
    return {'verdict': verdict, 'generation': '123:456', 'pid': os.getpid(),
            'service': {'MainPID': '100', 'ActiveState': 'active', 'SubState': 'running'}}


class PolicyTests(unittest.TestCase):
    def test_three_failures_reserve_once_and_cooldown_survives_reload(self):
        state = {}
        self.assertEqual([w.decide(state, sample('unhealthy'), t)
                          for t in (1000, 1030, 1060)], ['retry', 'retry', 'restart'])
        state = json.loads(json.dumps(state))
        self.assertEqual([w.decide(state, sample('unhealthy'), t)
                          for t in (1090, 1120, 1150)], ['retry', 'retry', 'cooldown'])
        self.assertEqual(state['restarts'], [1060])

    def test_healthy_skip_new_generation_and_long_gaps_break_failure_streak(self):
        for middle in (sample('healthy'), sample('skip')):
            state = {}
            w.decide(state, sample('unhealthy'), 1000)
            w.decide(state, sample('unhealthy'), 1030)
            self.assertEqual(w.decide(state, middle, 1060), 'none')
            self.assertEqual(w.decide(state, sample('unhealthy'), 1090), 'retry')
            self.assertEqual(state['failures'], 1)
        state = {}
        w.decide(state, sample('unhealthy'), 1000)
        w.decide(state, sample('unhealthy'), 1030)
        changed = dict(sample('unhealthy'), generation='new')
        self.assertEqual(w.decide(state, changed, 1060), 'retry')
        self.assertEqual(state['failures'], 1)
        self.assertEqual(w.decide(state, changed, 2000), 'retry')
        self.assertEqual(state['failures'], 1)

    def test_three_per_hour_even_after_cooldown(self):
        state = {'restarts': [1000, 1900, 2800], 'failures': 2,
                 'generation': '123:456', 'checkedAt': 3680}
        self.assertEqual(w.decide(state, sample('unhealthy'), 3700), 'cooldown')

    def test_snapshot_and_persisted_budget_precede_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(w, 'observe', return_value=sample('unhealthy')), \
                 patch.object(w, 'service', return_value=sample('unhealthy')['service']), \
                 patch.object(w, 'host_process', return_value=({}, '123:456', 200)), \
                 patch.object(w.subprocess, 'run') as run:
                def assert_evidence(*args, **kwargs):
                    self.assertEqual(len(json.loads((directory / 'state.json').read_text())['restarts']), 1)
                    self.assertEqual(len(list(directory.glob('snapshot-*.json'))), 1)
                    return type('Result', (), {'returncode': 0})()
                run.side_effect = assert_evidence
                for _ in range(3):
                    w.tick(directory, 'host', directory)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], ['systemctl', '--user', 'restart', w.UNIT])
                for _ in range(6):
                    w.tick(directory, 'host', directory)
                run.assert_called_once()

    def test_corrupt_state_never_discards_restart_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'state.json').write_text('broken')
            with patch.object(w.subprocess, 'run') as run:
                with self.assertRaises(json.JSONDecodeError):
                    w.tick(directory, 'host', directory)
                run.assert_not_called()

    def test_metadata_failure_breaks_streak_but_preserves_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state = {'restarts': [1000], 'failures': 2, 'generation': '123:456'}
            (directory / 'state.json').write_text(json.dumps(state))
            with patch.object(w, 'observe', side_effect=ValueError('invalid-metadata')):
                with self.assertRaises(ValueError):
                    w.tick(directory, 'host', directory)
            saved = json.loads((directory / 'state.json').read_text())
            self.assertEqual(saved['failures'], 0)
            self.assertEqual(saved['restarts'], [1000])

    def test_new_child_under_same_supervisor_is_not_restarted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(w, 'observe', return_value=sample('unhealthy')), \
                 patch.object(w, 'service', return_value=sample('unhealthy')['service']), \
                 patch.object(w, 'host_process', return_value=({}, 'new-child', 200)), \
                 patch.object(w.subprocess, 'run') as run:
                for _ in range(3):
                    w.tick(directory, 'host', directory)
                run.assert_not_called()

    def test_service_change_cancels_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(w, 'observe', return_value=sample('unhealthy')), \
                 patch.object(w, 'service', return_value={'ActiveState': 'inactive'}), \
                 patch.object(w.subprocess, 'run') as run:
                for _ in range(3):
                    w.tick(directory, 'host', directory)
                run.assert_not_called()


class ProbeTests(unittest.TestCase):
    def test_actual_http_response_and_hung_listener(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(404)
                self.end_headers()
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertEqual(self.observe_at(server.server_port)['verdict'], 'healthy')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        # Listening socket accepts TCP but never sends HTTP. Mirrors the incident.
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            started = time.monotonic()
            self.assertEqual(self.observe_at(listener.getsockname()[1])['verdict'], 'unhealthy')
            self.assertLess(time.monotonic() - started, 10)

    def observe_at(self, port):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            meta = home / '.traycer/host/pid.json'
            meta.parent.mkdir(parents=True)
            meta.write_text(json.dumps({'pid': os.getpid(), 'hostId': 'test',
                                       'websocketUrl': f'ws://127.0.0.1:{port}/rpc'}))
            group = Path(f'/proc/{os.getpid()}/cgroup').read_text().splitlines()[0].split(':', 2)[-1]
            info = {'ActiveState': 'active', 'SubState': 'running', 'ControlGroup': group}
            with patch.object(w, 'service', return_value=info), patch.object(w, 'GRACE', 0):
                result = w.observe(home, 'test')
                with self.assertRaises(ValueError):
                    w.observe(home, 'different-host')
                return result

    def test_intentionally_stopped_service_is_not_started(self):
        with patch.object(w, 'service', return_value={'ActiveState': 'inactive'}):
            self.assertEqual(w.observe(Path('/does-not-exist'), 'test')['verdict'], 'skip')


if __name__ == '__main__':
    unittest.main()
