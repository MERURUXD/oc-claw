//! Codex observation hooks must stay outside the native approval gate.
use serde_json::{json, Value};

fn is_ours(handler: &Value) -> bool {
    ["command", "command_windows"].iter().any(|key| {
        handler
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains("ooclaw-codex-hook"))
    })
}

pub fn register(config: &mut Value, command: &str, append_event: bool) -> Result<(), String> {
    let hooks = config
        .as_object_mut()
        .ok_or("hooks config is not an object")?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("hooks is not an object")?;

    // Remove our legacy gate, including 600-second registrations. A matcher
    // group can also contain other tools' hooks: preserve those and its metadata.
    for entries in hooks.values_mut() {
        let entries = entries.as_array_mut().ok_or("hook event is not an array")?;
        entries.retain_mut(|entry| {
            if is_ours(entry) {
                return false;
            }
            if let Some(handlers) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
                let previous_len = handlers.len();
                handlers.retain(|handler| !is_ours(handler));
                return previous_len == handlers.len() || !handlers.is_empty();
            }
            true
        });
    }
    if hooks
        .get("PermissionRequest")
        .is_some_and(|v| v == &json!([]))
    {
        hooks.remove("PermissionRequest");
    }

    // PermissionRequest runs BEFORE Codex displays its native approval UI.
    // Do not register even an observation-only handler here. Approval reminders
    // are recovered from PreToolUse escalation metadata and the native transcript.
    for (event, matcher) in [
        ("SessionStart", false),
        ("SessionEnd", false),
        ("Interrupt", false),
        ("UserPromptSubmit", false),
        ("PreToolUse", true),
        ("PostToolUse", true),
        ("PreCompact", true),
        ("PostCompact", true),
        ("SubagentStart", true),
        ("SubagentStop", true),
        ("Stop", false),
    ] {
        let command = if append_event {
            format!("{command} {event}")
        } else {
            command.to_owned()
        };
        let mut group = json!({"hooks": [{"type": "command", "command": command, "timeout": 5}]});
        if matcher {
            group["matcher"] = json!("*");
        }
        hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("hook event is not an array")?
            .push(group);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_and_repeated_migration_leave_native_approval_unhooked() {
        for append_event in [false, true] {
            let mut config = json!({});
            register(&mut config, "ooclaw-codex-hook", append_event).unwrap();
            assert!(config["hooks"].get("PermissionRequest").is_none());
            assert_eq!(config["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"], 5);
            assert_eq!(
                config["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
                if append_event {
                    "ooclaw-codex-hook PreToolUse"
                } else {
                    "ooclaw-codex-hook"
                }
            );
            let installed = config.clone();
            register(&mut config, "ooclaw-codex-hook", append_event).unwrap();
            assert_eq!(config, installed);
        }
    }

    #[test]
    fn migration_removes_old_gate_and_preserves_other_handlers_in_shared_groups() {
        let external = json!({"type": "command", "command": "company-policy", "timeout": 20});
        let mut config = json!({
            "metadata": "keep",
            "hooks": {
                "PermissionRequest": [
                    {"command": "ooclaw-codex-hook.sh", "timeout": 600},
                    {"hooks": [{"command_windows": "pwsh ooclaw-codex-hook.ps1"}]},
                    {"matcher": "Bash", "custom": "keep", "hooks": [
                        {"command": "ooclaw-codex-hook.sh"}, external.clone()
                    ]}
                ],
                "PreToolUse": [{"matcher": "Write", "hooks": [external.clone()]}]
            }
        });
        register(&mut config, "ooclaw-codex-hook.sh", false).unwrap();
        assert_eq!(config["metadata"], "keep");
        assert_eq!(
            config["hooks"]["PermissionRequest"],
            json!([
                {"matcher": "Bash", "custom": "keep", "hooks": [external.clone()]}
            ])
        );
        assert_eq!(config["hooks"]["PreToolUse"][0]["hooks"][0], external);
        let migrated = config.clone();
        register(&mut config, "ooclaw-codex-hook.sh", false).unwrap();
        assert_eq!(config, migrated);
    }

    #[test]
    fn migration_removes_permission_event_when_only_our_hook_was_registered() {
        let mut config = json!({"hooks": {"PermissionRequest": [
            {"matcher": "*", "hooks": [{"command": "pwsh ooclaw-codex-hook.ps1 PermissionRequest", "timeout": 600}]}
        ]}});
        register(&mut config, "ooclaw-codex-hook.sh", false).unwrap();
        assert!(config["hooks"].get("PermissionRequest").is_none());
    }
}
