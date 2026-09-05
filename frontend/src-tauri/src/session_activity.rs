use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivityKind {
    Reasoning,
    Read,
    List,
    Search,
    Edit,
    Command,
    Tool,
    Web,
    Subagent,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivitySource {
    ReasoningSummary,
    ToolCall,
    AgentMessage,
    Derived,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionActivity {
    pub kind: SessionActivityKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub status: String, // "running" | "completed"
    pub source: SessionActivitySource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteraction {
    pub kind: String, // "approval" | "user_input"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_type: Option<String>, // "command" | "file_change" | "permissions" | "mcp" | "user_input" | "unknown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
}

/// Normalizes a raw reasoning summary string:
/// - Strips Markdown headings (e.g. ### ...)
/// - Strips Markdown emphasis (**...**, *...*, __...__, _..._)
/// - Strips code quote wrappers (`...`)
/// - Strips bullet prefixes (-, *, +, 1., •)
/// - Collapses whitespace
/// - Truncates to max 180 chars
/// - Returns None if result is empty
pub fn normalize_activity_summary(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut line = "";
    // Take first non-empty line
    for l in trimmed.lines() {
        let t = l.trim();
        if !t.is_empty() {
            line = t;
            break;
        }
    }
    if line.is_empty() {
        return None;
    }

    // Strip leading Markdown headings (### ...)
    line = line.trim_start_matches('#').trim_start();

    // Strip leading bullet prefixes
    if let Some(stripped) = line.strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
        .or_else(|| line.strip_prefix("• "))
    {
        line = stripped.trim_start();
    } else if let Some(idx) = line.find(". ") {
        // e.g. "1. "
        let prefix = &line[..idx];
        if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
            line = line[idx + 2..].trim_start();
        }
    }

    // Repeatedly strip matching wrappers (code backticks, bold, italic, quotes)
    loop {
        line = line.trim();
        let len = line.len();
        if len >= 6 && line.starts_with("```") && line.ends_with("```") {
            line = &line[3..len - 3];
            continue;
        }
        if len >= 4 && ((line.starts_with("**") && line.ends_with("**")) || (line.starts_with("__") && line.ends_with("__"))) {
            line = &line[2..len - 2];
            continue;
        }
        if len >= 2 && ((line.starts_with('*') && line.ends_with('*'))
            || (line.starts_with('_') && line.ends_with('_'))
            || (line.starts_with('`') && line.ends_with('`'))
            || (line.starts_with('"') && line.ends_with('"'))
            || (line.starts_with('\'') && line.ends_with('\'')))
        {
            line = &line[1..len - 1];
            continue;
        }
        break;
    }

    // Collapse whitespace
    let mut collapsed = String::with_capacity(line.len());
    let mut prev_space = false;
    for c in line.chars() {
        if c.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(c);
            prev_space = false;
        }
    }

    let result = collapsed.trim();
    if result.is_empty() {
        return None;
    }

    // Safe truncation at UTF-8 char boundary (max 180 chars)
    let truncated: String = result.chars().take(180).collect();
    let final_clean = truncated.trim();
    if final_clean.is_empty() {
        None
    } else {
        Some(final_clean.to_string())
    }
}

/// Extract clean basename from path string (forward slash or backslash).
pub fn extract_basename(path_str: &str) -> String {
    let unquoted = path_str.trim().trim_matches(['"', '\'', '`']);
    let normalized = unquoted.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if let Some(pos) = trimmed.rfind('/') {
        trimmed[pos + 1..].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Clean tool name: remove prefixes like `mcp__server__`, replace `_` and `-` with space.
pub fn normalize_tool_name(tool_name: &str) -> String {
    let mut s = tool_name.trim();
    if let Some(pos) = s.rfind("__") {
        s = &s[pos + 2..];
    }
    let cleaned = s.replace(['_', '-'], " ");
    let collapsed: String = cleaned
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    let truncated: String = collapsed.chars().take(50).collect();
    if truncated.is_empty() {
        tool_name.to_string()
    } else {
        truncated
    }
}

/// Helper to read a string field from a JSON value that might be either an object with string keys
/// or a JSON string that needs parsing.
fn get_field_str(args: &serde_json::Value, keys: &[&str]) -> Option<String> {
    if let Some(obj) = args.as_object() {
        for &k in keys {
            if let Some(v) = obj.get(k) {
                if let Some(s) = v.as_str() {
                    let unq = s.trim().trim_matches(['"', '\'']);
                    if !unq.is_empty() {
                        return Some(unq.to_string());
                    }
                }
            }
        }
    } else if let Some(raw_str) = args.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_str) {
            return get_field_str(&parsed, keys);
        }
    }
    None
}

/// Normalizes Antigravity tool call into structured SessionActivity.
/// Uses tool name + argument keys. Does NOT expose arbitrary planner internal content.
pub fn normalize_antigravity_tool_activity(tool_name: &str, args: &serde_json::Value) -> Option<SessionActivity> {
    let name_lower = tool_name.to_ascii_lowercase();

    // 1. invoke_subagent
    if name_lower == "invoke_subagent" {
        return Some(SessionActivity {
            kind: SessionActivityKind::Subagent,
            target: None,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 2. Web search
    if name_lower.contains("search_web") || name_lower.contains("web_search") {
        let query = get_field_str(args, &["query", "Query"])
            .map(|q| q.chars().take(100).collect());
        return Some(SessionActivity {
            kind: SessionActivityKind::Web,
            target: None,
            query,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // Extract target file path if present
    let path_val = get_field_str(args, &[
        "TargetFile", "AbsolutePath", "file_path", "filePath", "path", "target_file",
    ]);
    let target = path_val.as_deref().map(extract_basename).filter(|b| !b.is_empty());

    // Extract query / pattern if present
    let query_val = get_field_str(args, &["Query", "query", "Pattern", "pattern"])
        .map(|q| q.chars().take(100).collect::<String>())
        .filter(|q| !q.is_empty());

    // 3. Read / view / open / cat
    if (name_lower.contains("read") || name_lower.contains("view") || name_lower.contains("open") || name_lower.contains("cat"))
        && target.is_some()
    {
        return Some(SessionActivity {
            kind: SessionActivityKind::Read,
            target,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 4. Search / grep / find
    if name_lower.contains("search") || name_lower.contains("grep") || name_lower.contains("find") || name_lower.contains("query") {
        return Some(SessionActivity {
            kind: SessionActivityKind::Search,
            target: None,
            query: query_val,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 5. List files / directory
    if name_lower.contains("list") || name_lower.contains("ls") || name_lower.contains("dir") {
        return Some(SessionActivity {
            kind: SessionActivityKind::List,
            target: None,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 6. Edit / write / replace / patch
    if name_lower.contains("edit") || name_lower.contains("write") || name_lower.contains("replace") || name_lower.contains("patch") || name_lower.contains("apply") {
        return Some(SessionActivity {
            kind: SessionActivityKind::Edit,
            target,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 7. Command / shell execution
    if name_lower.contains("command") || name_lower.contains("bash") || name_lower.contains("shell") || name_lower.contains("terminal")
        || get_field_str(args, &["CommandLine", "command", "cmd"]).is_some()
    {
        return Some(SessionActivity {
            kind: SessionActivityKind::Command,
            target: None,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        });
    }

    // 8. Fallback to generic tool
    Some(SessionActivity {
        kind: SessionActivityKind::Tool,
        target: None,
        query: None,
        count: None,
        summary: None,
        tool_name: Some(normalize_tool_name(tool_name)),
        status: "running".to_string(),
        source: SessionActivitySource::ToolCall,
    })
}

/// Generic Tool Activity Normalizer for other harnesses (Cursor, Gemini CLI, Claude CLI, OpenCode, Hermes).
pub fn generic_tool_activity(tool_name: &str, tool_input: &serde_json::Value) -> Option<SessionActivity> {
    normalize_antigravity_tool_activity(tool_name, tool_input)
}

/// Helper to parse tool arguments from Codex tool payload (custom_tool_call or function_call).
fn parse_codex_args_value(val: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(val) = val else {
        return serde_json::json!({});
    };
    if val.is_object() {
        return val.clone();
    }
    let Some(raw) = val.as_str() else {
        return serde_json::json!({});
    };
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        if parsed.is_object() {
            return parsed;
        }
    }
    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            if end > start {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw[start..=end]) {
                    if parsed.is_object() {
                        return parsed;
                    }
                }
            }
        }
    }
    serde_json::json!({})
}

/// Analyze shell command line to determine if it's reading a file, searching, or listing.
fn classify_shell_command(cmd: &str) -> SessionActivity {
    let trimmed = cmd.trim();
    let lower = trimmed.to_ascii_lowercase();

    // Check for reading commands (cat, Get-Content, type, head, tail)
    let read_prefixes = ["cat ", "get-content ", "type ", "head ", "tail "];
    for p in read_prefixes {
        if lower.starts_with(p) {
            let rest = trimmed[p.len()..].trim();
            // Take first argument before pipes or flags
            let first_arg = rest.split(['|', '>', ';', '&']).next().unwrap_or("").trim();
            let file_candidate = first_arg.split_whitespace().next().unwrap_or("").trim_matches(['"', '\'']);
            let basename = extract_basename(file_candidate);
            if !basename.is_empty() && !basename.starts_with('-') {
                return SessionActivity {
                    kind: SessionActivityKind::Read,
                    target: Some(basename),
                    query: None,
                    count: None,
                    summary: None,
                    tool_name: None,
                    status: "running".to_string(),
                    source: SessionActivitySource::ToolCall,
                };
            }
        }
    }

    // Check for search commands (grep, rg, Select-String, findstr)
    let search_prefixes = ["grep ", "rg ", "select-string ", "findstr "];
    for p in search_prefixes {
        if lower.starts_with(p) {
            let rest = trimmed[p.len()..].trim();
            // Try extracting quoted pattern or first non-flag arg
            let mut query = String::new();
            if let Some(q_start) = rest.find('"') {
                if let Some(q_end) = rest[q_start + 1..].find('"') {
                    query = rest[q_start + 1..q_start + 1 + q_end].to_string();
                }
            } else if let Some(q_start) = rest.find('\'') {
                if let Some(q_end) = rest[q_start + 1..].find('\'') {
                    query = rest[q_start + 1..q_start + 1 + q_end].to_string();
                }
            }
            if query.is_empty() {
                for token in rest.split_whitespace() {
                    if !token.starts_with('-') && !token.starts_with('/') {
                        query = token.to_string();
                        break;
                    }
                }
            }
            let truncated_query: String = query.chars().take(100).collect();
            return SessionActivity {
                kind: SessionActivityKind::Search,
                target: None,
                query: if truncated_query.is_empty() { None } else { Some(truncated_query) },
                count: None,
                summary: None,
                tool_name: None,
                status: "running".to_string(),
                source: SessionActivitySource::ToolCall,
            };
        }
    }

    // Check for listing commands (ls, dir, Get-ChildItem)
    if lower.starts_with("ls") || lower.starts_with("dir") || lower.starts_with("get-childitem") {
        return SessionActivity {
            kind: SessionActivityKind::List,
            target: None,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        };
    }

    // Default to command
    SessionActivity {
        kind: SessionActivityKind::Command,
        target: None,
        query: None,
        count: None,
        summary: None,
        tool_name: None,
        status: "running".to_string(),
        source: SessionActivitySource::ToolCall,
    }
}

/// Extract patch targets from Codex apply_patch input.
fn classify_patch_input(input_str: &str) -> SessionActivity {
    let mut updated_files = Vec::new();
    for line in input_str.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("*** Update File:")
            .or_else(|| t.strip_prefix("*** Add File:"))
            .or_else(|| t.strip_prefix("*** Delete File:"))
        {
            let path = rest.trim();
            let base = extract_basename(path);
            if !base.is_empty() && !updated_files.contains(&base) {
                updated_files.push(base);
            }
        }
    }

    if updated_files.len() == 1 {
        SessionActivity {
            kind: SessionActivityKind::Edit,
            target: Some(updated_files[0].clone()),
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        }
    } else if updated_files.len() > 1 {
        SessionActivity {
            kind: SessionActivityKind::Edit,
            target: None,
            query: None,
            count: Some(updated_files.len()),
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        }
    } else {
        SessionActivity {
            kind: SessionActivityKind::Edit,
            target: None,
            query: None,
            count: None,
            summary: None,
            tool_name: None,
            status: "running".to_string(),
            source: SessionActivitySource::ToolCall,
        }
    }
}

/// Parses Codex transcript JSONL to find the latest active activity.
/// Follows Codex Desktop Avatar Overlay Activity Subtitle priority:
/// 1. Latest non-empty reasoning summary (normalized)
/// 2. Latest active tool call / command / file / web / mcp
/// 3. None (fallback to thinkingPool)
pub fn parse_codex_activity_from_transcript(path: &Path) -> Option<SessionActivity> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    let mut completed_calls = std::collections::HashSet::<String>::new();
    let mut latest_reasoning: Option<SessionActivity> = None;
    let mut latest_uncompleted_tool: Option<SessionActivity> = None;

    for line in lines.iter().rev().take(150) {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = parsed.get("payload");

        // Turn boundary guards: if turn has completed/aborted or a new user prompt began,
        // stop scanning to avoid leaking prior turns' activity!
        if event_type == "event_msg" {
            if let Some(p) = payload {
                let p_type = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if p_type == "task_complete" || p_type == "turn_aborted" || p_type == "user_message" {
                    break;
                }
            }
        }
        if event_type == "turn_aborted" || event_type == "user" {
            break;
        }
        if event_type == "response_item" {
            if let Some(p) = payload {
                let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "user" {
                    break;
                }
            }
        }

        // Track completed calls
        if event_type == "event_msg" {
            if let Some(p) = payload {
                let p_type = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if p_type == "mcp_tool_call_end" {
                    if let Some(cid) = p.get("call_id").and_then(|v| v.as_str()) {
                        completed_calls.insert(cid.to_string());
                    }
                }
                // Check event_msg: agent_reasoning or stream deltas
                if (p_type == "agent_reasoning" || p_type == "reasoning_summary_text_delta" || p_type == "reasoning_summary_delta")
                    && latest_reasoning.is_none()
                {
                    let txt_candidate = p.get("text")
                        .or_else(|| p.get("delta"))
                        .or_else(|| p.get("summary"))
                        .and_then(|v| v.as_str());
                    if let Some(txt) = txt_candidate {
                        if let Some(norm) = normalize_activity_summary(txt) {
                            latest_reasoning = Some(SessionActivity {
                                kind: SessionActivityKind::Reasoning,
                                target: None,
                                query: None,
                                count: None,
                                summary: Some(norm),
                                tool_name: None,
                                status: "running".to_string(),
                                source: SessionActivitySource::ReasoningSummary,
                            });
                        }
                    }
                }
                // Check item_completed: Reasoning
                if p_type == "item_completed" && latest_reasoning.is_none() {
                    if let Some(item) = p.get("item") {
                        if item.get("type").and_then(|v| v.as_str()) == Some("Reasoning") {
                            let sum_arr = item.get("summary_text")
                                .or_else(|| item.get("summary"))
                                .and_then(|v| v.as_array());
                            if let Some(arr) = sum_arr {
                                for item_el in arr {
                                    let txt = item_el.as_str()
                                        .or_else(|| item_el.get("text").and_then(|v| v.as_str()))
                                        .or_else(|| item_el.get("summary").and_then(|v| v.as_str()));
                                    if let Some(t) = txt {
                                        if let Some(norm) = normalize_activity_summary(t) {
                                            latest_reasoning = Some(SessionActivity {
                                                kind: SessionActivityKind::Reasoning,
                                                target: None,
                                                query: None,
                                                count: None,
                                                summary: Some(norm),
                                                tool_name: None,
                                                status: "running".to_string(),
                                                source: SessionActivitySource::ReasoningSummary,
                                            });
                                            break;
                                        }
                                    }
                                }
                            } else if let Some(txt) = item.get("summary_text")
                                .or_else(|| item.get("summary"))
                                .or_else(|| item.get("text"))
                                .and_then(|v| v.as_str())
                            {
                                if let Some(norm) = normalize_activity_summary(txt) {
                                    latest_reasoning = Some(SessionActivity {
                                        kind: SessionActivityKind::Reasoning,
                                        target: None,
                                        query: None,
                                        count: None,
                                        summary: Some(norm),
                                        tool_name: None,
                                        status: "running".to_string(),
                                        source: SessionActivitySource::ReasoningSummary,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        if event_type == "response_item" {
            if let Some(p) = payload {
                let p_type = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if p_type == "custom_tool_call_output" || p_type == "function_call_output" {
                    if let Some(cid) = p.get("call_id").and_then(|v| v.as_str()) {
                        completed_calls.insert(cid.to_string());
                    }
                }

                // Check response_item: reasoning
                if (p_type == "reasoning" || p_type == "reasoning_summary_text_delta" || p_type == "reasoning_summary_delta")
                    && latest_reasoning.is_none()
                {
                    let sum_arr = p.get("summary").and_then(|v| v.as_array());
                    if let Some(arr) = sum_arr {
                        for item in arr {
                            let txt = item.as_str()
                                .or_else(|| item.get("text").and_then(|v| v.as_str()))
                                .or_else(|| item.get("summary").and_then(|v| v.as_str()));
                            if let Some(t) = txt {
                                if let Some(norm) = normalize_activity_summary(t) {
                                    latest_reasoning = Some(SessionActivity {
                                        kind: SessionActivityKind::Reasoning,
                                        target: None,
                                        query: None,
                                        count: None,
                                        summary: Some(norm),
                                        tool_name: None,
                                        status: "running".to_string(),
                                        source: SessionActivitySource::ReasoningSummary,
                                    });
                                    break;
                                }
                            }
                        }
                    } else if let Some(txt) = p.get("summary")
                        .or_else(|| p.get("text"))
                        .or_else(|| p.get("delta"))
                        .and_then(|v| v.as_str())
                    {
                        if let Some(norm) = normalize_activity_summary(txt) {
                            latest_reasoning = Some(SessionActivity {
                                kind: SessionActivityKind::Reasoning,
                                target: None,
                                query: None,
                                count: None,
                                summary: Some(norm),
                                tool_name: None,
                                status: "running".to_string(),
                                source: SessionActivitySource::ReasoningSummary,
                            });
                        }
                    }
                }

                // Check response_item: custom_tool_call or function_call
                if (p_type == "custom_tool_call" || p_type == "function_call") && latest_uncompleted_tool.is_none() {
                    let call_id = p.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                    let call_status = p.get("status").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
                    // If call is finished/cancelled, ignore
                    if matches!(call_status.as_str(), "failed" | "cancelled" | "canceled") {
                        continue;
                    }
                    if !call_id.is_empty() && completed_calls.contains(call_id) {
                        continue;
                    }

                    let tool_name = p.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                    let tool_lower = tool_name.to_ascii_lowercase();

                    let tool_act = if tool_lower == "apply_patch" {
                        let input_str = p.get("input").and_then(|v| v.as_str()).unwrap_or("");
                        classify_patch_input(input_str)
                    } else if tool_lower == "exec" || tool_lower == "exec_command" || tool_lower == "shell_command" {
                        let args = parse_codex_args_value(p.get("arguments").or_else(|| p.get("input")));
                        let cmd = args.get("cmd").or_else(|| args.get("command")).and_then(|v| v.as_str()).unwrap_or("");
                        classify_shell_command(cmd)
                    } else if tool_lower == "view_image" || tool_lower == "read_file" {
                        let args = parse_codex_args_value(p.get("arguments").or_else(|| p.get("input")));
                        let path_val = args.get("path").or_else(|| args.get("file_path")).and_then(|v| v.as_str()).unwrap_or("");
                        let base = extract_basename(path_val);
                        SessionActivity {
                            kind: SessionActivityKind::Read,
                            target: if base.is_empty() { None } else { Some(base) },
                            query: None,
                            count: None,
                            summary: None,
                            tool_name: None,
                            status: "running".to_string(),
                            source: SessionActivitySource::ToolCall,
                        }
                    } else if tool_lower.contains("web") || tool_lower.contains("search") {
                        let args = parse_codex_args_value(p.get("arguments").or_else(|| p.get("input")));
                        let query = args.get("query").or_else(|| args.get("Query")).and_then(|v| v.as_str()).map(|q| q.chars().take(100).collect());
                        SessionActivity {
                            kind: if tool_lower.contains("web") { SessionActivityKind::Web } else { SessionActivityKind::Search },
                            target: None,
                            query,
                            count: None,
                            summary: None,
                            tool_name: None,
                            status: "running".to_string(),
                            source: SessionActivitySource::ToolCall,
                        }
                    } else {
                        // MCP or general tool call
                        SessionActivity {
                            kind: SessionActivityKind::Tool,
                            target: None,
                            query: None,
                            count: None,
                            summary: None,
                            tool_name: Some(normalize_tool_name(tool_name)),
                            status: "running".to_string(),
                            source: SessionActivitySource::ToolCall,
                        }
                    };
                    latest_uncompleted_tool = Some(tool_act);
                    // In reverse scan, if an uncompleted tool call is found, it was emitted AFTER any reasoning preceding it in this turn.
                    break;
                }
            }
        }

        // If we found reasoning summary and no newer tool call was emitted, this reasoning is the latest active step!
        if latest_reasoning.is_some() {
            break;
        }
    }

    // Return the latest active item of the turn:
    // If an uncompleted tool was running, it takes precedence over earlier reasoning in the same turn.
    // Otherwise, return reasoning summary.
    latest_uncompleted_tool.or(latest_reasoning)
}

/// Reconstructs a Codex PendingInteraction from transcript JSONL.
/// Strictly turn-scoped: halts reverse scanning on completed/aborted turns,
/// user message prompt boundaries, or turn ID mismatches so historic approval
/// requests never pollute the current turn.
pub fn reconstruct_codex_pending_interaction(
    path: &Path,
    current_turn_id: Option<&str>,
) -> Option<PendingInteraction> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    let mut completed_calls = std::collections::HashSet::<String>::new();
    let mut observed_turn_id: Option<String> = None;

    for line in lines.iter().rev().take(240) {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = parsed.get("payload");

        // Turn ID isolation: if an event carries an explicit turn ID, ensure it matches.
        let line_turn_id = payload
            .and_then(|p| p.get("turn_id").or_else(|| p.get("turnId")))
            .or_else(|| parsed.get("turn_id"))
            .or_else(|| parsed.get("turnId"))
            .and_then(|v| v.as_str());

        if let Some(expected) = current_turn_id {
            if let Some(ltid) = line_turn_id {
                if ltid != expected {
                    break;
                }
            }
        } else if let Some(ltid) = line_turn_id {
            if let Some(ref obs) = observed_turn_id {
                if ltid != obs.as_str() {
                    break;
                }
            } else {
                observed_turn_id = Some(ltid.to_string());
            }
        }

        // Turn boundary guards: if turn has completed/aborted or a new user prompt began,
        // stop scanning to avoid leaking prior turns' pending approvals!
        if event_type == "event_msg" {
            if let Some(p) = payload {
                let p_type = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if p_type == "task_complete" || p_type == "turn_completed" || p_type == "turn_aborted" || p_type == "user_message" {
                    break;
                }
                if p_type == "mcp_tool_call_end" {
                    if let Some(cid) = p.get("call_id").or_else(|| p.get("id")).and_then(|v| v.as_str()) {
                        completed_calls.insert(cid.to_string());
                    }
                }
            }
        }
        if event_type == "turn_aborted" || event_type == "turn_completed" || event_type == "task_complete" || event_type == "user" {
            break;
        }

        if event_type == "response_item" {
            if let Some(p) = payload {
                let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "user" {
                    break;
                }

                let p_type = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if p_type == "custom_tool_call_output" || p_type == "function_call_output" {
                    if let Some(cid) = p.get("call_id").or_else(|| p.get("id")).and_then(|v| v.as_str()) {
                        completed_calls.insert(cid.to_string());
                    }
                }

                if p_type == "custom_tool_call" || p_type == "function_call" {
                    let call_id = p.get("call_id").or_else(|| p.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                    if !call_id.is_empty() && completed_calls.contains(call_id) {
                        continue;
                    }

                    let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
                    if matches!(status.as_str(), "completed" | "failed" | "cancelled" | "canceled") {
                        continue;
                    }

                    let args = parse_codex_args_value(p.get("arguments").or_else(|| p.get("input")));
                    let tool = p.get("name").or_else(|| p.get("tool")).and_then(|v| v.as_str()).unwrap_or("Tool").to_string();
                    let is_user_input = tool == "request_user_input" || tool == "requestUserInput";

                    let sandbox_permissions = p.get("sandbox_permissions")
                        .or_else(|| p.get("sandboxPermissions"))
                        .or_else(|| args.get("sandbox_permissions"))
                        .or_else(|| args.get("sandboxPermissions"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    let status_needs_approval = matches!(
                        status.as_str(),
                        "pending" | "waiting" | "needs_approval" | "approval_required" | "requires_approval"
                    );
                    let args_need_approval = sandbox_permissions.eq_ignore_ascii_case("require_escalated")
                        || sandbox_permissions.eq_ignore_ascii_case("escalated")
                        || p.get("requires_approval").and_then(|v| v.as_bool()).unwrap_or(false)
                        || p.get("requiresApproval").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("requires_approval").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("requiresApproval").and_then(|v| v.as_bool()).unwrap_or(false)
                        || p.get("with_escalated_permissions").and_then(|v| v.as_bool()).unwrap_or(false)
                        || p.get("withEscalatedPermissions").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("with_escalated_permissions").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("withEscalatedPermissions").and_then(|v| v.as_bool()).unwrap_or(false)
                        || p.get("approval_required").and_then(|v| v.as_bool()).unwrap_or(false)
                        || p.get("approvalRequired").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("approval_required").and_then(|v| v.as_bool()).unwrap_or(false)
                        || args.get("approvalRequired").and_then(|v| v.as_bool()).unwrap_or(false);

                    if !status_needs_approval && !args_need_approval && !is_user_input {
                        continue;
                    }

                    let item_id = p.get("item_id").or_else(|| p.get("id")).or_else(|| parsed.get("item_id")).or_else(|| parsed.get("id")).and_then(|v| v.as_str()).map(|s| s.to_string());
                    let resolved_turn_id = line_turn_id.or(current_turn_id).map(|s| s.to_string());
                    let call_id_opt = if !call_id.is_empty() { Some(call_id.to_string()) } else { None };

                    let justification = args.get("justification")
                        .or_else(|| p.get("justification"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    if is_user_input {
                        let mut prompt_text = String::new();
                        if let Some(arr) = args.get("questions").and_then(|v| v.as_array()) {
                            if let Some(first) = arr.first() {
                                if let Some(s) = first.as_str() {
                                    prompt_text = s.to_string();
                                } else if let Some(s) = first.get("question").and_then(|v| v.as_str()) {
                                    prompt_text = s.to_string();
                                }
                            }
                        }
                        if prompt_text.is_empty() {
                            if let Some(s) = args.get("prompt").or_else(|| args.get("message")).or_else(|| args.get("question")).and_then(|v| v.as_str()) {
                                prompt_text = s.to_string();
                            }
                        }
                        if prompt_text.is_empty() {
                            if let Some(s) = p.get("prompt").or_else(|| p.get("message")).and_then(|v| v.as_str()) {
                                prompt_text = s.to_string();
                            }
                        }
                        let summary = if !prompt_text.is_empty() { Some(prompt_text.clone()) } else { None };
                        let detail = if !prompt_text.is_empty() { Some(prompt_text) } else { None };

                        return Some(PendingInteraction {
                            kind: "user_input".to_string(),
                            interaction_type: Some("user_input".to_string()),
                            turn_id: resolved_turn_id,
                            item_id,
                            call_id: call_id_opt,
                            tool: Some(tool),
                            summary,
                            detail,
                            justification,
                        });
                    }

                    // Approval interaction
                    let tool_lower = tool.to_ascii_lowercase();
                    let is_command = tool_lower == "exec" || tool_lower == "exec_command" || tool_lower == "shell_command" || tool_lower == "bash" || tool_lower == "cmd" || tool_lower == "powershell";
                    let is_file = tool_lower == "apply_patch" || tool_lower == "write_file" || tool_lower == "edit_file" || tool_lower == "create_file" || tool_lower == "save_file";
                    let is_mcp = tool_lower.starts_with("mcp__") || tool_lower.starts_with("mcp_") || tool_lower.contains("mcp");

                    let interaction_type = if is_command {
                        Some("command".to_string())
                    } else if is_file {
                        Some("file_change".to_string())
                    } else if is_mcp {
                        Some("mcp".to_string())
                    } else if args_need_approval && (sandbox_permissions.eq_ignore_ascii_case("require_escalated") || sandbox_permissions.eq_ignore_ascii_case("escalated")) {
                        Some("permissions".to_string())
                    } else {
                        Some("unknown".to_string())
                    };

                    let cmd = args.get("cmd").or_else(|| args.get("command")).and_then(|v| v.as_str()).unwrap_or("");
                    let file_target = args.get("path").or_else(|| args.get("file_path")).or_else(|| args.get("target")).and_then(|v| v.as_str()).unwrap_or("");

                    let summary = if !cmd.is_empty() {
                        Some(cmd.to_string())
                    } else if !file_target.is_empty() {
                        Some(extract_basename(file_target))
                    } else if let Some(ref just) = justification {
                        Some(just.clone())
                    } else {
                        Some(tool.clone())
                    };

                    let detail = if !cmd.is_empty() {
                        Some(cmd.to_string())
                    } else if !file_target.is_empty() {
                        Some(file_target.to_string())
                    } else {
                        justification.clone()
                    };

                    return Some(PendingInteraction {
                        kind: "approval".to_string(),
                        interaction_type,
                        turn_id: resolved_turn_id,
                        item_id,
                        call_id: call_id_opt,
                        tool: Some(tool),
                        summary,
                        detail,
                        justification,
                    });
                }
            }
        }
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AntigravityActivityOrigin {
    PlannerFallback = 1,
    ExecutionStep = 2,
    Hook = 3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityExecutionActivity {
    pub activity: Option<SessionActivity>,
    pub tool: Option<String>,
    pub tool_input: Option<String>,
    pub origin: AntigravityActivityOrigin,
    pub is_running: bool,
    pub step_index: Option<u64>,
}

fn map_execution_type_to_tool_name(type_name: &str) -> Option<&'static str> {
    match type_name {
        "VIEW_FILE" | "READ_FILE" => Some("view_file"),
        "LIST_DIRECTORY" | "LIST_DIR" | "LIST_FILES" => Some("list_dir"),
        "GREP_SEARCH" | "FIND_BY_NAME" => Some("grep_search"),
        "SEARCH_WEB" | "WEB_SEARCH" => Some("search_web"),
        "RUN_COMMAND" | "EXECUTE_COMMAND" => Some("run_command"),
        "CODE_ACTION" | "WRITE_FILE" | "WRITE_TO_FILE" | "REPLACE_FILE_CONTENT" | "REPLACE" | "PATCH" => Some("write_to_file"),
        _ => None,
    }
}

/// Analyzes Antigravity transcript lines strictly within the current user turn
/// to find the latest active tool execution, respecting the priority:
/// 1. Latest RUNNING tool/action step (ExecutionStep)
/// 2. Latest PLANNER_RESPONSE uncompleted tool call (PlannerFallback)
/// 3. None when tool is DONE or no tools are active (thinkingPool fallback)
pub fn extract_antigravity_execution_activity(lines: &[&str]) -> AntigravityExecutionActivity {
    // 1. Locate the latest user prompt boundary
    let mut last_user_idx = None;
    for (idx, line) in lines.iter().enumerate() {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        let source_field = parsed.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if (source_field == "USER_EXPLICIT" || source_field == "USER") && (msg_type == "USER_INPUT" || msg_type == "user") {
            last_user_idx = Some(idx);
        }
    }

    if let Some(u_idx) = last_user_idx {
        if u_idx + 1 >= lines.len() {
            // Turn just began with user prompt, no model action yet
            return AntigravityExecutionActivity {
                activity: None,
                tool: None,
                tool_input: None,
                origin: AntigravityActivityOrigin::PlannerFallback,
                is_running: false,
                step_index: None,
            };
        }
    }

    let turn_lines = match last_user_idx {
        Some(idx) => &lines[idx + 1..],
        None => lines,
    };

    let parsed_turn: Vec<Option<serde_json::Value>> = turn_lines
        .iter()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect();

    // 2. Find the latest PLANNER_RESPONSE within this turn
    let mut latest_planner_idx = None;
    for (idx, p_opt) in parsed_turn.iter().enumerate() {
        if let Some(parsed) = p_opt {
            let source_field = parsed.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if source_field == "MODEL" && msg_type == "PLANNER_RESPONSE" {
                latest_planner_idx = Some(idx);
            }
        }
    }

    let p_idx = match latest_planner_idx {
        Some(idx) => idx,
        None => {
            return AntigravityExecutionActivity {
                activity: None,
                tool: None,
                tool_input: None,
                origin: AntigravityActivityOrigin::PlannerFallback,
                is_running: false,
                step_index: None,
            };
        }
    };

    let planner = parsed_turn[p_idx].as_ref().unwrap();
    let planner_step_index = planner.get("step_index").and_then(|v| v.as_u64());

    let mut planner_tool_calls: Vec<(String, serde_json::Value)> = Vec::new();
    if let Some(arr) = planner.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in arr {
            let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            if !name.is_empty() {
                let args = tc.get("args").cloned().unwrap_or(serde_json::json!({}));
                planner_tool_calls.push((name, args));
            }
        }
    }

    // 3. Scan execution steps strictly AFTER this latest planner response
    struct ExecStep {
        step_index: Option<u64>,
        type_name: String,
        status: String,
        args: serde_json::Value,
    }
    let mut exec_steps: Vec<ExecStep> = Vec::new();

    for p_opt in &parsed_turn[p_idx + 1..] {
        let Some(parsed) = p_opt else { continue; };
        let source_field = parsed.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

        let is_exec = source_field == "MODEL" && (
            msg_type == "GENERIC"
            || msg_type == "VIEW_FILE" || msg_type == "READ_FILE"
            || msg_type == "LIST_DIRECTORY" || msg_type == "LIST_DIR" || msg_type == "LIST_FILES"
            || msg_type == "GREP_SEARCH" || msg_type == "FIND_BY_NAME"
            || msg_type == "SEARCH_WEB" || msg_type == "WEB_SEARCH"
            || msg_type == "RUN_COMMAND" || msg_type == "EXECUTE_COMMAND"
            || msg_type == "CODE_ACTION" || msg_type == "WRITE_FILE" || msg_type == "WRITE_TO_FILE"
            || msg_type == "REPLACE_FILE_CONTENT" || msg_type == "REPLACE" || msg_type == "PATCH"
            || msg_type.contains("TOOL") || msg_type.contains("ACTION")
        );

        if is_exec {
            let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("DONE").to_string();
            let step_index = parsed.get("step_index").and_then(|v| v.as_u64());

            let mut args = parsed.get("args")
                .or_else(|| parsed.get("parameters"))
                .or_else(|| parsed.get("tool_input"))
                .cloned()
                .unwrap_or(serde_json::json!({}));

            if !args.is_object() || args.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                if let Some(target) = parsed.get("target").or_else(|| parsed.get("path")).or_else(|| parsed.get("AbsolutePath")).or_else(|| parsed.get("TargetFile")) {
                    args["TargetFile"] = target.clone();
                }
                if let Some(q) = parsed.get("query").or_else(|| parsed.get("Query")).or_else(|| parsed.get("pattern")) {
                    args["Query"] = q.clone();
                }
                if let Some(c) = parsed.get("CommandLine").or_else(|| parsed.get("command")).or_else(|| parsed.get("cmd")) {
                    args["CommandLine"] = c.clone();
                }
            }

            exec_steps.push(ExecStep {
                step_index,
                type_name: msg_type.to_string(),
                status,
                args,
            });
        }
    }

    let completed_count = exec_steps.iter().filter(|s| s.status == "DONE").count();

    if let Some(last_exec) = exec_steps.last() {
        if last_exec.status == "RUNNING" {
            let (tool_name, tool_args) = if let Some(mapped_name) = map_execution_type_to_tool_name(&last_exec.type_name) {
                let args = if last_exec.args.is_object() && !last_exec.args.as_object().unwrap().is_empty() {
                    last_exec.args.clone()
                } else if let Some((_, planner_args)) = planner_tool_calls.get(completed_count) {
                    planner_args.clone()
                } else if let Some((_, planner_args)) = planner_tool_calls.first() {
                    planner_args.clone()
                } else {
                    last_exec.args.clone()
                };
                (mapped_name.to_string(), args)
            } else {
                if let Some((planner_name, planner_args)) = planner_tool_calls.get(completed_count) {
                    (planner_name.clone(), planner_args.clone())
                } else if let Some((planner_name, planner_args)) = planner_tool_calls.first() {
                    (planner_name.clone(), planner_args.clone())
                } else {
                    ("tool".to_string(), last_exec.args.clone())
                }
            };

            let act = normalize_antigravity_tool_activity(&tool_name, &tool_args);
            return AntigravityExecutionActivity {
                activity: act,
                tool: Some(tool_name),
                tool_input: Some(tool_args.to_string()),
                origin: AntigravityActivityOrigin::ExecutionStep,
                is_running: true,
                step_index: last_exec.step_index,
            };
        } else {
            // last_exec.status == "DONE"
            if completed_count < planner_tool_calls.len() {
                let (next_tool, next_args) = &planner_tool_calls[completed_count];
                let act = normalize_antigravity_tool_activity(next_tool, next_args);
                return AntigravityExecutionActivity {
                    activity: act,
                    tool: Some(next_tool.clone()),
                    tool_input: Some(next_args.to_string()),
                    origin: AntigravityActivityOrigin::PlannerFallback,
                    is_running: true,
                    step_index: last_exec.step_index,
                };
            } else {
                return AntigravityExecutionActivity {
                    activity: None,
                    tool: None,
                    tool_input: None,
                    origin: AntigravityActivityOrigin::ExecutionStep,
                    is_running: false,
                    step_index: last_exec.step_index,
                };
            }
        }
    }

    // No execution steps after planner yet -> use first tool call as fallback
    if let Some((first_tool, first_args)) = planner_tool_calls.first() {
        let act = normalize_antigravity_tool_activity(first_tool, first_args);
        AntigravityExecutionActivity {
            activity: act,
            tool: Some(first_tool.clone()),
            tool_input: Some(first_args.to_string()),
            origin: AntigravityActivityOrigin::PlannerFallback,
            is_running: true,
            step_index: planner_step_index,
        }
    } else {
        AntigravityExecutionActivity {
            activity: None,
            tool: None,
            tool_input: None,
            origin: AntigravityActivityOrigin::PlannerFallback,
            is_running: false,
            step_index: planner_step_index,
        }
    }
}

/// Parses Antigravity transcript JSONL file to find the latest active activity.
pub fn parse_antigravity_activity_from_transcript(path: &Path) -> Option<SessionActivity> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    extract_antigravity_execution_activity(&lines).activity
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_activity_summary_headings() {
        assert_eq!(
            normalize_activity_summary("### Inspecting bubble handling").as_deref(),
            Some("Inspecting bubble handling")
        );
        assert_eq!(
            normalize_activity_summary("# Deep dive into architecture").as_deref(),
            Some("Deep dive into architecture")
        );
    }

    #[test]
    fn test_normalize_activity_summary_emphasis() {
        assert_eq!(
            normalize_activity_summary("**Checking activity fallback**").as_deref(),
            Some("Checking activity fallback")
        );
        assert_eq!(
            normalize_activity_summary("*Checking italic text*").as_deref(),
            Some("Checking italic text")
        );
        assert_eq!(
            normalize_activity_summary("__Checking underline__").as_deref(),
            Some("Checking underline")
        );
    }

    #[test]
    fn test_normalize_activity_summary_bullet_and_code() {
        assert_eq!(
            normalize_activity_summary("- `Testing code quote`").as_deref(),
            Some("Testing code quote")
        );
        assert_eq!(
            normalize_activity_summary("1. Checking list numbers").as_deref(),
            Some("Checking list numbers")
        );
        assert_eq!(
            normalize_activity_summary("• Bullet point text").as_deref(),
            Some("Bullet point text")
        );
    }

    #[test]
    fn test_normalize_activity_summary_empty() {
        assert_eq!(normalize_activity_summary(""), None);
        assert_eq!(normalize_activity_summary("   \n\t  "), None);
        assert_eq!(normalize_activity_summary("### "), None);
        assert_eq!(normalize_activity_summary("****"), None);
    }

    #[test]
    fn test_antigravity_tool_mapping_view_file() {
        let args = serde_json::json!({
            "AbsolutePath": "/repo/frontend/src/MascotBubble.tsx"
        });
        let act = normalize_antigravity_tool_activity("view_file", &args).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Read);
        assert_eq!(act.target.as_deref(), Some("MascotBubble.tsx"));
    }

    #[test]
    fn test_antigravity_tool_mapping_search() {
        let args = serde_json::json!({
            "Query": "BubbleSessionDetail"
        });
        let act = normalize_antigravity_tool_activity("grep_search", &args).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Search);
        assert_eq!(act.query.as_deref(), Some("BubbleSessionDetail"));
    }

    #[test]
    fn test_antigravity_tool_mapping_unknown() {
        let args = serde_json::json!({});
        let act = normalize_antigravity_tool_activity("some_new_tool", &args).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Tool);
        assert_eq!(act.tool_name.as_deref(), Some("some new tool"));
    }

    #[test]
    fn test_antigravity_tool_mapping_run_command() {
        let args = serde_json::json!({
            "CommandLine": "git status"
        });
        let act = normalize_antigravity_tool_activity("run_command", &args).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Command);
    }

    #[test]
    fn test_classify_patch_input_single_and_multi() {
        let patch_single = "*** Begin Patch\n*** Update File: C:\\repo\\frontend\\src\\Mini.tsx\n";
        let act_single = classify_patch_input(patch_single);
        assert_eq!(act_single.kind, SessionActivityKind::Edit);
        assert_eq!(act_single.target.as_deref(), Some("Mini.tsx"));

        let patch_multi = "*** Update File: a.ts\n*** Update File: b.ts\n";
        let act_multi = classify_patch_input(patch_multi);
        assert_eq!(act_multi.kind, SessionActivityKind::Edit);
        assert_eq!(act_multi.count, Some(2));
    }

    #[test]
    fn test_codex_reasoning_summary_priority_over_tool() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_reasoning_over_tool.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"id\":\"c1\",\"name\":\"exec\",\"input\":\"{\\\"cmd\\\":\\\"cargo check\\\"}\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"**Inspecting bubble logic**\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Reasoning);
        assert_eq!(act.summary.as_deref(), Some("Inspecting bubble logic"));
        assert_eq!(act.source, SessionActivitySource::ReasoningSummary);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_codex_command_read_detection() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_cmd_read.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"id\":\"c1\",\"name\":\"exec\",\"input\":\"{\\\"cmd\\\":\\\"Get-Content C:\\\\\\\\path\\\\\\\\to\\\\\\\\MascotBubble.tsx\\\"}\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Read);
        assert_eq!(act.target.as_deref(), Some("MascotBubble.tsx"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_normalize_activity_summary_nested() {
        assert_eq!(
            normalize_activity_summary("### **Inspecting code**").as_deref(),
            Some("Inspecting code")
        );
        assert_eq!(
            normalize_activity_summary("**`Testing code quote`**").as_deref(),
            Some("Testing code quote")
        );
        assert_eq!(
            normalize_activity_summary("`**Bold inside code**`").as_deref(),
            Some("Bold inside code")
        );
        assert_eq!(
            normalize_activity_summary("***Bold and italic***").as_deref(),
            Some("Bold and italic")
        );
        assert_eq!(
            normalize_activity_summary("__*Underline italic*__").as_deref(),
            Some("Underline italic")
        );
    }

    #[test]
    fn test_codex_running_tool_takes_precedence_over_earlier_reasoning() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_running_tool_over_reasoning.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Inspecting bubble logic\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"id\":\"c2\",\"name\":\"exec\",\"input\":\"{\\\"cmd\\\":\\\"cargo check\\\"}\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path).unwrap();
        assert_eq!(act.kind, SessionActivityKind::Command);
        assert_eq!(act.source, SessionActivitySource::ToolCall);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_codex_turn_complete_clears_activity() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_turn_complete.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Inspecting bubble logic\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"id\":\"c3\",\"name\":\"exec\",\"input\":\"{\\\"cmd\\\":\\\"cargo check\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"c3\",\"output\":\"ok\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path);
        assert_eq!(act, None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_codex_turn_aborted_clears_activity() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_turn_aborted.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Inspecting bubble logic\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path);
        assert_eq!(act, None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_codex_user_message_boundary_prevents_leak() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_codex_user_message_boundary.jsonl");

        std::fs::write(&path, concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Old reasoning from prior turn\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"New task for you\"}}\n"
        )).unwrap();

        let act = parse_codex_activity_from_transcript(&path);
        assert_eq!(act, None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_antigravity_multi_tool_activity_transitions() {
        let lines = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Fix activity tracking\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"grep_search\",\"args\":{\"Query\":\"SessionActivity\"}}]}",
            "{\"step_index\":4,\"source\":\"MODEL\",\"type\":\"GREP_SEARCH\",\"status\":\"RUNNING\"}",
        ];

        let res = extract_antigravity_execution_activity(&lines);
        assert!(res.is_running);
        assert_eq!(res.origin, AntigravityActivityOrigin::ExecutionStep);
        assert_eq!(res.tool.as_deref(), Some("grep_search"));
        let act = res.activity.unwrap();
        assert_eq!(act.kind, SessionActivityKind::Search);
        assert_eq!(act.query.as_deref(), Some("SessionActivity"));

        // Now step 4 finishes and step 5 is planned with CODE_ACTION
        let lines2 = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Fix activity tracking\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"grep_search\",\"args\":{\"Query\":\"SessionActivity\"}}]}",
            "{\"step_index\":4,\"source\":\"MODEL\",\"type\":\"GREP_SEARCH\",\"status\":\"DONE\"}",
            "{\"step_index\":5,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"write_to_file\",\"args\":{\"TargetFile\":\"Bar.ts\"}}]}",
            "{\"step_index\":6,\"source\":\"MODEL\",\"type\":\"CODE_ACTION\",\"status\":\"RUNNING\"}",
        ];

        let res2 = extract_antigravity_execution_activity(&lines2);
        assert!(res2.is_running);
        assert_eq!(res2.origin, AntigravityActivityOrigin::ExecutionStep);
        assert_eq!(res2.tool.as_deref(), Some("write_to_file"));
        let act2 = res2.activity.unwrap();
        assert_eq!(act2.kind, SessionActivityKind::Edit);
        assert_eq!(act2.target.as_deref(), Some("Bar.ts"));
    }

    #[test]
    fn test_antigravity_multi_tool_calls_in_single_planner() {
        // 1. Planner response declaring 2 tools, no execution rows yet
        let lines_initial = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Batch tools\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}},{\"name\":\"grep_search\",\"args\":{\"Query\":\"Activity\"}}]}",
        ];
        let res1 = extract_antigravity_execution_activity(&lines_initial);
        assert_eq!(res1.origin, AntigravityActivityOrigin::PlannerFallback);
        assert_eq!(res1.tool.as_deref(), Some("view_file"));
        assert_eq!(res1.activity.unwrap().kind, SessionActivityKind::Read);

        // 2. First tool is RUNNING (generic or typed)
        let lines_first_running = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Batch tools\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}},{\"name\":\"grep_search\",\"args\":{\"Query\":\"Activity\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"RUNNING\"}",
        ];
        let res2 = extract_antigravity_execution_activity(&lines_first_running);
        assert_eq!(res2.origin, AntigravityActivityOrigin::ExecutionStep);
        assert_eq!(res2.tool.as_deref(), Some("view_file"));

        // 3. First tool is DONE, second tool has not started yet
        let lines_first_done = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Batch tools\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}},{\"name\":\"grep_search\",\"args\":{\"Query\":\"Activity\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
        ];
        let res3 = extract_antigravity_execution_activity(&lines_first_done);
        assert_eq!(res3.origin, AntigravityActivityOrigin::PlannerFallback);
        assert_eq!(res3.tool.as_deref(), Some("grep_search"));
        assert_eq!(res3.activity.unwrap().kind, SessionActivityKind::Search);

        // 4. Second tool is RUNNING
        let lines_second_running = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Batch tools\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}},{\"name\":\"grep_search\",\"args\":{\"Query\":\"Activity\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"GREP_SEARCH\",\"status\":\"RUNNING\"}",
        ];
        let res4 = extract_antigravity_execution_activity(&lines_second_running);
        assert_eq!(res4.origin, AntigravityActivityOrigin::ExecutionStep);
        assert_eq!(res4.tool.as_deref(), Some("grep_search"));

        // 5. Second tool is DONE -> all tools finished -> None
        let lines_all_done = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Batch tools\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Foo.ts\"}},{\"name\":\"grep_search\",\"args\":{\"Query\":\"Activity\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"GREP_SEARCH\",\"status\":\"DONE\"}",
        ];
        let res5 = extract_antigravity_execution_activity(&lines_all_done);
        assert!(!res5.is_running);
        assert_eq!(res5.activity, None);
        assert_eq!(res5.tool, None);
    }

    #[test]
    fn test_antigravity_empty_content_planner_does_not_revert_to_older() {
        let lines = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Prompt\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"I will view the file\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"Old.ts\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"\",\"tool_calls\":[{\"name\":\"grep_search\",\"args\":{\"Query\":\"NewPattern\"}}]}",
            "{\"step_index\":4,\"source\":\"MODEL\",\"type\":\"GREP_SEARCH\",\"status\":\"RUNNING\"}",
        ];

        let res = extract_antigravity_execution_activity(&lines);
        assert_eq!(res.tool.as_deref(), Some("grep_search"));
        let act = res.activity.unwrap();
        assert_eq!(act.kind, SessionActivityKind::Search);
        assert_eq!(act.query.as_deref(), Some("NewPattern"));
    }

    #[test]
    fn test_antigravity_done_lifecycle_clears_activity() {
        let lines_running = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Run build\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"cargo build\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"RUN_COMMAND\",\"status\":\"RUNNING\"}",
        ];
        let res_running = extract_antigravity_execution_activity(&lines_running);
        assert!(res_running.is_running);
        assert_eq!(res_running.activity.unwrap().kind, SessionActivityKind::Command);

        let lines_done = vec![
            "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"content\":\"Run build\"}",
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"cargo build\"}}]}",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"RUN_COMMAND\",\"status\":\"DONE\"}",
        ];
        let res_done = extract_antigravity_execution_activity(&lines_done);
        assert!(!res_done.is_running);
        assert_eq!(res_done.activity, None);
        assert_eq!(res_done.tool, None);
    }
}

