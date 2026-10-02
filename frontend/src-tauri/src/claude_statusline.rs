//! Passively forward Claude's measured quota/title while preserving the user's
//! existing status line command and stdout. No credential or refresh ownership.
use serde_json::{json, Value};
use std::path::Path;

#[cfg(windows)]
pub const WINDOWS_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()
try {
    $data = $raw | ConvertFrom-Json
    if ($data.session_id) {
        $data | Add-Member -NotePropertyName event -NotePropertyValue 'StatusLine' -Force
        $client = [System.Net.Sockets.TcpClient]::new()
        if ($client.ConnectAsync('127.0.0.1', 19283).Wait(200)) {
            $client.SendTimeout = 200
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($data | ConvertTo-Json -Depth 100 -Compress))
            $stream = $client.GetStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
        }
        $client.Close()
    }
} catch {}
$original = Join-Path $PSScriptRoot 'ooclaw-statusline-original.sh'
if (Test-Path -LiteralPath $original) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $bash = $env:CLAUDE_CODE_GIT_BASH_PATH
    if (-not $bash -or -not (Test-Path -LiteralPath $bash)) {
        $bash = @(
            (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'),
            (Get-Command bash -ErrorAction SilentlyContinue).Source
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    }
    if (-not $bash) { exit 1 }
    $start.FileName = $bash
    $start.Arguments = '"' + $original.Replace('\', '/') + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    # Preserve stdout/stderr directly, including ANSI escapes and newlines.
    $process = [System.Diagnostics.Process]::Start($start)
    $process.StandardInput.Write($raw)
    $process.StandardInput.Close()
    $process.WaitForExit()
    exit $process.ExitCode
}
"#;

#[cfg(not(windows))]
pub const UNIX_SCRIPT: &str = r#"#!/usr/bin/env python3
import json, os, socket, subprocess, sys
raw = sys.stdin.buffer.read()
try:
    data = json.loads(raw)
    if data.get('session_id'):
        data['event'] = 'StatusLine'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            sock.connect('/tmp/ooclaw-claude.sock')
            sock.sendall(json.dumps(data).encode('utf-8'))
except Exception:
    pass
original = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ooclaw-statusline-original.sh')
if os.path.isfile(original):
    sys.exit(subprocess.run(['bash', original], input=raw).returncode)
"#;

/// Wrap only the command. Preserve padding and other settings, and never wrap
/// our own wrapper recursively on subsequent installs.
pub fn install(settings: &mut Value, hooks_dir: &Path, command: &str) -> Result<(), String> {
    let root = settings.as_object_mut().ok_or("settings not object")?;
    let existing = root.get("statusLine");
    if let Some(existing) = existing {
        if existing["type"].as_str() != Some("command") || existing["command"].as_str().is_none() {
            return Err("Unsupported statusLine configuration; leaving it untouched".into());
        }
    }
    let original = existing.and_then(|v| v["command"].as_str());
    let original_path = hooks_dir.join("ooclaw-statusline-original.sh");
    if let Some(original) = original.filter(|s| !s.contains("ooclaw-statusline.")) {
        std::fs::write(&original_path, original).map_err(|e| e.to_string())?;
    } else if original.is_none() && original_path.exists() {
        // A user removed their status line; don't resurrect an old saved one.
        std::fs::remove_file(&original_path).map_err(|e| e.to_string())?;
    }
    let mut statusline = existing.cloned().unwrap_or(json!({"type":"command"}));
    statusline["command"] = json!(command);
    root.insert("statusLine".into(), statusline);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_preserves_user_command_and_settings_and_never_recursively_wraps() {
        let dir = std::env::temp_dir().join(format!("oc-claw-statusline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut settings = json!({"statusLine":{"type":"command","command":"echo '中文'", "padding":2},"theme":"dark"});
        install(
            &mut settings,
            &dir,
            "powershell -File ooclaw-statusline.ps1",
        )
        .unwrap();
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("ooclaw-statusline-original.sh")).unwrap(),
            "echo '中文'"
        );
        assert_eq!(settings["statusLine"]["padding"], 2);
        assert_eq!(settings["theme"], "dark");
        let before = settings.clone();
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert_eq!(settings, before);
        settings.as_object_mut().unwrap().remove("statusLine");
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert!(!dir.join("ooclaw-statusline-original.sh").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
