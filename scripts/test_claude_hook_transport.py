"""Test generated Claude scripts on fixture sockets; never install hooks.

Run: python scripts/test_claude_hook_transport.py
"""
import contextlib
import io
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'frontend/src-tauri/src/lib.rs').read_text(encoding='utf-8')
INSTALLER = SOURCE.split('async fn install_claude_hooks()', 1)[1].split('fn register_claude_hooks', 1)[0]
SCRIPTS = re.findall(r'let (?:hook_script|ps1_script) = r#"(.*?)"#;', INSTALLER, re.S)
STATUSLINE = (ROOT / 'frontend/src-tauri/src/claude_statusline.rs').read_text(encoding='utf-8')
WINDOWS_STATUSLINE = re.search(r'WINDOWS_SCRIPT: &str = r#"(.*?)"#;', STATUSLINE, re.S)[1]
UNIX_STATUSLINE = re.search(r'UNIX_SCRIPT: &str = r#"(.*?)"#;', STATUSLINE, re.S)[1]
POWERSHELL = shutil.which('pwsh') or shutil.which('powershell')


class ClaudeTransportTests(unittest.TestCase):
    def test_unix_permission_forwards_response_and_preserves_metadata(self):
        payload = SCRIPTS[0].split('/usr/bin/python3 -c "', 1)[1].rsplit('"', 1)[0]
        reply = b'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
        for event in ('PermissionRequest', 'PostToolUse', 'SubagentStop', 'Stop'):
            with self.subTest(event=event):
                sock = MagicMock()
                sock.recv.side_effect = [reply, b'']
                data = {'hook_event_name': event, 'session_id': 'fixture',
                        'transcript_path': '/fixture/s.jsonl', 'tool_use_id': 'call',
                        'tool_name': 'Bash', 'tool_input': {'command': 'echo 中文'}}
                output = io.StringIO()
                with patch('socket.AF_UNIX', 1, create=True), patch('socket.socket', return_value=sock), \
                     patch('sys.stdin', io.StringIO(json.dumps(data))), contextlib.redirect_stdout(output):
                    exec(compile(payload, 'claude-hook', 'exec'), {})
                sent = json.loads(sock.sendall.call_args.args[0])
                self.assertEqual(sent['tool_use_id'], 'call')
                self.assertEqual(sent['transcript_path'], '/fixture/s.jsonl')
                self.assertEqual(output.getvalue(), reply.decode() if event == 'PermissionRequest' else '')
                if event != 'PermissionRequest':
                    sock.recv.assert_not_called()

    def test_unix_statusline_preserves_original_stdin_stdout_and_exit_code(self):
        sock = MagicMock()
        raw = json.dumps({'session_id': 'fixture', 'session_name': '中文标题',
                          'rate_limits': {'five_hour': {'used_percentage': 17, 'resets_at': 9999999999}}}).encode()
        stdout = io.StringIO()
        fake_run = MagicMock(return_value=subprocess.CompletedProcess([], 7))
        with patch('socket.AF_UNIX', 1, create=True), patch('socket.socket', return_value=sock), \
             patch('sys.stdin', MagicMock(buffer=io.BytesIO(raw))), patch('os.path.isfile', return_value=True), \
             patch('subprocess.run', fake_run), contextlib.redirect_stdout(stdout):
            with self.assertRaises(SystemExit) as caught:
                exec(compile(UNIX_STATUSLINE, 'claude-statusline', 'exec'), {'__file__': '/fixture/statusline.py'})
        self.assertEqual(caught.exception.code, 7)
        self.assertEqual(fake_run.call_args.kwargs['input'], raw)
        self.assertEqual(stdout.getvalue(), '')
        sent = json.loads(sock.__enter__.return_value.sendall.call_args.args[0])
        self.assertEqual(sent['event'], 'StatusLine')
        self.assertEqual(sent['session_name'], '中文标题')
        self.assertEqual(sent['rate_limits']['five_hour']['used_percentage'], 17)

    @unittest.skipUnless(POWERSHELL, 'PowerShell unavailable')
    def test_windows_permission_response_and_large_unicode_payload(self):
        data = {'session_id': 'fixture', 'hook_event_name': 'PermissionRequest', 'tool_use_id': 'call',
                'tool_name': 'Bash', 'tool_input': {'command': 'echo 中文' * 1000}}
        reply = {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': 'deny'}}}
        output, received = self.run_windows(SCRIPTS[1], data, json.dumps(reply).encode())
        self.assertEqual(json.loads(output.stdout), reply)
        self.assertEqual(received['tool_input'], data['tool_input'])
        self.assertEqual(received['tool_use_id'], 'call')

    @unittest.skipUnless(POWERSHELL, 'PowerShell unavailable')
    def test_windows_statusline_forwards_native_data_and_runs_original_command(self):
        data = {'session_id': 'fixture', 'session_name': '中文标题', 'rate_limits': {
            'five_hour': {'used_percentage': 0, 'resets_at': 9999999999}}}
        original = "cat\nprintf '\\n原有状态行\\n'\nexit 7\n"
        output, received = self.run_windows(WINDOWS_STATUSLINE, data, b'', original, expected_exit=7)
        self.assertEqual(received['event'], 'StatusLine')
        self.assertEqual(received['rate_limits'], data['rate_limits'])
        self.assertEqual(json.loads(output.stdout.splitlines()[0]), data)
        self.assertEqual(output.stdout.splitlines()[1], '原有状态行')

    def run_windows(self, script_text, data, reply, original=None, expected_exit=0):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.settimeout(20)
        received = []

        def serve():
            try:
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(20)
                    chunks = []
                    while chunk := conn.recv(8192):
                        chunks.append(chunk)
                    received.append(json.loads(b''.join(chunks)))
                    conn.sendall(reply)
            except Exception as error:
                received.append(error)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        target = ROOT / 'frontend/src-tauri/target'
        target.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(dir=target) as directory:
                script = Path(directory) / 'hook.ps1'
                script.write_text(script_text.replace('19283', str(listener.getsockname()[1])), encoding='utf-8')
                if original is not None:
                    (Path(directory) / 'ooclaw-statusline-original.sh').write_text(original, encoding='utf-8')
                output = subprocess.run([POWERSHELL, '-NoProfile', '-File', str(script)],
                                        input=json.dumps(data, ensure_ascii=False).encode('utf-8'),
                                        capture_output=True, timeout=25)
                output.stdout = output.stdout.decode('utf-8-sig')
                output.stderr = output.stderr.decode('utf-8-sig')
                self.assertEqual(output.returncode, expected_exit, output.stderr)
            worker.join(21)
            self.assertEqual(len(received), 1)
            self.assertIsInstance(received[0], dict)
            return output, received[0]
        finally:
            listener.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
