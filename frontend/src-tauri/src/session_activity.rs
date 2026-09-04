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
}
