//! Hermes session metadata and turn lifecycle normalization.
//!
//! Architectural principles:
//! - Metadata plane authority: `~/.hermes/state.db`.
//!   `sessions/sessions.json` is routing/discovery only.
//! - Lifecycle plane authority: Hermes lifecycle hooks and gateway agent events.
//!   Metadata cannot terminate a live turn. Silence is not completion.
//! - `turn_id` tracks active turns. Only the canonical end boundary for that turn
//!   can transition the session to stopped.
//! - Shared plugin and gateway hook code generator ensures local and remote instances
//!   never drift.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const HERMES_PLUGIN_VERSION: &str = "0.3.0";
pub const HERMES_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HermesStatus {
    Processing,
    ToolRunning,
    Waiting,
    Stopped,
    Failed,
}

impl HermesStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            HermesStatus::Processing => "processing",
            HermesStatus::ToolRunning => "tool_running",
            HermesStatus::Waiting => "waiting",
            HermesStatus::Stopped => "stopped",
            HermesStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleSource {
    Gateway,
    Plugin,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    DbTip,
    DbAncestor,
    RoutingDisplayName,
    Platform,
    Fallback,
}

impl TitleSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TitleSource::DbTip => "db_tip",
            TitleSource::DbAncestor => "db_ancestor",
            TitleSource::RoutingDisplayName => "routing_display_name",
            TitleSource::Platform => "platform",
            TitleSource::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HermesReducedState {
    pub turn_id: Option<String>,
    pub status: HermesStatus,
    pub active: bool,
    pub lifecycle_source: LifecycleSource,
    pub latest_timestamp: f64,
    pub user_prompt: Option<String>,
    pub last_response: Option<String>,
    pub diagnostic_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageInfo {
    pub root_session_id: String,
    pub tip_session_id: String,
    pub lineage_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalTitleResult {
    pub canonical_title: String,
    pub title_source: TitleSource,
    pub display_name: Option<String>,
    pub platform: Option<String>,
    pub resolved_session_id: String,
    pub root_session_id: String,
}

/// Helper to check if a tool name is internal Hermes housekeeping
pub fn is_hermes_internal_tool(t: &str) -> bool {
    t.starts_with("skill") || t.starts_with("memor")
}

/// Helper to check if a tool name is an interactive user choice
pub fn is_hermes_interactive_tool(t: &str) -> bool {
    matches!(t, "clarify" | "ask_user" | "confirm" | "AskUserQuestion" | "AskQuestion" | "ask_question")
}

/// Reduce a sequence of raw Hermes events for a single session into normalized lifecycle state.
///
/// Principles:
/// 1. Gateway Precedence: If a turn was opened by `GatewayAgentStart`, only `GatewayAgentEnd`
///    for that turn can close it. Plugin tool/thought events within that turn enrich activity
///    but cannot close the turn.
/// 2. Plugin Turn Boundary: For non-gateway turns, `pre_llm_call` (`UserPromptSubmit`) starts the turn,
///    and only `on_session_end` (`Stop` with matching turnId) can close it.
/// 3. `post_llm_call` (`HermesPostLlm`) updates `last_response` and keeps status `processing`.
/// 4. Stale Event Protection: Events belonging to an older turnId cannot close a newer open turn.
/// 5. No Timeout / Silence: Absence of events does NOT terminate a turn.
/// 6. Crash Recovery: Only explicit evidence of process death (`process_alive == Some(false)`)
///    can terminate an open turn without a canonical end event.
pub fn reduce_hermes_events(
    events: &[serde_json::Value],
    process_alive: Option<bool>,
) -> HermesReducedState {
    if events.is_empty() {
        return HermesReducedState {
            turn_id: None,
            status: HermesStatus::Stopped,
            active: false,
            lifecycle_source: LifecycleSource::Legacy,
            latest_timestamp: 0.0,
            user_prompt: None,
            last_response: None,
            diagnostic_reason: Some("no_events".to_string()),
        };
    }

    // Filter out internal tools
    let filtered_events: Vec<&serde_json::Value> = events
        .iter()
        .filter(|e| {
            let tool = e.get("tool").and_then(|v| v.as_str()).unwrap_or("");
            !is_hermes_internal_tool(tool)
        })
        .collect();

    let events_to_use = if filtered_events.is_empty() {
        events.iter().collect::<Vec<_>>()
    } else {
        filtered_events
    };

    // Scan latest prompt & lastResponse
    let mut user_prompt: Option<String> = None;
    let mut last_response: Option<String> = None;
    for e in events_to_use.iter().rev() {
        if user_prompt.is_none() {
            if let Some(up) = e.get("userPrompt").or_else(|| e.get("prompt")).and_then(|v| v.as_str()) {
                if !up.trim().is_empty() {
                    user_prompt = Some(up.trim().to_string());
                }
            }
        }
        if last_response.is_none() {
            if let Some(lr) = e.get("lastResponse").or_else(|| e.get("response")).and_then(|v| v.as_str()) {
                if !lr.trim().is_empty() {
                    last_response = Some(lr.trim().to_string());
                }
            }
        }
        if user_prompt.is_some() && last_response.is_some() {
            break;
        }
    }

    let latest_ts = events_to_use
        .iter()
        .filter_map(|e| e.get("timestamp").and_then(|v| v.as_f64()))
        .fold(0.0f64, f64::max);

    // Check if session uses schemaVersion >= 2
    let has_v2 = events_to_use.iter().any(|e| {
        e.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) >= 2 || e.get("turnId").is_some()
    });

    // ── Check Gateway lifecycle events ──
    let has_gateway_events = events_to_use.iter().any(|e| {
        e.get("lifecycleSource").and_then(|v| v.as_str()) == Some("gateway")
            || e.get("event").and_then(|v| v.as_str()).map(|s| s.starts_with("GatewayAgent")).unwrap_or(false)
    });

    if has_gateway_events {
        // Find latest GatewayAgentStart
        let mut last_gw_start_idx: Option<usize> = None;
        let mut last_gw_turn_id: Option<String> = None;

        for (i, e) in events_to_use.iter().enumerate() {
            let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
            if ev == "GatewayAgentStart" || (ev == "UserPromptSubmit" && e.get("lifecycleSource").and_then(|v| v.as_str()) == Some("gateway")) {
                last_gw_start_idx = Some(i);
                last_gw_turn_id = e.get("turnId").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }

        if let Some(start_idx) = last_gw_start_idx {
            let turn_id = last_gw_turn_id.clone();
            // Check if there is a matching GatewayAgentEnd after start_idx
            let end_event = events_to_use[start_idx + 1..].iter().find(|e| {
                let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
                if ev == "GatewayAgentEnd" || (ev == "Stop" && e.get("lifecycleSource").and_then(|v| v.as_str()) == Some("gateway")) {
                    if let (Some(ref t_start), Some(t_end)) = (&turn_id, e.get("turnId").and_then(|v| v.as_str())) {
                        t_start == t_end
                    } else {
                        true
                    }
                } else {
                    false
                }
            });

            if let Some(end_e) = end_event {
                let interrupted = end_e.get("interrupted").and_then(|v| v.as_bool()).unwrap_or(false);
                let claude_status = end_e.get("claudeStatus").and_then(|v| v.as_str()).unwrap_or("");
                let status = if interrupted || claude_status == "failed" {
                    HermesStatus::Failed
                } else {
                    HermesStatus::Stopped
                };
                return HermesReducedState {
                    turn_id,
                    status,
                    active: false,
                    lifecycle_source: LifecycleSource::Gateway,
                    latest_timestamp: latest_ts,
                    user_prompt,
                    last_response,
                    diagnostic_reason: Some("gateway_agent_ended".to_string()),
                };
            }

            // Gateway turn is OPEN! Check crash recovery
            if process_alive == Some(false) {
                return HermesReducedState {
                    turn_id,
                    status: HermesStatus::Failed,
                    active: false,
                    lifecycle_source: LifecycleSource::Gateway,
                    latest_timestamp: latest_ts,
                    user_prompt,
                    last_response,
                    diagnostic_reason: Some("process_dead".to_string()),
                };
            }

            // In open gateway turn, scan events after start_idx for waiting or tool_running
            let mut current_status = HermesStatus::Processing;
            for e in &events_to_use[start_idx..] {
                let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
                let tool = e.get("tool").or_else(|| e.get("tool_name")).and_then(|v| v.as_str()).unwrap_or("");
                if ev == "PermissionRequest" || (ev == "PreToolUse" && is_hermes_interactive_tool(tool)) {
                    current_status = HermesStatus::Waiting;
                } else if ev == "PreToolUse" {
                    current_status = HermesStatus::ToolRunning;
                } else if ev == "PostToolUse" || ev == "HermesPostLlm" || ev == "GatewayAgentStep" {
                    current_status = HermesStatus::Processing;
                }
            }

            return HermesReducedState {
                turn_id,
                status: current_status,
                active: true,
                lifecycle_source: LifecycleSource::Gateway,
                latest_timestamp: latest_ts,
                user_prompt,
                last_response,
                diagnostic_reason: Some("gateway_turn_open".to_string()),
            };
        }
    }

    // ── Check Plugin v2 lifecycle events ──
    if has_v2 {
        // Find latest turn start event (UserPromptSubmit)
        let mut last_start_idx: Option<usize> = None;
        let mut last_turn_id: Option<String> = None;

        for (i, e) in events_to_use.iter().enumerate() {
            let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
            if ev == "UserPromptSubmit" {
                last_start_idx = Some(i);
                last_turn_id = e.get("turnId").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }

        if let Some(start_idx) = last_start_idx {
            let turn_id = last_turn_id.clone();
            // Check if there is a matching canonical Stop / on_session_end event after start_idx
            let end_event = events_to_use[start_idx + 1..].iter().find(|e| {
                let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
                if ev == "Stop" || ev == "SessionEnd" {
                    if let (Some(ref t_start), Some(t_end)) = (&turn_id, e.get("turnId").and_then(|v| v.as_str())) {
                        t_start == t_end
                    } else if turn_id.is_none() {
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            });

            if let Some(end_e) = end_event {
                let interrupted = end_e.get("interrupted").and_then(|v| v.as_bool()).unwrap_or(false);
                let claude_status = end_e.get("claudeStatus").and_then(|v| v.as_str()).unwrap_or("");
                let status = if interrupted || claude_status == "failed" {
                    HermesStatus::Failed
                } else {
                    HermesStatus::Stopped
                };
                return HermesReducedState {
                    turn_id,
                    status,
                    active: false,
                    lifecycle_source: LifecycleSource::Plugin,
                    latest_timestamp: latest_ts,
                    user_prompt,
                    last_response,
                    diagnostic_reason: Some("canonical_session_ended".to_string()),
                };
            }

            // Plugin turn is OPEN! Check crash recovery
            if process_alive == Some(false) {
                return HermesReducedState {
                    turn_id,
                    status: HermesStatus::Failed,
                    active: false,
                    lifecycle_source: LifecycleSource::Plugin,
                    latest_timestamp: latest_ts,
                    user_prompt,
                    last_response,
                    diagnostic_reason: Some("process_dead".to_string()),
                };
            }

            // Turn is OPEN and alive: determine latest state within the turn
            let mut current_status = HermesStatus::Processing;
            for e in &events_to_use[start_idx..] {
                let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
                let tool = e.get("tool").or_else(|| e.get("tool_name")).and_then(|v| v.as_str()).unwrap_or("");
                if ev == "PermissionRequest" || (ev == "PreToolUse" && is_hermes_interactive_tool(tool)) {
                    current_status = HermesStatus::Waiting;
                } else if ev == "PreToolUse" {
                    current_status = HermesStatus::ToolRunning;
                } else if ev == "PostToolUse" || ev == "HermesPostLlm" || ev == "UserPromptSubmit" {
                    current_status = HermesStatus::Processing;
                }
            }

            return HermesReducedState {
                turn_id,
                status: current_status,
                active: true,
                lifecycle_source: LifecycleSource::Plugin,
                latest_timestamp: latest_ts,
                user_prompt,
                last_response,
                diagnostic_reason: Some("plugin_turn_open".to_string()),
            };
        }
    }

    // ── Legacy fallback (events before schemaVersion 2 without turnId) ──
    // Use strict boundary ordering: find latest explicit start vs explicit end
    let mut last_start_ts = 0.0f64;
    let mut last_end_ts = 0.0f64;
    let mut last_status = HermesStatus::Stopped;

    for e in &events_to_use {
        let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let ts = e.get("timestamp").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let tool = e.get("tool").or_else(|| e.get("tool_name")).and_then(|v| v.as_str()).unwrap_or("");

        if ev == "UserPromptSubmit" {
            if ts >= last_start_ts {
                last_start_ts = ts;
                last_status = HermesStatus::Processing;
            }
        } else if ev == "Stop" || ev == "SessionEnd" {
            if ts >= last_end_ts {
                last_end_ts = ts;
            }
        } else if ts >= last_start_ts {
            if ev == "PermissionRequest" || (ev == "PreToolUse" && is_hermes_interactive_tool(tool)) {
                last_status = HermesStatus::Waiting;
            } else if ev == "PreToolUse" {
                last_status = HermesStatus::ToolRunning;
            } else if ev == "PostToolUse" || ev == "HermesPostLlm" {
                last_status = HermesStatus::Processing;
            }
        }
    }

    if last_start_ts > last_end_ts {
        // Open legacy turn. Check crash recovery
        if process_alive == Some(false) {
            return HermesReducedState {
                turn_id: None,
                status: HermesStatus::Failed,
                active: false,
                lifecycle_source: LifecycleSource::Legacy,
                latest_timestamp: latest_ts,
                user_prompt,
                last_response,
                diagnostic_reason: Some("process_dead".to_string()),
            };
        }
        HermesReducedState {
            turn_id: None,
            status: last_status,
            active: true,
            lifecycle_source: LifecycleSource::Legacy,
            latest_timestamp: latest_ts,
            user_prompt,
            last_response,
            diagnostic_reason: Some("legacy_turn_open".to_string()),
        }
    } else {
        HermesReducedState {
            turn_id: None,
            status: HermesStatus::Stopped,
            active: false,
            lifecycle_source: LifecycleSource::Legacy,
            latest_timestamp: latest_ts,
            user_prompt,
            last_response,
            diagnostic_reason: Some("legacy_turn_closed".to_string()),
        }
    }
}

/// Capability check for table columns
fn table_has_column(db: &Connection, table: &str, col: &str) -> bool {
    let query = format!("PRAGMA table_info({})", table);
    if let Ok(mut stmt) = db.prepare(&query) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for name in rows.flatten() {
                if name.eq_ignore_ascii_case(col) {
                    return true;
                }
            }
        }
    }
    false
}

/// Resolve Hermes parent-child session lineage up to max_depth (32).
///
/// Returns `LineageInfo` containing `root_session_id`, `tip_session_id`, and ordered `lineage_ids`.
pub fn resolve_hermes_lineage(db: &Connection, sid: &str) -> Result<LineageInfo, rusqlite::Error> {
    let has_parent_col = table_has_column(db, "sessions", "parent_session_id");

    if !has_parent_col {
        return Ok(LineageInfo {
            root_session_id: sid.to_string(),
            tip_session_id: sid.to_string(),
            lineage_ids: vec![sid.to_string()],
        });
    }

    let mut ancestors = Vec::new();
    let mut visited = HashSet::new();
    visited.insert(sid.to_string());

    // 1. Traverse upwards to find root
    let mut current = sid.to_string();
    for _ in 0..32 {
        let parent: Option<String> = db
            .query_row(
                "SELECT parent_session_id FROM sessions WHERE id = ?1",
                rusqlite::params![current],
                |r| r.get(0),
            )
            .ok()
            .flatten();

        match parent {
            Some(p) if !p.is_empty() && !visited.contains(&p) => {
                visited.insert(p.clone());
                ancestors.push(p.clone());
                current = p;
            }
            _ => break,
        }
    }

    ancestors.reverse(); // Now [root, ancestor2, ancestor1]
    let root = ancestors.first().cloned().unwrap_or_else(|| sid.to_string());

    // 2. Traverse downwards from sid to tip
    let mut descendants = Vec::new();
    current = sid.to_string();
    for _ in 0..32 {
        let child: Option<String> = db
            .query_row(
                "SELECT id FROM sessions WHERE parent_session_id = ?1 ORDER BY started_at DESC LIMIT 1",
                rusqlite::params![current],
                |r| r.get(0),
            )
            .ok();

        match child {
            Some(c) if !c.is_empty() && !visited.contains(&c) => {
                visited.insert(c.clone());
                descendants.push(c.clone());
                current = c;
            }
            _ => break,
        }
    }

    let tip = descendants.last().cloned().unwrap_or_else(|| sid.to_string());

    let mut full_lineage = ancestors;
    full_lineage.push(sid.to_string());
    full_lineage.extend(descendants);

    Ok(LineageInfo {
        root_session_id: root,
        tip_session_id: tip,
        lineage_ids: full_lineage,
    })
}

/// Resolve canonical title according to strict priority:
/// 1. tip `sessions.title`
/// 2. nearest ancestor `title` along lineage upwards
/// 3. root `title`
/// 4. routing `display_name`
/// 5. formatted platform name
/// 6. `Hermes #N`
pub fn resolve_canonical_title(
    db: &Connection,
    lineage: &LineageInfo,
    routing_display_name: Option<&str>,
    platform: Option<&str>,
    seq: usize,
) -> CanonicalTitleResult {
    let has_title_col = table_has_column(db, "sessions", "title");

    let get_title = |sid: &str| -> Option<String> {
        if !has_title_col {
            return None;
        }
        db.query_row(
            "SELECT title FROM sessions WHERE id = ?1",
            rusqlite::params![sid],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .and_then(|t| {
            let tr = t.trim();
            if tr.is_empty() {
                None
            } else {
                Some(tr.to_string())
            }
        })
    };

    // 1. Tip title
    if let Some(t) = get_title(&lineage.tip_session_id) {
        return CanonicalTitleResult {
            canonical_title: t,
            title_source: TitleSource::DbTip,
            display_name: routing_display_name.map(|s| s.to_string()),
            platform: platform.map(|s| s.to_string()),
            resolved_session_id: lineage.tip_session_id.clone(),
            root_session_id: lineage.root_session_id.clone(),
        };
    }

    // 2. Nearest ancestor title (walk backwards from tip in lineage_ids)
    for sid in lineage.lineage_ids.iter().rev() {
        if sid == &lineage.tip_session_id {
            continue;
        }
        if let Some(t) = get_title(sid) {
            return CanonicalTitleResult {
                canonical_title: t,
                title_source: TitleSource::DbAncestor,
                display_name: routing_display_name.map(|s| s.to_string()),
                platform: platform.map(|s| s.to_string()),
                resolved_session_id: lineage.tip_session_id.clone(),
                root_session_id: lineage.root_session_id.clone(),
            };
        }
    }

    // 3. Root title (if not already found in lineage walk)
    if let Some(t) = get_title(&lineage.root_session_id) {
        return CanonicalTitleResult {
            canonical_title: t,
            title_source: TitleSource::DbAncestor,
            display_name: routing_display_name.map(|s| s.to_string()),
            platform: platform.map(|s| s.to_string()),
            resolved_session_id: lineage.tip_session_id.clone(),
            root_session_id: lineage.root_session_id.clone(),
        };
    }

    // 4. Routing display_name
    if let Some(disp) = routing_display_name {
        let tr = disp.trim();
        if !tr.is_empty() {
            return CanonicalTitleResult {
                canonical_title: tr.to_string(),
                title_source: TitleSource::RoutingDisplayName,
                display_name: Some(tr.to_string()),
                platform: platform.map(|s| s.to_string()),
                resolved_session_id: lineage.tip_session_id.clone(),
                root_session_id: lineage.root_session_id.clone(),
            };
        }
    }

    // 5. Formatted platform name
    if let Some(plat) = platform {
        let tr = plat.trim();
        if !tr.is_empty() && tr != "cli" && tr != "terminal" {
            let formatted = match tr.to_lowercase().as_str() {
                "telegram" => "Telegram",
                "feishu" => "Feishu",
                "discord" => "Discord",
                "slack" => "Slack",
                "whatsapp" => "WhatsApp",
                "desktop" => "Desktop",
                _ => tr,
            };
            return CanonicalTitleResult {
                canonical_title: formatted.to_string(),
                title_source: TitleSource::Platform,
                display_name: routing_display_name.map(|s| s.to_string()),
                platform: Some(tr.to_string()),
                resolved_session_id: lineage.tip_session_id.clone(),
                root_session_id: lineage.root_session_id.clone(),
            };
        }
    }

    // 6. Fallback Hermes #N
    CanonicalTitleResult {
        canonical_title: format!("Hermes #{}", seq),
        title_source: TitleSource::Fallback,
        display_name: routing_display_name.map(|s| s.to_string()),
        platform: platform.map(|s| s.to_string()),
        resolved_session_id: lineage.tip_session_id.clone(),
        root_session_id: lineage.root_session_id.clone(),
    }
}

// ── Shared Plugin & Hook Code Generators ──

pub fn build_hermes_plugin_yaml() -> &'static str {
    r#"name: ooclaw
version: 0.3.0
description: "Forward Hermes Agent lifecycle events to oc-claw (local socket + status file)."
hooks:
  - on_session_start
  - pre_llm_call
  - post_llm_call
  - pre_tool_call
  - post_tool_call
  - on_session_end
  - on_session_finalize
  - on_session_reset
  - pre_approval_request
  - post_approval_response
"#
}

pub fn build_hermes_plugin_source(connect_code: &str) -> String {
    format!(
        r##"# ooclaw plugin for Hermes Agent v{version}
from __future__ import annotations
import json, os, socket, time, threading
from typing import Any, Dict, Tuple
from pathlib import Path

SCHEMA_VERSION = {schema_version}
PLUGIN_VERSION = "{version}"

{connect_code}

# Track the last session_id and active turn_id per thread/session
_thread_local = threading.local()
_turn_lock = threading.Lock()
_active_turns: Dict[str, str] = {{}}  # session_id -> turn_id

def _status_file_path():
    """Find the ooclaw status file path under active profile or hermes home."""
    hermes_home = os.environ.get("HERMES_HOME", "") or os.path.expanduser("~/.hermes")
    profile = os.environ.get("HERMES_PROFILE", "")
    if profile:
        return os.path.join(hermes_home, "profiles", profile, "ooclaw-status.json")
    return os.path.join(hermes_home, "ooclaw-status.json")

_MAX_EVENTS_PER_SESSION = 100
_MAX_SESSIONS = 20

def _write_status(payload):
    try:
        status_path = _status_file_path()
        session_id = payload.get("sessionId", "unknown")
        data = {{}}
        if os.path.exists(status_path):
            try:
                with open(status_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    data = {{}}
            except Exception:
                data = {{}}
        if session_id not in data:
            data[session_id] = []
        data[session_id].append(payload)
        if len(data[session_id]) > _MAX_EVENTS_PER_SESSION:
            data[session_id] = data[session_id][-_MAX_EVENTS_PER_SESSION:]
        if len(data) > _MAX_SESSIONS:
            by_ts = sorted(data.items(), key=lambda kv: (kv[1][-1].get("timestamp", 0) if kv[1] else 0), reverse=True)
            data = dict(by_ts[:_MAX_SESSIONS])
        tmp_path = status_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, status_path)
    except Exception:
        pass

def _is_internal_tool(t):
    return t.startswith("skill") or t.startswith("memor")

_INTERACTIVE_TOOLS = ("clarify", "ask_user", "confirm", "AskUserQuestion", "AskQuestion", "ask_question")
def _is_interactive(t):
    return t in _INTERACTIVE_TOOLS

def _handle(event_name, **kwargs):
    session_id = kwargs.get("session_id", "") or kwargs.get("conversation_id", "")
    if not session_id:
        session_id = getattr(_thread_local, "last_session_id", "") or ""
    if not session_id:
        return

    platform = kwargs.get("platform", "") or ""
    try:
        cwd = os.getcwd()
    except Exception:
        cwd = os.path.expanduser("~/.hermes")
    if not cwd:
        cwd = os.path.expanduser("~/.hermes")

    # Rollover check
    last_sid = getattr(_thread_local, "last_session_id", "")
    if last_sid and last_sid != session_id:
        with _turn_lock:
            old_turn = _active_turns.pop(last_sid, "")
        end_payload = {{
            "sessionId": last_sid,
            "turnId": old_turn,
            "cwd": cwd,
            "event": "SessionEnd",
            "claudeStatus": "ended",
            "source": "hermes",
            "lifecycleSource": "plugin",
            "schemaVersion": SCHEMA_VERSION,
            "pid": os.getpid(),
            "platform": platform,
            "timestamp": time.time(),
        }}
        _send(end_payload)
        _write_status(end_payload)
    _thread_local.last_session_id = session_id

    # Resolve or create turn_id
    raw_turn = kwargs.get("turn_id", "")
    if event_name == "pre_llm_call":
        turn_id = raw_turn or f"{{session_id}}_{{int(time.time()*1000)}}_{{os.getpid()}}"
        with _turn_lock:
            _active_turns[session_id] = turn_id
    else:
        with _turn_lock:
            turn_id = raw_turn or _active_turns.get(session_id, "")

    tool_name = ""
    if event_name in ("pre_tool_call", "post_tool_call", "pre_approval_request"):
        tool_name = kwargs.get("tool_name", "") or kwargs.get("tool", "") or ""
        if tool_name and _is_internal_tool(tool_name):
            return

    # Lifecycle mapping
    cc_event = ""
    claude_status = ""
    extra = {{}}

    if event_name == "on_session_start":
        cc_event = "SessionStart"
        claude_status = "waiting_for_input"
    elif event_name == "pre_llm_call":
        cc_event = "UserPromptSubmit"
        claude_status = "processing"
        prompt = kwargs.get("user_message", "") or kwargs.get("prompt", "") or kwargs.get("message", "")
        if prompt and isinstance(prompt, str):
            if "[CONTEXT COMPACTION" in prompt[:30]:
                marker = "--- END OF CONTEXT SUMMARY"
                idx = prompt.find(marker)
                if idx != -1:
                    prompt = prompt[idx + len(marker):].strip().lstrip("-").strip()
            if prompt:
                extra["userPrompt"] = prompt[:500]
    elif event_name == "pre_tool_call":
        cc_event = "PreToolUse"
        claude_status = "waiting" if _is_interactive(tool_name) else "running_tool"
        if tool_name:
            extra["tool"] = tool_name
    elif event_name == "post_tool_call":
        cc_event = "PostToolUse"
        claude_status = "processing"
        if tool_name:
            extra["tool"] = tool_name
    elif event_name == "post_llm_call":
        # ABSOLUTELY NEVER EMIT Stop HERE
        cc_event = "HermesPostLlm"
        claude_status = "processing"
        resp = kwargs.get("assistant_response", "") or kwargs.get("response", "") or kwargs.get("result", "")
        if isinstance(resp, dict):
            resp = resp.get("content", "") or resp.get("text", "")
        if resp and isinstance(resp, str):
            extra["lastResponse"] = resp[:2000]
    elif event_name == "pre_approval_request":
        cc_event = "PermissionRequest"
        claude_status = "waiting"
    elif event_name == "post_approval_response":
        cc_event = "PostToolUse"
        claude_status = "processing"
    elif event_name == "on_session_end":
        cc_event = "Stop"
        failed = kwargs.get("failed", False) or kwargs.get("interrupted", False)
        claude_status = "failed" if failed else "waiting_for_input"
        if failed:
            extra["interrupted"] = True
        with _turn_lock:
            _active_turns.pop(session_id, None)
    elif event_name == "on_session_finalize":
        cc_event = "SessionEnd"
        claude_status = "ended"
        with _turn_lock:
            _active_turns.pop(session_id, None)
    elif event_name == "on_session_reset":
        cc_event = "SessionStart"
        claude_status = "waiting_for_input"
        with _turn_lock:
            _active_turns.pop(session_id, None)
    else:
        return

    payload = {{
        "sessionId": session_id,
        "turnId": turn_id,
        "cwd": cwd,
        "event": cc_event,
        "claudeStatus": claude_status,
        "source": "hermes",
        "lifecycleSource": "plugin",
        "schemaVersion": SCHEMA_VERSION,
        "pid": os.getpid(),
        "platform": platform,
        "timestamp": time.time(),
    }}
    payload.update(extra)

    _send(payload)
    _write_status(payload)

def _make_cb(event_name):
    def cb(**kwargs):
        try:
            _handle(event_name, **kwargs)
        except Exception:
            pass
        return None
    cb.__name__ = "ooclaw_" + event_name
    return cb

def register(ctx):
    for hook_name in (
        "on_session_start", "pre_llm_call", "post_llm_call",
        "pre_tool_call", "post_tool_call", "on_session_end",
        "on_session_finalize", "on_session_reset",
        "pre_approval_request", "post_approval_response"
    ):
        ctx.register_hook(hook_name, _make_cb(hook_name))
"##,
        version = HERMES_PLUGIN_VERSION,
        schema_version = HERMES_SCHEMA_VERSION,
        connect_code = connect_code
    )
}

pub fn build_hermes_gateway_hook_yaml() -> &'static str {
    r#"name: ooclaw
description: Forward Hermes gateway events to oc-claw desktop pet
events:
  - session:start
  - agent:start
  - agent:step
  - agent:end
  - session:end
  - session:reset
"#
}

pub fn build_hermes_gateway_hook_source(connect_code: &str) -> String {
    format!(
        r##""""
Gateway hook handler for oc-claw integration v{version}.
Forwards Hermes gateway lifecycle events to oc-claw via socket + status file.
"""
import json, os, socket, sys, datetime, time, threading

SCHEMA_VERSION = {schema_version}
LOG_DIR = os.path.expanduser("~/.hermes/logs")
LOG_FILE = os.path.join(LOG_DIR, "ooclaw-hook.log")

def _log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().isoformat()
        with open(LOG_FILE, "a") as f:
            f.write(f"[{{ts}}] {{msg}}\n")
    except Exception:
        pass

{connect_code}

def _status_file_path():
    hermes_home = os.environ.get("HERMES_HOME", "") or os.path.expanduser("~/.hermes")
    profile = os.environ.get("HERMES_PROFILE", "")
    if profile:
        return os.path.join(hermes_home, "profiles", profile, "ooclaw-status.json")
    return os.path.join(hermes_home, "ooclaw-status.json")

_MAX_EVENTS_PER_SESSION = 50
_MAX_SESSIONS = 20

def _write_status(payload):
    try:
        status_path = _status_file_path()
        session_id = payload.get("sessionId", "unknown")
        data = {{}}
        if os.path.exists(status_path):
            try:
                with open(status_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    data = {{}}
            except Exception:
                data = {{}}
        if session_id not in data:
            data[session_id] = []
        data[session_id].append(payload)
        if len(data[session_id]) > _MAX_EVENTS_PER_SESSION:
            data[session_id] = data[session_id][-_MAX_EVENTS_PER_SESSION:]
        if len(data) > _MAX_SESSIONS:
            by_ts = sorted(data.items(), key=lambda kv: (kv[1][-1].get("timestamp", 0) if kv[1] else 0), reverse=True)
            data = dict(by_ts[:_MAX_SESSIONS])
        tmp_path = status_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, status_path)
    except Exception:
        pass

_gw_turn_lock = threading.Lock()
_active_gw_turns = {{}}  # session_id -> turn_id

def handle(event_type, context):
    try:
        platform = context.get("platform", "")
        user_id = context.get("user_id", "")
        session_id = context.get("session_id", "")
        if not session_id:
            session_id = f"gw_{{platform}}_{{user_id}}" if user_id else f"gw_{{platform}}"

        raw_turn = context.get("turn_id", "")
        if event_type == "agent:start":
            turn_id = raw_turn or f"gw_{{session_id}}_{{int(time.time()*1000)}}"
            with _gw_turn_lock:
                _active_gw_turns[session_id] = turn_id
        else:
            with _gw_turn_lock:
                turn_id = raw_turn or _active_gw_turns.get(session_id, "")

        oc_event = ""
        claude_status = ""
        extra = {{}}

        if event_type == "session:start":
            oc_event = "SessionStart"
            claude_status = "waiting_for_input"
        elif event_type == "agent:start":
            oc_event = "GatewayAgentStart"
            claude_status = "processing"
            msg = context.get("message", "")
            if msg:
                extra["userPrompt"] = msg[:500]
        elif event_type == "agent:step":
            oc_event = "GatewayAgentStep"
            claude_status = "processing"
            tool = context.get("tool", "") or context.get("tool_name", "")
            if tool:
                extra["tool"] = tool
        elif event_type == "agent:end":
            oc_event = "GatewayAgentEnd"
            claude_status = "waiting_for_input"
            resp = context.get("response", "")
            if resp:
                extra["lastResponse"] = resp[:2000]
            with _gw_turn_lock:
                _active_gw_turns.pop(session_id, None)
        elif event_type == "session:end":
            oc_event = "Stop"
            claude_status = "waiting_for_input"
            with _gw_turn_lock:
                _active_gw_turns.pop(session_id, None)
        elif event_type == "session:reset":
            oc_event = "SessionStart"
            claude_status = "waiting_for_input"
            with _gw_turn_lock:
                _active_gw_turns.pop(session_id, None)
        else:
            return

        payload = {{
            "sessionId": session_id,
            "turnId": turn_id,
            "cwd": os.path.expanduser("~/.hermes"),
            "event": oc_event,
            "claudeStatus": claude_status,
            "source": "hermes",
            "lifecycleSource": "gateway",
            "schemaVersion": SCHEMA_VERSION,
            "pid": os.getpid(),
            "platform": platform or "gateway",
            "timestamp": time.time(),
        }}
        payload.update(extra)
        _send_to_ooclaw(payload)
        _write_status(payload)
    except Exception as e:
        _log(f"handler exception: {{e}}")
"##,
        version = HERMES_PLUGIN_VERSION,
        schema_version = HERMES_SCHEMA_VERSION,
        connect_code = connect_code
    )
}

/// Remote Python canonical session collector script.
/// Implements unified metadata gathering from state.db with PRAGMA table_info capability checks,
/// routing enrichment from sessions.json, lineage resolution up to 32 steps, strict title priority,
/// and turnId-based status reduction without wall-clock timeouts or DB completion heuristics.
pub fn build_hermes_remote_collector_script() -> &'static str {
    r#"
import json, os, time, sys

now = time.time()
hermes_home = os.path.expanduser('~/.hermes')
profile_dirs = [hermes_home]
profiles_root = os.path.join(hermes_home, 'profiles')
if os.path.isdir(profiles_root):
    for name in os.listdir(profiles_root):
        p = os.path.join(profiles_root, name)
        if os.path.isdir(p):
            profile_dirs.append(p)

_INTERACTIVE_TOOLS = ('clarify', 'ask_user', 'confirm', 'AskUserQuestion', 'AskQuestion', 'ask_question')
def is_interactive(t):
    return t in _INTERACTIVE_TOOLS

def is_internal(t):
    return t.startswith('skill') or t.startswith('memor')

def is_pid_alive(pid):
    if not pid or pid <= 0:
        return None
    # Check /proc/<pid> on Linux
    proc_path = f"/proc/{pid}"
    if os.path.exists(proc_path):
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return None

def reduce_events(events, pid_alive):
    if not events:
        return {'status': 'stopped', 'active': False, 'turnId': '', 'lifecycleSource': 'legacy'}

    filtered = [e for e in events if not is_internal(e.get('tool', ''))]
    evts = filtered if filtered else events

    has_gw = any(e.get('lifecycleSource') == 'gateway' or e.get('event', '').startswith('GatewayAgent') for e in evts)
    if has_gw:
        last_start_idx = None
        last_turn_id = ''
        for i, e in enumerate(evts):
            ev = e.get('event', '')
            if ev == 'GatewayAgentStart' or (ev == 'UserPromptSubmit' and e.get('lifecycleSource') == 'gateway'):
                last_start_idx = i
                last_turn_id = e.get('turnId', '')
        if last_start_idx is not None:
            # Look for matching GatewayAgentEnd
            end_evt = None
            for e in evts[last_start_idx + 1:]:
                ev = e.get('event', '')
                if ev == 'GatewayAgentEnd' or (ev == 'Stop' and e.get('lifecycleSource') == 'gateway'):
                    if not last_turn_id or e.get('turnId') == last_turn_id:
                        end_evt = e
                        break
            if end_evt:
                is_failed = end_evt.get('interrupted', False) or end_evt.get('claudeStatus') == 'failed'
                return {'status': 'failed' if is_failed else 'stopped', 'active': False, 'turnId': last_turn_id, 'lifecycleSource': 'gateway'}

            if pid_alive is False:
                return {'status': 'failed', 'active': False, 'turnId': last_turn_id, 'lifecycleSource': 'gateway', 'reason': 'process_dead'}

            cur_st = 'processing'
            for e in evts[last_start_idx:]:
                ev = e.get('event', '')
                tool = e.get('tool', '')
                if ev == 'PermissionRequest' or (ev == 'PreToolUse' and is_interactive(tool)):
                    cur_st = 'waiting'
                elif ev == 'PreToolUse':
                    cur_st = 'tool_running'
                elif ev in ('PostToolUse', 'HermesPostLlm', 'GatewayAgentStep'):
                    cur_st = 'processing'
            return {'status': cur_st, 'active': True, 'turnId': last_turn_id, 'lifecycleSource': 'gateway'}

    # Plugin v2 check
    has_v2 = any(e.get('schemaVersion', 0) >= 2 or 'turnId' in e for e in evts)
    if has_v2:
        last_start_idx = None
        last_turn_id = ''
        for i, e in enumerate(evts):
            if e.get('event') == 'UserPromptSubmit':
                last_start_idx = i
                last_turn_id = e.get('turnId', '')
        if last_start_idx is not None:
            end_evt = None
            for e in evts[last_start_idx + 1:]:
                if e.get('event') in ('Stop', 'SessionEnd'):
                    if not last_turn_id or e.get('turnId') == last_turn_id:
                        end_evt = e
                        break
            if end_evt:
                is_failed = end_evt.get('interrupted', False) or end_evt.get('claudeStatus') == 'failed'
                return {'status': 'failed' if is_failed else 'stopped', 'active': False, 'turnId': last_turn_id, 'lifecycleSource': 'plugin'}

            if pid_alive is False:
                return {'status': 'failed', 'active': False, 'turnId': last_turn_id, 'lifecycleSource': 'plugin', 'reason': 'process_dead'}

            cur_st = 'processing'
            for e in evts[last_start_idx:]:
                ev = e.get('event', '')
                tool = e.get('tool', '')
                if ev == 'PermissionRequest' or (ev == 'PreToolUse' and is_interactive(tool)):
                    cur_st = 'waiting'
                elif ev == 'PreToolUse':
                    cur_st = 'tool_running'
                elif ev in ('PostToolUse', 'HermesPostLlm', 'UserPromptSubmit'):
                    cur_st = 'processing'
            return {'status': cur_st, 'active': True, 'turnId': last_turn_id, 'lifecycleSource': 'plugin'}

    # Legacy boundary check
    last_start_ts = 0.0
    last_end_ts = 0.0
    cur_st = 'stopped'
    for e in evts:
        ev = e.get('event', '')
        ts = e.get('timestamp', 0) or 0.0
        tool = e.get('tool', '')
        if ev == 'UserPromptSubmit':
            if ts >= last_start_ts:
                last_start_ts = ts
                cur_st = 'processing'
        elif ev in ('Stop', 'SessionEnd'):
            if ts >= last_end_ts:
                last_end_ts = ts
        elif ts >= last_start_ts:
            if ev == 'PermissionRequest' or (ev == 'PreToolUse' and is_interactive(tool)):
                cur_st = 'waiting'
            elif ev == 'PreToolUse':
                cur_st = 'tool_running'
            elif ev in ('PostToolUse', 'HermesPostLlm'):
                cur_st = 'processing'

    if last_start_ts > last_end_ts:
        if pid_alive is False:
            return {'status': 'failed', 'active': False, 'turnId': '', 'lifecycleSource': 'legacy', 'reason': 'process_dead'}
        return {'status': cur_st, 'active': True, 'turnId': '', 'lifecycleSource': 'legacy'}
    return {'status': 'stopped', 'active': False, 'turnId': '', 'lifecycleSource': 'legacy'}

def table_columns(conn, table):
    try:
        cur = conn.execute(f"PRAGMA table_info({table})")
        return [r[1].lower() for r in cur.fetchall()]
    except Exception:
        return []

def resolve_lineage(conn, sid, has_parent_col):
    if not has_parent_col:
        return sid, sid, [sid]

    ancestors = []
    visited = {sid}
    curr = sid
    for _ in range(32):
        try:
            r = conn.execute("SELECT parent_session_id FROM sessions WHERE id=?", (curr,)).fetchone()
            if r and r[0] and r[0] not in visited:
                visited.add(r[0])
                ancestors.append(r[0])
                curr = r[0]
            else:
                break
        except Exception:
            break
    ancestors.reverse()
    root = ancestors[0] if ancestors else sid

    descendants = []
    curr = sid
    for _ in range(32):
        try:
            r = conn.execute("SELECT id FROM sessions WHERE parent_session_id=? ORDER BY started_at DESC LIMIT 1", (curr,)).fetchone()
            if r and r[0] and r[0] not in visited:
                visited.add(r[0])
                descendants.append(r[0])
                curr = r[0]
            else:
                break
        except Exception:
            break
    tip = descendants[-1] if descendants else sid

    lineage = ancestors + [sid] + descendants
    return root, tip, lineage

def resolve_title(conn, lineage, routing_disp, platform, seq, has_title_col):
    def get_t(s):
        if not has_title_col:
            return None
        try:
            r = conn.execute("SELECT title FROM sessions WHERE id=?", (s,)).fetchone()
            if r and r[0] and r[0].strip():
                return r[0].strip()
        except Exception:
            pass
        return None

    root_id, tip_id, ids = lineage

    # 1. Tip title
    t = get_t(tip_id)
    if t:
        return t, 'db_tip'

    # 2. Nearest ancestor title
    for s in reversed(ids):
        if s == tip_id:
            continue
        t = get_t(s)
        if t:
            return t, 'db_ancestor'

    # 3. Root title
    t = get_t(root_id)
    if t:
        return t, 'db_ancestor'

    # 4. Routing display name
    if routing_disp and routing_disp.strip():
        return routing_disp.strip(), 'routing_display_name'

    # 5. Formatted platform
    if platform and platform.strip() and platform not in ('cli', 'terminal'):
        p_map = {'telegram': 'Telegram', 'feishu': 'Feishu', 'discord': 'Discord', 'slack': 'Slack', 'desktop': 'Desktop'}
        return p_map.get(platform.lower(), platform), 'platform'

    # 6. Fallback
    return f"Hermes #{seq}", 'fallback'

all_results = []
seq_counter = 1

for pdir in profile_dirs:
    pname = os.path.basename(pdir) if pdir != hermes_home else 'default'
    pfx = '' if pname == 'default' else f"{pname}:"

    # Step 1: Read ooclaw-status.json
    sf = os.path.join(pdir, 'ooclaw-status.json')
    if not os.path.exists(sf) and pname == 'default':
        sf = os.path.join(hermes_home, 'ooclaw-status.json')

    status_data = {}
    if os.path.exists(sf):
        try:
            with open(sf, 'r', encoding='utf-8') as f:
                d = json.load(f)
                if isinstance(d, dict):
                    status_data = d
        except Exception:
            pass

    # Step 2: Read sessions.json as routing index only
    routing_map = {}
    sj = os.path.join(pdir, 'sessions', 'sessions.json')
    if os.path.exists(sj):
        try:
            with open(sj, 'r', encoding='utf-8') as f:
                sjd = json.load(f)
                if isinstance(sjd, dict):
                    for k, v in sjd.items():
                        if not isinstance(v, dict):
                            continue
                        sid = v.get('session_id', '')
                        if sid:
                            routing_map[sid] = {
                                'platform': v.get('platform', ''),
                                'displayName': v.get('display_name', ''),
                                'updatedAt': v.get('updated_at', ''),
                            }
        except Exception:
            pass

    # Gather all candidate session IDs: those in status_data, or routing_map
    candidate_sids = list(status_data.keys())

    if not candidate_sids:
        continue

    # Connect to state.db
    db_path = os.path.join(pdir, 'state.db')
    conn = None
    cols = []
    if os.path.exists(db_path):
        try:
            import sqlite3
            conn = sqlite3.connect(db_path)
            cols = table_columns(conn, 'sessions')
        except Exception:
            pass

    has_title_col = 'title' in cols
    has_parent_col = 'parent_session_id' in cols

    seen_lineage_roots = set()

    for sid in candidate_sids:
        evts = status_data.get(sid, [])
        if not evts:
            continue

        # Skip subagent-only sessions
        if all(e.get('event') == 'SubagentStop' for e in evts):
            continue

        pid = None
        for e in reversed(evts):
            if e.get('pid'):
                pid = e['pid']
                break

        pid_alive = is_pid_alive(pid)
        reduced = reduce_events(evts, pid_alive)

        # Resolve lineage
        root_id, tip_id, lineage_ids = sid, sid, [sid]
        if conn:
            root_id, tip_id, lineage_ids = resolve_lineage(conn, sid, has_parent_col)

        # Deduplicate logical sessions by root_id
        logical_key = pfx + root_id
        if logical_key in seen_lineage_roots:
            continue
        seen_lineage_roots.add(logical_key)

        # Scan text from events
        user_prompt = ''
        last_response = ''
        for e in reversed(evts):
            if not user_prompt and e.get('userPrompt'):
                user_prompt = e['userPrompt']
            if not last_response and e.get('lastResponse'):
                last_response = e['lastResponse']
            if user_prompt and last_response:
                break

        # DB enrichment for messages & model/source
        db_model = ''
        db_source = ''
        db_last_ts = 0.0
        if conn:
            try:
                # Query newest row in lineage for model & source
                r = conn.execute("SELECT model, source, started_at FROM sessions WHERE id=?", (tip_id,)).fetchone()
                if not r:
                    r = conn.execute("SELECT model, source, started_at FROM sessions WHERE id=?", (sid,)).fetchone()
                if r:
                    db_model = r[0] or ''
                    db_source = r[1] or ''
                    if r[2]: db_last_ts = float(r[2])
            except Exception:
                pass

            try:
                # User prompt from DB if missing
                if not user_prompt:
                    ur = conn.execute("SELECT substr(content,1,200) FROM messages WHERE session_id=? AND role='user' ORDER BY timestamp DESC LIMIT 1", (tip_id,)).fetchone()
                    if ur and ur[0]: user_prompt = ur[0]
                # Last response from DB if missing
                if not last_response:
                    ar = conn.execute("SELECT substr(content,1,200) FROM messages WHERE session_id=? AND role='assistant' AND content IS NOT NULL AND content <> '' ORDER BY timestamp DESC LIMIT 1", (tip_id,)).fetchone()
                    if ar and ar[0]: last_response = ar[0]
                # Latest message timestamp
                mr = conn.execute("SELECT MAX(timestamp) FROM messages WHERE session_id=? AND role NOT IN ('session_meta','system','metadata')", (tip_id,)).fetchone()
                if mr and mr[0] and float(mr[0]) > db_last_ts:
                    db_last_ts = float(mr[0])
            except Exception:
                pass

        # Merge routing metadata
        r_meta = routing_map.get(sid) or routing_map.get(root_id) or {}
        routing_disp = r_meta.get('displayName', '')
        plat = r_meta.get('platform') or db_source or 'desktop'

        # Resolve canonical title
        canonical_title, title_source = resolve_title(conn, (root_id, tip_id, lineage_ids), routing_disp, plat, seq_counter, has_title_col)
        seq_counter += 1

        # Calculate max timestamp
        evt_max = max((e.get('timestamp', 0) or 0) for e in evts)
        started_at = evt_max if evt_max > db_last_ts else (db_last_ts or now)

        plat_label = plat
        if pname != 'default':
            plat_label = f"{pname}/{plat}" if plat else pname

        all_results.append({
            'sessionId': pfx + sid,
            'rootSessionId': pfx + root_id,
            'resolvedSessionId': pfx + tip_id,
            'turnId': reduced.get('turnId', ''),
            'status': reduced['status'],
            'active': reduced['active'],
            'lifecycleSource': reduced.get('lifecycleSource', 'plugin'),
            'platform': plat_label,
            'title': canonical_title,
            'customTitle': canonical_title,
            'titleSource': title_source,
            'displayName': routing_disp,
            'model': db_model,
            'startedAt': started_at,
            'userPrompt': user_prompt,
            'lastResponse': last_response,
            'source': 'hermes',
            'ooclaw': evts
        })

    if conn:
        try: conn.close()
        except Exception: pass

print(json.dumps(all_results))
"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Lifecycle Test Cases (Cases 1 - 11) ──

    #[test]
    fn test_case_1_long_reasoning_silence_stays_processing() {
        // UserPromptSubmit 10 minutes ago, no subsequent events
        let now = 10000.0;
        let events = vec![json!({
            "sessionId": "s1",
            "turnId": "turn_A",
            "event": "UserPromptSubmit",
            "claudeStatus": "processing",
            "lifecycleSource": "plugin",
            "schemaVersion": 2,
            "timestamp": now - 600.0,
            "userPrompt": "Solve this complex theorem"
        })];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Processing);
        assert!(state.active);
        assert_eq!(state.turn_id.as_deref(), Some("turn_A"));
    }

    #[test]
    fn test_case_2_db_assistant_row_while_live_stays_processing() {
        // Even if assistant row exists in DB (which might be partial or previous),
        // silence/time does not terminate an open turn.
        let events = vec![json!({
            "sessionId": "s2",
            "turnId": "turn_A",
            "event": "UserPromptSubmit",
            "claudeStatus": "processing",
            "lifecycleSource": "plugin",
            "schemaVersion": 2,
            "timestamp": 100.0,
        })];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Processing);
        assert!(state.active);
    }

    #[test]
    fn test_case_3_normal_tool_loop_transitions() {
        let events = vec![
            json!({
                "sessionId": "s3",
                "turnId": "turn_A",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s3",
                "turnId": "turn_A",
                "event": "PreToolUse",
                "claudeStatus": "running_tool",
                "tool": "bash",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 101.0,
            }),
        ];

        let state1 = reduce_hermes_events(&events, Some(true));
        assert_eq!(state1.status, HermesStatus::ToolRunning);
        assert!(state1.active);

        let mut events2 = events.clone();
        events2.push(json!({
            "sessionId": "s3",
            "turnId": "turn_A",
            "event": "PostToolUse",
            "claudeStatus": "processing",
            "tool": "bash",
            "lifecycleSource": "plugin",
            "schemaVersion": 2,
            "timestamp": 102.0,
        }));

        let state2 = reduce_hermes_events(&events2, Some(true));
        assert_eq!(state2.status, HermesStatus::Processing);
        assert!(state2.active);
    }

    #[test]
    fn test_case_4_post_llm_call_stays_processing() {
        let events = vec![
            json!({
                "sessionId": "s4",
                "turnId": "turn_A",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s4",
                "turnId": "turn_A",
                "event": "HermesPostLlm",
                "claudeStatus": "processing",
                "lastResponse": "Thinking step 1 done...",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 105.0,
            }),
        ];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Processing);
        assert!(state.active);
        assert_eq!(state.last_response.as_deref(), Some("Thinking step 1 done..."));
    }

    #[test]
    fn test_case_5_canonical_end_completed() {
        let events = vec![
            json!({
                "sessionId": "s5",
                "turnId": "turn_A",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s5",
                "turnId": "turn_A",
                "event": "Stop",
                "claudeStatus": "waiting_for_input",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 110.0,
            }),
        ];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Stopped);
        assert!(!state.active);
    }

    #[test]
    fn test_case_6_interrupted_failed() {
        let events = vec![
            json!({
                "sessionId": "s6",
                "turnId": "turn_A",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s6",
                "turnId": "turn_A",
                "event": "Stop",
                "claudeStatus": "failed",
                "interrupted": true,
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 105.0,
            }),
        ];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Failed);
        assert!(!state.active);
    }

    #[test]
    fn test_case_7_stale_previous_turn_end_does_not_close_new_turn() {
        let events = vec![
            json!({
                "sessionId": "s7",
                "turnId": "turn_A",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s7",
                "turnId": "turn_A",
                "event": "Stop",
                "claudeStatus": "waiting_for_input",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 110.0,
            }),
            json!({
                "sessionId": "s7",
                "turnId": "turn_B",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 120.0,
            }),
            // Stale Stop for turn_A arrives late (e.g. out-of-order log flush)
            json!({
                "sessionId": "s7",
                "turnId": "turn_A",
                "event": "Stop",
                "claudeStatus": "waiting_for_input",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 125.0,
            }),
        ];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Processing);
        assert!(state.active);
        assert_eq!(state.turn_id.as_deref(), Some("turn_B"));
    }

    #[test]
    fn test_case_8_gateway_agent_lifecycle() {
        let events = vec![
            json!({
                "sessionId": "gw_tg",
                "turnId": "gw_turn_1",
                "event": "GatewayAgentStart",
                "claudeStatus": "processing",
                "lifecycleSource": "gateway",
                "schemaVersion": 2,
                "timestamp": 100.0,
                "userPrompt": "Hello from telegram",
            }),
            json!({
                "sessionId": "gw_tg",
                "turnId": "gw_turn_1",
                "event": "GatewayAgentStep",
                "claudeStatus": "processing",
                "lifecycleSource": "gateway",
                "schemaVersion": 2,
                "timestamp": 102.0,
            }),
            json!({
                "sessionId": "gw_tg",
                "turnId": "gw_turn_1",
                "event": "PreToolUse",
                "claudeStatus": "running_tool",
                "tool": "web_search",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 103.0,
            }),
        ];

        let state1 = reduce_hermes_events(&events, Some(true));
        assert_eq!(state1.status, HermesStatus::ToolRunning);
        assert!(state1.active);
        assert_eq!(state1.turn_id.as_deref(), Some("gw_turn_1"));

        let mut events2 = events.clone();
        events2.push(json!({
            "sessionId": "gw_tg",
            "turnId": "gw_turn_1",
            "event": "GatewayAgentEnd",
            "claudeStatus": "waiting_for_input",
            "lastResponse": "Final answer",
            "lifecycleSource": "gateway",
            "schemaVersion": 2,
            "timestamp": 110.0,
        }));

        let state2 = reduce_hermes_events(&events2, Some(true));
        assert_eq!(state2.status, HermesStatus::Stopped);
        assert!(!state2.active);
        assert_eq!(state2.last_response.as_deref(), Some("Final answer"));
    }

    #[test]
    fn test_case_9_gateway_and_plugin_conflict_precedence() {
        // Gateway agent is running, and plugin emits HermesPostLlm
        let events = vec![
            json!({
                "sessionId": "gw_feishu",
                "turnId": "gw_turn_2",
                "event": "GatewayAgentStart",
                "claudeStatus": "processing",
                "lifecycleSource": "gateway",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "gw_feishu",
                "turnId": "gw_turn_2",
                "event": "HermesPostLlm",
                "claudeStatus": "processing",
                "lastResponse": "Intermediate model text",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 105.0,
            }),
        ];

        let state = reduce_hermes_events(&events, Some(true));
        assert_eq!(state.status, HermesStatus::Processing);
        assert!(state.active);
        assert_eq!(state.lifecycle_source, LifecycleSource::Gateway);
    }

    #[test]
    fn test_case_10_approval_waiting_and_resume() {
        let events = vec![
            json!({
                "sessionId": "s10",
                "turnId": "turn_X",
                "event": "UserPromptSubmit",
                "claudeStatus": "processing",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 100.0,
            }),
            json!({
                "sessionId": "s10",
                "turnId": "turn_X",
                "event": "PermissionRequest",
                "claudeStatus": "waiting",
                "lifecycleSource": "plugin",
                "schemaVersion": 2,
                "timestamp": 102.0,
            }),
        ];

        let state_waiting = reduce_hermes_events(&events, Some(true));
        assert_eq!(state_waiting.status, HermesStatus::Waiting);
        assert!(state_waiting.active);
        assert_eq!(state_waiting.turn_id.as_deref(), Some("turn_X"));

        let mut events_resumed = events.clone();
        events_resumed.push(json!({
            "sessionId": "s10",
            "turnId": "turn_X",
            "event": "PostToolUse",
            "claudeStatus": "processing",
            "lifecycleSource": "plugin",
            "schemaVersion": 2,
            "timestamp": 105.0,
        }));

        let state_resumed = reduce_hermes_events(&events_resumed, Some(true));
        assert_eq!(state_resumed.status, HermesStatus::Processing);
        assert!(state_resumed.active);
        assert_eq!(state_resumed.turn_id.as_deref(), Some("turn_X"));
    }

    #[test]
    fn test_case_11_crash_recovery_pid_dead() {
        let events = vec![json!({
            "sessionId": "s11",
            "turnId": "turn_dead",
            "event": "UserPromptSubmit",
            "claudeStatus": "processing",
            "pid": 999999,
            "lifecycleSource": "plugin",
            "schemaVersion": 2,
            "timestamp": 100.0,
        })];

        // Explicit evidence of process death
        let state = reduce_hermes_events(&events, Some(false));
        assert_eq!(state.status, HermesStatus::Failed);
        assert!(!state.active);
        assert_eq!(state.diagnostic_reason.as_deref(), Some("process_dead"));
    }

    // ── Title Test Cases (Cases 1 - 7) ──

    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT,
                title TEXT,
                source TEXT,
                started_at REAL,
                ended_at REAL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_title_1_state_db_title_never_fallback_to_desktop() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, title, source) VALUES (?1, ?2, ?3)",
            rusqlite::params!["sid1", "Fix Hermes remote lifecycle", "desktop"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "sid1").unwrap();
        let res = resolve_canonical_title(&conn, &lineage, None, Some("desktop"), 1);

        assert_eq!(res.canonical_title, "Fix Hermes remote lifecycle");
        assert_eq!(res.title_source, TitleSource::DbTip);
    }

    #[test]
    fn test_title_2_telegram_routing_no_title_uses_state_db() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, title, source) VALUES (?1, ?2, ?3)",
            rusqlite::params!["sid2", "Telegram AI discussion", "telegram"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "sid2").unwrap();
        let res = resolve_canonical_title(&conn, &lineage, None, Some("telegram"), 1);

        assert_eq!(res.canonical_title, "Telegram AI discussion");
        assert_eq!(res.title_source, TitleSource::DbTip);
    }

    #[test]
    fn test_title_3_child_continuation_overrides_root_title() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title, started_at) VALUES (?1, NULL, ?2, 100.0)",
            rusqlite::params!["root_sid", "Hermes adapter"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title, started_at) VALUES (?1, ?2, ?3, 200.0)",
            rusqlite::params!["child_sid", "root_sid", "Hermes adapter #2"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "root_sid").unwrap();
        assert_eq!(lineage.tip_session_id, "child_sid");

        let res = resolve_canonical_title(&conn, &lineage, None, None, 1);
        assert_eq!(res.canonical_title, "Hermes adapter #2");
        assert_eq!(res.title_source, TitleSource::DbTip);
    }

    #[test]
    fn test_title_4_child_title_null_uses_nearest_ancestor() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title, started_at) VALUES (?1, NULL, ?2, 100.0)",
            rusqlite::params!["root_sid", "Original Title"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title, started_at) VALUES (?1, ?2, NULL, 200.0)",
            rusqlite::params!["child_sid", "root_sid"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "child_sid").unwrap();
        let res = resolve_canonical_title(&conn, &lineage, None, None, 1);

        assert_eq!(res.canonical_title, "Original Title");
        assert_eq!(res.title_source, TitleSource::DbAncestor);
    }

    #[test]
    fn test_title_5_db_lineage_no_title_uses_routing_display_name() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, parent_session_id, title) VALUES (?1, NULL, NULL)",
            rusqlite::params!["sid5"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "sid5").unwrap();
        let res = resolve_canonical_title(&conn, &lineage, Some("Alice Team Chat"), Some("feishu"), 1);

        assert_eq!(res.canonical_title, "Alice Team Chat");
        assert_eq!(res.title_source, TitleSource::RoutingDisplayName);
    }

    #[test]
    fn test_title_6_no_db_title_no_display_name_uses_platform() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1, NULL)",
            rusqlite::params!["sid6"],
        )
        .unwrap();

        let lineage = resolve_hermes_lineage(&conn, "sid6").unwrap();
        let res = resolve_canonical_title(&conn, &lineage, None, Some("feishu"), 1);

        assert_eq!(res.canonical_title, "Feishu");
        assert_eq!(res.title_source, TitleSource::Platform);
    }

    #[test]
    fn test_title_7_named_profile_session_isolation() {
        // Test that lineage traversal halts when given an unknown or distinct session ID
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1, ?2)",
            rusqlite::params!["profile_a_sid", "Profile A Title"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1, ?2)",
            rusqlite::params!["profile_b_sid", "Profile B Title"],
        )
        .unwrap();

        let lin_a = resolve_hermes_lineage(&conn, "profile_a_sid").unwrap();
        let lin_b = resolve_hermes_lineage(&conn, "profile_b_sid").unwrap();

        let res_a = resolve_canonical_title(&conn, &lin_a, None, None, 1);
        let res_b = resolve_canonical_title(&conn, &lin_b, None, None, 2);

        assert_eq!(res_a.canonical_title, "Profile A Title");
        assert_eq!(res_b.canonical_title, "Profile B Title");
    }

    #[test]
    fn test_python_syntax_of_generated_scripts() {
        let test_py = |code: &str, name: &str| {
            if let Ok(mut child) = std::process::Command::new("python")
                .args(["-c", "import ast, sys; ast.parse(sys.stdin.read())"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                use std::io::Write;
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(code.as_bytes());
                }
                let output = child.wait_with_output().unwrap();
                if !output.status.success() {
                    panic!(
                        "Python syntax error in {}: {}",
                        name,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
        };

        test_py(&build_hermes_plugin_source("# connect code"), "plugin source");
        test_py(&build_hermes_gateway_hook_source("# gw connect code"), "gateway hook source");
        test_py(build_hermes_remote_collector_script(), "remote collector script");
    }

    #[test]
    #[ignore]
    fn test_live_vps_probe() {
        let script = build_hermes_remote_collector_script();
        let mut child = std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "hermes@10.147.17.193", "python3", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes());
        }
        let output = child.wait_with_output().unwrap();
        let s = String::from_utf8_lossy(&output.stdout);
        eprintln!("LIVE VPS OUTPUT: {}", s);
        let err = String::from_utf8_lossy(&output.stderr);
        if !err.is_empty() {
            eprintln!("LIVE VPS STDERR: {}", err);
        }
        assert!(output.status.success());
    }

    #[test]
    #[ignore]
    fn test_live_vps_deploy() {
        let plugin_yaml = build_hermes_plugin_yaml();
        let hook_yaml = build_hermes_gateway_hook_yaml();
        let connect_code = r#"SOCKET_PATH = "/tmp/ooclaw-hermes.sock"

def _send(payload):
    import os as _os
    if not _os.path.exists(SOCKET_PATH):
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(SOCKET_PATH)
        s.sendall(json.dumps(payload).encode("utf-8"))
        s.shutdown(socket.SHUT_WR)
        s.close()
    except Exception:
        pass"#;

        let gw_connect_code = r#"SOCKET_PATH = "/tmp/ooclaw-hermes.sock"

def _send_to_ooclaw(payload):
    raw = json.dumps(payload) + "\n"
    if not os.path.exists(SOCKET_PATH):
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(SOCKET_PATH)
        s.sendall(raw.encode("utf-8"))
        s.close()
    except Exception:
        pass"#;

        let init_py = build_hermes_plugin_source(connect_code);
        let handler_py = build_hermes_gateway_hook_source(gw_connect_code);

        let script = format!(
            r#"import json, os, subprocess, glob, shutil

hermes_dir = os.path.expanduser('~/.hermes')
install_targets = [hermes_dir]
profiles_root = os.path.join(hermes_dir, 'profiles')
if os.path.isdir(profiles_root):
    for pd in glob.glob(os.path.join(profiles_root, '*')):
        if os.path.isdir(pd) and os.path.exists(os.path.join(pd, 'config.yaml')):
            install_targets.append(pd)

result = {{"installed": True, "enabled": False, "method": "none", "targets": []}}
hermes_bin = shutil.which('hermes')
if not hermes_bin:
    for p in [os.path.expanduser('~/.local/bin/hermes'),
              os.path.expanduser('~/.local/share/uv/tools/hermes-agent/bin/hermes'),
              '/usr/local/bin/hermes']:
        if os.path.exists(p):
            hermes_bin = p
            break

for target_dir in install_targets:
    plugin_dir = os.path.join(target_dir, 'plugins', 'ooclaw')
    os.makedirs(plugin_dir, exist_ok=True)
    with open(os.path.join(plugin_dir, 'plugin.yaml'), 'w') as f:
        f.write('''{plugin_yaml}''')
    with open(os.path.join(plugin_dir, '__init__.py'), 'w') as f:
        f.write('''{init_py}''')
    pycache = os.path.join(plugin_dir, '__pycache__')
    if os.path.exists(pycache):
        shutil.rmtree(pycache, ignore_errors=True)

    hook_dir = os.path.join(target_dir, 'hooks', 'ooclaw')
    os.makedirs(hook_dir, exist_ok=True)
    with open(os.path.join(hook_dir, 'HOOK.yaml'), 'w') as f:
        f.write('''{hook_yaml}''')
    with open(os.path.join(hook_dir, 'handler.py'), 'w') as f:
        f.write('''{handler_py}''')
    h_pycache = os.path.join(hook_dir, '__pycache__')
    if os.path.exists(h_pycache):
        shutil.rmtree(h_pycache, ignore_errors=True)

    result["targets"].append(target_dir)

if hermes_bin:
    try:
        out = subprocess.run([hermes_bin, 'plugins', 'enable', 'ooclaw'],
                            capture_output=True, text=True, timeout=5)
        if out.returncode == 0:
            result["enabled"] = True
            result["method"] = "cli"
    except: pass
    for pd in install_targets:
        if pd == hermes_dir: continue
        profile_name = os.path.basename(pd)
        try:
            subprocess.run([hermes_bin, '--profile', profile_name, 'plugins', 'enable', 'ooclaw'],
                          capture_output=True, text=True, timeout=5)
        except: pass

if not result["enabled"]:
    config_path = os.path.join(hermes_dir, 'config.yaml')
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                content = f.read()
            if 'ooclaw' not in content:
                if 'plugins:' in content:
                    content = content.replace('enabled: []', 'enabled:\n  - ooclaw')
                    if 'enabled: []' not in content:
                        content = content.replace('enabled:', 'enabled:\n  - ooclaw', 1)
                else:
                    content += '\nplugins:\n  enabled:\n  - ooclaw\n  disabled: []\n'
                with open(config_path, 'w') as f:
                    f.write(content)
                result["enabled"] = True
                result["method"] = "config_patch"
            else:
                result["enabled"] = True
                result["method"] = "already_enabled"
        except Exception as e:
            result["error"] = str(e)

print(json.dumps(result))
"#,
            plugin_yaml = plugin_yaml.replace("'''", "\\'''"),
            init_py = init_py.replace("'''", "\\'''"),
            hook_yaml = hook_yaml.replace("'''", "\\'''"),
            handler_py = handler_py.replace("'''", "\\'''")
        );

        let mut child = std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "hermes@10.147.17.193", "python3", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes());
        }
        let output = child.wait_with_output().unwrap();
        let s = String::from_utf8_lossy(&output.stdout);
        eprintln!("DEPLOY VPS OUTPUT: {}", s);
        let err = String::from_utf8_lossy(&output.stderr);
        if !err.is_empty() {
            eprintln!("DEPLOY VPS STDERR: {}", err);
        }
        assert!(output.status.success());
    }
}

