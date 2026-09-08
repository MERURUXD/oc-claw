"""Exercise generated hooks without installing them or contacting OC-Claw.

Run: python scripts/test_codex_hook_transport.py
Windows tests use an ephemeral loopback port and the real PowerShell script.
The Unix Python payload is exercised with a socket mock on every platform.
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
import time
import unittest
from unittest.mock import patch, MagicMock


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "frontend/src-tauri/src/lib.rs").read_text(encoding="utf-8")
INSTALLER = SOURCE.split("async fn install_codex_hooks(", 1)[1].split(
    "pub fn parse_codex_permission_request", 1
)[0]
SCRIPTS = re.findall(r'let hook_script = r#"(.*?)"#;', INSTALLER, re.S)
POWERSHELL = shutil.which("pwsh")


class HookTransportTests(unittest.TestCase):
    def test_unix_ignores_server_decisions_and_preserves_events(self):
        payload = SCRIPTS[1].split('/usr/bin/python3 -c "', 1)[1].rsplit('"', 1)[0]
        for event in ("PermissionRequest", "PostToolUse", "Stop", "SessionEnd"):
            with self.subTest(event=event):
                sock = MagicMock()
                sock.recv.side_effect = AssertionError("Must not read an approval")
                output = io.StringIO()
                data = {"hook_event_name": event, "session_id": "test", "pid": 123}
                with patch("socket.AF_UNIX", 1, create=True), patch("socket.socket", return_value=sock), patch("sys.stdin", io.StringIO(json.dumps(data))), contextlib.redirect_stdout(output):
                    exec(compile(payload, "generated-codex-hook", "exec"), {})
                self.assertEqual(output.getvalue(), "{}")
                sent = json.loads(sock.sendall.call_args.args[0])
                self.assertEqual(sent["hook_event_name"], event)
                self.assertEqual(sent["source"], "codex")
                sock.settimeout.assert_called_once_with(0.5)
                sock.recv.assert_not_called()

    @unittest.skipUnless(POWERSHELL, "PowerShell is not available")
    def test_windows_unresponsive_server_and_status_events(self):
        for event in ("PermissionRequest", "PostToolUse", "Stop", "SessionEnd"):
            with self.subTest(event=event):
                self.run_windows(event, listening=True)

    @unittest.skipUnless(POWERSHELL, "PowerShell is not available")
    def test_windows_server_unavailable(self):
        self.run_windows("PermissionRequest", listening=False)

    def run_windows(self, event, listening):
        received = []
        release = threading.Event()
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.settimeout(5)

        def serve():
            try:
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(5)
                    chunks = []
                    while chunk := conn.recv(8192):
                        chunks.append(chunk)
                    received.append(json.loads(b"".join(chunks)))
                    # Deliberately keep the response open until the hook exits.
                    release.wait(5)
            except Exception as exc:
                received.append(exc)

        worker = None
        if listening:
            listener.listen()
            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
        else:
            listener.close()
        try:
            with tempfile.TemporaryDirectory(dir=ROOT / "frontend/src-tauri/target") as temp:
                script = Path(temp) / "hook.ps1"
                script.write_text(SCRIPTS[0].replace("19283", str(port)), encoding="utf-8")
                data = {"hook_event_name": event, "session_id": "test", "pid": 123}
                start = time.monotonic()
                result = subprocess.run(
                    [POWERSHELL, "-NoProfile", "-File", str(script), event],
                    input=json.dumps(data), text=True, capture_output=True, timeout=4,
                )
                elapsed = time.monotonic() - start
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "{}", result.stderr)
                print(f"{event}, listening={listening}: {elapsed:.3f}s")
        finally:
            release.set()
            if worker:
                worker.join(6)
            listener.close()
        if listening:
            self.assertEqual(len(received), 1)
            self.assertIsInstance(received[0], dict)
            self.assertEqual(received[0]["hook_event_name"], event)
            self.assertEqual(received[0]["source"], "codex")


if __name__ == "__main__":
    unittest.main()
