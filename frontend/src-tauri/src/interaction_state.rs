//! Observe native interactions without deciding permissions or waiting on our UI.
use crate::session_activity::PendingInteraction;
use serde_json::Value;

pub fn tool_name(event: &Value) -> &str {
    event
        .get("tool_name")
        .or_else(|| event.get("tool"))
        .or_else(|| event.pointer("/toolCall/name"))
        .or_else(|| event.pointer("/tool_call/name"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub fn tool_args(event: &Value) -> Value {
    let value = event
        .get("tool_input")
        .or_else(|| event.get("toolInput"))
        .or_else(|| event.get("arguments"))
        .or_else(|| event.pointer("/toolCall/args"))
        .or_else(|| event.pointer("/tool_call/arguments"));
    match value {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

pub fn is_question(tool: &str) -> bool {
    matches!(
        tool,
        "request_user_input"
            | "requestUserInput"
            | "request_user_input_async"
            | "ask_question"
            | "AskUserQuestion"
            | "AskQuestion"
    )
}

fn call_id(event: &Value) -> Option<String> {
    event
        .get("tool_use_id")
        .or_else(|| event.get("call_id"))
        .or_else(|| event.get("callId"))
        .or_else(|| event.pointer("/toolCall/id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            event
                .get("stepIdx")
                .and_then(Value::as_u64)
                .map(|n| format!("step:{n}"))
        })
}

pub fn from_hook(event: &Value, name: &str, source: &str) -> Option<PendingInteraction> {
    if !matches!(source, "codex" | "antigravity") {
        return None;
    }
    if source == "codex" && matches!(name, "PreToolUse" | "PermissionRequest") {
        if let Some(mut parsed) = crate::parse_codex_permission_request(event) {
            parsed.hook_owned = true;
            parsed.call_id = call_id(event).or(parsed.call_id);
            return Some(parsed);
        }
    }
    let tool = tool_name(event);
    let question = is_question(tool);
    let approval =
        name == "PermissionRequest" || (source == "antigravity" && tool == "ask_permission");
    if name != "PermissionRequest" && (name != "PreToolUse" || (!question && !approval)) {
        return None;
    }
    let args = tool_args(event);
    let summary = if question {
        args.pointer("/questions/0/question")
            .or_else(|| args.pointer("/questions/0/title"))
            .or_else(|| args.get("prompt"))
            .or_else(|| args.get("question"))
    } else {
        args.get("command")
            .or_else(|| args.get("cmd"))
            .or_else(|| args.get("CommandLine"))
            .or_else(|| args.get("Reason"))
            .or_else(|| args.get("reason"))
    }
    .and_then(Value::as_str)
    .map(str::to_owned)
    .or_else(|| Some(tool.to_owned()));
    Some(PendingInteraction {
        hook_owned: true,
        kind: if question && !approval {
            "user_input"
        } else {
            "approval"
        }
        .into(),
        interaction_type: Some(
            if question && !approval {
                "user_input"
            } else if matches!(tool, "Bash" | "exec_command" | "run_command") {
                "command"
            } else {
                "permissions"
            }
            .into(),
        ),
        turn_id: event
            .get("turn_id")
            .or_else(|| event.get("turnId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        item_id: None,
        call_id: call_id(event),
        tool: Some(tool.into()),
        detail: summary.clone(),
        summary,
        justification: args
            .get("justification")
            .or_else(|| args.get("description"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        request_id: None,
        approval_actions: None,
    })
}

pub fn stale_turn(current: Option<&str>, event: &Value, name: &str) -> bool {
    if name == "UserPromptSubmit" {
        return false;
    }
    let incoming = event
        .get("turn_id")
        .or_else(|| event.get("turnId"))
        .and_then(Value::as_str);
    matches!((current, incoming), (Some(a), Some(b)) if a != b)
}

/// A missing transcript record is not a resolution. Only an explicit matching
/// result, reply, cancellation or new turn can release a hook-owned interaction.
pub fn retain(previous: &PendingInteraction, event: &Value, name: &str) -> bool {
    if !previous.hook_owned {
        return false;
    }
    if stale_turn(previous.turn_id.as_deref(), event, name) {
        return true;
    }
    if matches!(name, "Interrupt" | "SessionEnd") {
        return false;
    }
    if name == "UserPromptSubmit" {
        let prompt = event
            .get("prompt")
            .or_else(|| event.get("userPrompt"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if let Some(ids) = reply_call_ids(prompt) {
            return previous
                .call_id
                .as_ref()
                .map_or(false, |id| !ids.contains(id));
        }
        return false;
    }
    let asynchronous = previous.tool.as_deref() == Some("request_user_input_async");
    if name == "Stop" {
        return asynchronous && event.get("interrupted").and_then(Value::as_bool) != Some(true);
    }
    if name == "PostToolUse" {
        let matches = match (previous.call_id.as_deref(), call_id(event)) {
            (Some(a), Some(b)) => a == b,
            _ => previous.tool.as_deref() == Some(tool_name(event)),
        };
        if matches {
            // Async submission returns immediately; it does not answer the question.
            let failed = event
                .get("error")
                .and_then(Value::as_str)
                .map_or(false, |e| !e.is_empty())
                || event
                    .pointer("/tool_response/isError")
                    .and_then(Value::as_bool)
                    == Some(true);
            return asynchronous && !failed;
        }
    }
    true
}

fn reply_call_ids(text: &str) -> Option<Vec<String>> {
    let body = text
        .strip_prefix("<send_user_message_question_reply>")?
        .split("</send_user_message_question_reply>")
        .next()?;
    let replies: Vec<Value> = serde_json::from_str(body.trim()).ok()?;
    Some(
        replies
            .iter()
            .filter_map(|v| {
                let id: Vec<Value> =
                    serde_json::from_str(v.get("questionItemId")?.as_str()?).ok()?;
                id.get(1)?.as_str().map(str::to_owned)
            })
            .collect(),
    )
}

/// Async tool output acknowledges submission, not a user answer. Reconstruct
/// outstanding questions even after unrelated tool results and normal Stop.
pub fn codex_async_question(
    lines: &[&str],
    current_turn: Option<&str>,
) -> Option<PendingInteraction> {
    let mut questions: Vec<PendingInteraction> = Vec::new();
    let mut turn: Option<String> = None;
    for line in lines {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let p = &row["payload"];
        let declared_turn = p
            .get("turn_id")
            .or_else(|| p.pointer("/internal_chat_message_metadata_passthrough/turn_id"))
            .or_else(|| row.get("turn_id"))
            .and_then(Value::as_str);
        let kind = p["type"].as_str().unwrap_or("");
        if matches!((current_turn, declared_turn), (Some(a), Some(b)) if a != b) {
            continue;
        }
        let starts_turn = matches!(kind, "task_started" | "turn_started");
        if starts_turn {
            questions.clear();
            turn = declared_turn.map(str::to_owned);
        } else if turn.is_none() {
            turn = declared_turn.or(current_turn).map(str::to_owned);
        } else if matches!((turn.as_deref(), declared_turn), (Some(a), Some(b)) if a != b) {
            // Delayed records and metadata from an older turn cannot cancel a
            // question in the active turn.
            continue;
        }
        if matches!(kind, "turn_aborted" | "session_end") || row["type"] == "turn_aborted" {
            questions.clear();
        }
        if kind == "user_message" || p["role"] == "user" {
            let text = p
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    p.get("content").and_then(Value::as_array).map(|parts| {
                        parts
                            .iter()
                            .filter_map(|v| v["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                })
                .unwrap_or_default();
            if let Some(ids) = reply_call_ids(&text) {
                questions.retain(|q| q.call_id.as_ref().is_some_and(|id| !ids.contains(id)));
            } else {
                questions.clear();
            }
        }
        if row["type"] != "response_item" {
            continue;
        }
        if matches!(kind, "function_call" | "custom_tool_call")
            && p["name"] == "request_user_input_async"
        {
            let event = serde_json::json!({"tool_name":"request_user_input_async", "call_id":p["call_id"],
                "turn_id":turn, "tool_input":p.get("arguments").or_else(|| p.get("input"))});
            if let Some(mut q) = from_hook(&event, "PreToolUse", "codex") {
                q.hook_owned = false;
                questions.push(q);
            }
        }
        if matches!(kind, "function_call_output" | "custom_tool_call_output") {
            let output = p["output"].as_str().unwrap_or("");
            if output.trim_start().starts_with("error:")
                || p["output"].get("isError") == Some(&Value::Bool(true))
            {
                questions.retain(|q| q.call_id.as_deref() != p["call_id"].as_str());
            }
        }
    }
    questions
        .into_iter()
        .rev()
        .find(|q| current_turn.is_none() || q.turn_id.as_deref() == current_turn)
}

/// Only explicit interactive tools or a native WAITING execution step imply
/// attention. A planned/running shell command alone is never an approval.
pub fn antigravity_pending(lines: &[&str]) -> Option<PendingInteraction> {
    // A planner batch can launch several tools concurrently. Match each call to
    // its trajectory slot; counting DONE steps shifts results onto the wrong
    // call when an earlier command continues as a background task.
    let rows: Vec<Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let boundary = rows
        .iter()
        .rposition(|v| {
            matches!(v["source"].as_str(), Some("USER" | "USER_EXPLICIT"))
                && matches!(v["type"].as_str(), Some("USER_INPUT" | "user"))
        })
        .map_or(0, |i| i + 1);
    let planner_pos = (boundary..rows.len())
        .rev()
        .find(|&i| rows[i]["source"] == "MODEL" && rows[i]["type"] == "PLANNER_RESPONSE")?;
    let planner = &rows[planner_pos];
    let planner_step = planner["step_index"].as_u64()?;
    for (offset, call) in planner["tool_calls"].as_array()?.iter().enumerate() {
        let tool = call["name"].as_str().unwrap_or("");
        let step = planner_step + offset as u64 + 1;
        let execution = rows[planner_pos + 1..]
            .iter()
            .rev()
            .find(|v| v["source"] == "MODEL" && v["step_index"].as_u64() == Some(step));
        let status = execution.and_then(|v| v["status"].as_str());
        if matches!(
            status,
            Some(
                "DONE" | "ERROR" | "CANCELED" | "CANCELLED" | "INTERRUPTED" | "HALTED" | "CLEARED"
            )
        ) {
            continue;
        }
        let approval = tool == "ask_permission"
            || (status == Some("WAITING") && matches!(tool, "run_command" | "execute_command"));
        if !is_question(tool) && !approval {
            continue;
        }
        let event = serde_json::json!({"tool_name":tool,"stepIdx":step,"tool_input":call["args"]});
        let mut interaction = from_hook(
            &event,
            if approval {
                "PermissionRequest"
            } else {
                "PreToolUse"
            },
            "antigravity",
        )?;
        interaction.hook_owned = false;
        return Some(interaction);
    }
    None
}

/// Migrate the deprecated alias without re-enabling an explicitly disabled
/// feature. Per-hook trust and enabled states live in other tables, untouched.
pub fn codex_hooks_config(content: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_owned).collect();
    let header = |line: &str| line.split('#').next().unwrap_or("").trim().to_owned();
    if let Some(start) = lines.iter().position(|l| header(l) == "[features]") {
        let end = (start + 1..lines.len())
            .find(|&i| header(&lines[i]).starts_with('['))
            .unwrap_or(lines.len());
        let key = |line: &str| line.split('=').next().unwrap_or("").trim().to_owned();
        let has_current = lines[start + 1..end].iter().any(|l| key(l) == "hooks");
        let mut migrated = false;
        for i in (start + 1..end).rev() {
            if key(&lines[i]) == "codex_hooks" {
                if has_current {
                    lines.remove(i);
                } else {
                    lines[i] = lines[i].replacen("codex_hooks", "hooks", 1);
                }
                migrated = true;
            }
        }
        if !has_current && !migrated {
            lines.insert(start + 1, "hooks = true".into());
        }
    } else {
        lines.push("[features]".into());
        lines.push("hooks = true".into());
    }
    lines.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_approval_survives_unrelated_result_and_resolves_matching_call() {
        let e = json!({"tool_name":"Bash","turn_id":"t","tool_use_id":"a","tool_input":{"command":"echo test"}});
        let p = from_hook(&e, "PermissionRequest", "codex").unwrap();
        assert_eq!(p.summary.as_deref(), Some("echo test"));
        assert!(p.approval_actions.is_none());
        assert!(retain(
            &p,
            &json!({"tool_name":"Bash","tool_use_id":"b"}),
            "PostToolUse"
        ));
        assert!(!retain(&p, &e, "PostToolUse"));
        assert!(retain(&p, &json!({"turn_id":"old"}), "Stop"));
        assert!(!retain(&p, &json!({"turn_id":"t"}), "Interrupt"));
    }

    #[test]
    fn sync_and_async_questions_have_different_completion_boundaries() {
        for tool in [
            "request_user_input",
            "request_user_input_async",
            "ask_question",
        ] {
            let e = json!({"tool_name":tool,"tool_use_id":"q","tool_input":{"questions":[{"title":"Choose a color"}]}});
            let p = from_hook(&e, "PreToolUse", "codex").unwrap();
            assert_eq!(p.kind, "user_input");
            assert_eq!(p.summary.as_deref(), Some("Choose a color"));
            assert_eq!(retain(&p, &e, "PostToolUse"), tool.ends_with("_async"));
            assert_eq!(retain(&p, &json!({}), "Stop"), tool.ends_with("_async"));
            assert!(!retain(&p, &json!({}), "UserPromptSubmit"));
        }
    }

    #[test]
    fn antigravity_uses_step_identity_and_never_guesses_command_approval() {
        let mut e = json!({"stepIdx":7,"toolCall":{"name":"run_command","args":{"CommandLine":"echo test"}}});
        assert!(from_hook(&e, "PreToolUse", "antigravity").is_none());
        e["toolCall"]["name"] = json!("ask_permission");
        let p = from_hook(&e, "PreToolUse", "antigravity").unwrap();
        assert_eq!(p.kind, "approval");
        e["stepIdx"] = json!(8);
        assert!(retain(&p, &e, "PostToolUse"));
        e["stepIdx"] = json!(7);
        assert!(!retain(&p, &e, "PostToolUse"));
    }

    #[test]
    fn async_transcript_acknowledgement_is_not_an_answer() {
        let call = json!({"type":"response_item","payload":{"type":"function_call", "turn_id":"t",
            "name":"request_user_input_async","call_id":"q","arguments":{"questions":[{"title":"Choose"}]}}}).to_string();
        let ack = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"q","output":"Question sent"}}).to_string();
        let stop = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t"}})
            .to_string();
        let reply = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":
            "<send_user_message_question_reply>\n[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"q\\\",0]\",\"answer\":\"yes\"}]\n</send_user_message_question_reply>"}]}}).to_string();
        let lines = vec![call.as_str(), ack.as_str(), stop.as_str()];
        assert_eq!(
            codex_async_question(&lines, Some("t"))
                .unwrap()
                .summary
                .as_deref(),
            Some("Choose")
        );
        assert!(codex_async_question(&lines, Some("other")).is_none());
        let mut answered = lines.clone();
        answered.push(&reply);
        assert!(codex_async_question(&answered, Some("t")).is_none());
        let stale = json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"old"}})
            .to_string();
        let metadata = json!({"type":"token_usage_record","payload":{"turn_id":"old"}}).to_string();
        let mut delayed = lines.clone();
        delayed.extend([stale.as_str(), metadata.as_str()]);
        assert!(codex_async_question(&delayed, Some("t")).is_some());
        assert!(codex_async_question(&delayed, None).is_some());
        let error = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"q","output":"error: unavailable"}}).to_string();
        assert!(codex_async_question(&[call.as_str(), error.as_str()], Some("t")).is_none());
    }

    #[test]
    fn antigravity_transcript_waits_resolve_on_execution_result() {
        for tool in ["ask_question", "ask_permission", "run_command"] {
            let planner = json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                "tool_calls":[{"name":tool,"args":{"questions":[{"question":"Choose"}],"CommandLine":"echo test"}}]}).to_string();
            let waiting =
                json!({"step_index":2,"source":"MODEL","type":"GENERIC","status":"WAITING"})
                    .to_string();
            let running =
                json!({"step_index":2,"source":"MODEL","type":"GENERIC","status":"RUNNING"})
                    .to_string();
            let done = json!({"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE"})
                .to_string();
            let p = antigravity_pending(&[&planner, &waiting]).unwrap();
            assert_eq!(
                p.kind,
                if tool == "ask_question" {
                    "user_input"
                } else {
                    "approval"
                }
            );
            assert!(antigravity_pending(&[&planner, &done]).is_none());
            for status in ["ERROR", "CANCELED", "INTERRUPTED", "HALTED"] {
                let terminal =
                    json!({"step_index":2,"source":"MODEL","type":"GENERIC","status":status})
                        .to_string();
                assert!(antigravity_pending(&[&planner, &terminal]).is_none());
            }
            if tool == "run_command" {
                assert!(antigravity_pending(&[&planner]).is_none());
                assert!(antigravity_pending(&[&planner, &running]).is_none());
            }
        }
    }

    #[test]
    fn antigravity_parallel_question_is_pending_before_answer_and_clears_after() {
        let planner = json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
            "tool_calls":[{"name":"run_command","args":{"CommandLine":"echo test"}},
                {"name":"ask_question","args":{"questions":[{"question":"Choose?","options":["A","B"]}]}}]}).to_string();
        let command = json!({"step_index":2,"source":"MODEL","type":"GENERIC","status":"RUNNING"})
            .to_string();
        let answer = json!({"step_index":3,"source":"MODEL","type":"GENERIC","status":"DONE","content":"A1: B"}).to_string();
        let pending = antigravity_pending(&[&planner, &command]).unwrap();
        assert_eq!(pending.kind, "user_input");
        assert_eq!(pending.call_id.as_deref(), Some("step:3"));
        assert!(antigravity_pending(&[&planner, &command, &answer]).is_none());
        let new_turn =
            json!({"step_index":4,"source":"USER_EXPLICIT","type":"USER_INPUT"}).to_string();
        assert!(antigravity_pending(&[&planner, &command, &new_turn]).is_none());
    }

    #[test]
    fn hook_flag_migration_preserves_explicit_disables_and_other_tables() {
        let old =
            "[features]\ncodex_hooks = false # user choice\n[hooks.state.test]\nenabled = false\n";
        let expected = old.replace("codex_hooks", "hooks");
        assert_eq!(codex_hooks_config(old), expected);
        assert_eq!(codex_hooks_config(&expected), expected);
        assert_eq!(
            codex_hooks_config("[features] # note\nhooks = false\ncodex_hooks = true\n"),
            "[features] # note\nhooks = false\n"
        );
        assert_eq!(codex_hooks_config(""), "[features]\nhooks = true\n");
    }
}
