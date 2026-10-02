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
    #[cfg(windows)]
    if let Some(original) = original {
        if !original.contains("ooclaw-statusline.") {
            // Claude owns Bash/PowerShell selection. We cannot infer the
            // original shell from a command string, so leave it fully intact.
            // Desktop/CLI OAuth and title metadata work without this relay.
            return Ok(());
        }
        if original_path.exists() {
            // Migrate the earlier wrapper that forced all Windows commands
            // through Bash: restore the exact saved command for Claude to run.
            let saved = std::fs::read_to_string(&original_path).map_err(|e| e.to_string())?;
            let mut restored = existing.cloned().unwrap();
            restored["command"] = json!(saved);
            root.insert("statusLine".into(), restored);
            return Ok(());
        }
    }
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
    #[cfg(not(windows))]
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

    #[test]
    #[cfg(windows)]
    fn windows_leaves_existing_powershell_and_bash_semantics_to_claude() {
        // No shell lookup or invocation occurs, so this also covers hosts
        // without Git Bash and hosts whose Bash/PowerShell choice changes.
        let dir =
            std::env::temp_dir().join(format!("oc-claw-statusline-shell-{}", std::process::id()));
        for command in [
            r#"$raw = [Console]::In.ReadToEnd(); Write-Output "$raw"; exit 7"#,
            r#"cat; printf '\noriginal\n'; exit 7"#,
            "powershell -NoProfile -File C:/statusline.ps1",
        ] {
            let mut settings = json!({"statusLine":{"type":"command","command":command,"padding":2,"refreshInterval":5}});
            let before = settings.clone();
            install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
            assert_eq!(settings, before);
        }
        assert!(!dir.exists());
    }

    #[test]
    #[cfg(windows)]
    fn windows_restores_legacy_wrapper_and_does_not_resurrect_removed_commands() {
        let dir =
            std::env::temp_dir().join(format!("oc-claw-statusline-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let saved = "$raw = [Console]::In.ReadToEnd(); Write-Output '中文'; exit 7";
        let path = dir.join("ooclaw-statusline-original.sh");
        std::fs::write(&path, saved).unwrap();
        let mut settings = json!({"statusLine":{"type":"command","command":"powershell -File ooclaw-statusline.ps1","padding":2}});
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert_eq!(settings["statusLine"]["command"], saved);
        assert_eq!(settings["statusLine"]["padding"], 2);
        let once = settings.clone();
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert_eq!(settings, once);
        settings.as_object_mut().unwrap().remove("statusLine");
        install(&mut settings, &dir, "pwsh -File ooclaw-statusline.ps1").unwrap();
        assert_eq!(
            settings["statusLine"]["command"],
            "pwsh -File ooclaw-statusline.ps1"
        );
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
