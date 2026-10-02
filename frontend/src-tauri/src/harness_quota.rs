use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuotaWindow {
    pub label: String,
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HarnessQuotaSummary {
    pub harness: String,
    pub connected: bool,
    pub plan_label: Option<String>,
    pub primary: Option<QuotaWindow>,
    pub details: Vec<QuotaWindow>,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
}

#[derive(Clone, Debug)]
struct QuotaCacheEntry {
    summary: HarnessQuotaSummary,
    cached_at: u64,
    backoff_until: u64,
}

static QUOTA_CACHE: OnceLock<Mutex<HashMap<String, QuotaCacheEntry>>> = OnceLock::new();

fn get_cache() -> &'static Mutex<HashMap<String, QuotaCacheEntry>> {
    QUOTA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Extract argument value from a command-line string (supports `--arg=val`, `--arg="val"`, and `--arg val`).
pub fn extract_arg_value<'a>(cmdline: &'a str, arg_name: &str) -> Option<String> {
    let prefix_eq = format!("{}=", arg_name);
    if let Some(pos) = cmdline.find(&prefix_eq) {
        let remainder = &cmdline[pos + prefix_eq.len()..];
        let val = remainder.split_whitespace().next().unwrap_or("");
        let trimmed = val.trim_matches(|c| c == '"' || c == '\'');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let mut iter = cmdline.split_whitespace();
    while let Some(part) = iter.next() {
        if part == arg_name {
            if let Some(val) = iter.next() {
                let trimmed = val.trim_matches(|c| c == '"' || c == '\'');
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Process & Port Discovery for Antigravity (Windows, macOS, Linux)
// ---------------------------------------------------------------------------

struct DiscoveredProcess {
    _pid: u32,
    ports: Vec<u16>,
    cmdline: String,
}

#[cfg(windows)]
async fn discover_antigravity_processes() -> Vec<DiscoveredProcess> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let ps_candidate = r"C:\Program Files\PowerShell\7\pwsh.exe";
    let ps_exe = if std::path::Path::new(ps_candidate).is_file() {
        ps_candidate
    } else {
        "powershell.exe"
    };

    let script = r#"Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language*server*' -or $_.Name -like '*agy*' } | ForEach-Object { $p = $_.ProcessId; $ports = (Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique) -join ','; "$p|||$ports|||$($_.CommandLine)" }"#;

    let mut cmd = tokio::process::Command::new(ps_exe);
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut procs = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split("|||").collect();
        if parts.len() >= 3 {
            let pid = parts[0].trim().parse::<u32>().unwrap_or(0);
            let mut ports = Vec::new();
            for p_str in parts[1].split(',') {
                if let Ok(p) = p_str.trim().parse::<u16>() {
                    if p > 0 {
                        ports.push(p);
                    }
                }
            }
            let cmdline = parts[2].trim().to_string();
            procs.push(DiscoveredProcess { _pid: pid, ports, cmdline });
        }
    }

    procs
}

#[cfg(target_os = "macos")]
async fn discover_antigravity_processes() -> Vec<DiscoveredProcess> {
    let mut cmd = tokio::process::Command::new("ps");
    cmd.args(["-ax", "-o", "pid,command"]);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(4), cmd.output()).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut procs = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("language_server") || lower.contains("language-server") || lower.contains("agy") {
            let mut parts = line.split_whitespace();
            if let Some(pid_str) = parts.next() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let cmdline = parts.collect::<Vec<&str>>().join(" ");
                    let mut ports = Vec::new();

                    // Check listening ports via lsof
                    let mut lsof_cmd = tokio::process::Command::new("lsof");
                    lsof_cmd.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-p", &pid.to_string(), "-a"]);
                    if let Ok(Ok(lsof_out)) = tokio::time::timeout(std::time::Duration::from_millis(1500), lsof_cmd.output()).await {
                        let lsof_txt = String::from_utf8_lossy(&lsof_out.stdout);
                        for l_line in lsof_txt.lines() {
                            if let Some(pos) = l_line.rfind(':') {
                                let remainder = &l_line[pos + 1..];
                                let port_str = remainder.split_whitespace().next().unwrap_or("");
                                if let Ok(p) = port_str.parse::<u16>() {
                                    if p > 0 && !ports.contains(&p) {
                                        ports.push(p);
                                    }
                                }
                            }
                        }
                    }

                    procs.push(DiscoveredProcess { _pid: pid, ports, cmdline });
                }
            }
        }
    }

    procs
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn discover_antigravity_processes() -> Vec<DiscoveredProcess> {
    let mut cmd = tokio::process::Command::new("ps");
    cmd.args(["-ax", "-o", "pid,command"]);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(4), cmd.output()).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut procs = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("language_server") || lower.contains("language-server") || lower.contains("agy") {
            let mut parts = line.split_whitespace();
            if let Some(pid_str) = parts.next() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let cmdline = parts.collect::<Vec<&str>>().join(" ");
                    procs.push(DiscoveredProcess { _pid: pid, ports: Vec::new(), cmdline });
                }
            }
        }
    }

    procs
}

// ---------------------------------------------------------------------------
// Antigravity Decoders
// ---------------------------------------------------------------------------

pub fn decode_antigravity_quota_summary(
    res_json: &serde_json::Value,
    plan_label: Option<String>,
    now: u64,
) -> HarnessQuotaSummary {
    let mut primary: Option<QuotaWindow> = None;
    let mut details: Vec<QuotaWindow> = Vec::new();

    if let Some(groups) = res_json.get("response").and_then(|r| r.get("groups")).and_then(|g| g.as_array()) {
        for group in groups {
            let group_display_name = group.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
            let group_label = if group_display_name.to_lowercase().contains("gemini") {
                "Gemini"
            } else if group_display_name.to_lowercase().contains("claude") || group_display_name.to_lowercase().contains("gpt") {
                "Claude/GPT"
            } else if !group_display_name.is_empty() {
                group_display_name
            } else {
                "Models"
            };

            if let Some(buckets) = group.get("buckets").and_then(|b| b.as_array()) {
                for bucket in buckets {
                    let bucket_id = bucket.get("bucketId").and_then(|v| v.as_str()).unwrap_or("");
                    let bucket_display = bucket.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                    let window = bucket.get("window").and_then(|v| v.as_str()).unwrap_or("");
                    let remaining_fraction = bucket.get("remainingFraction").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let reset_time = bucket.get("resetTime").and_then(|v| v.as_str()).map(|s| s.to_string());

                    // Calculate used percentage (0 to 100)
                    let used_fraction = (1.0 - remaining_fraction).clamp(0.0, 1.0);
                    let percent = (used_fraction * 1000.0).round() / 10.0;

                    let window_suffix = if window == "5h" {
                        "5h"
                    } else if window == "weekly" {
                        "Weekly"
                    } else if !window.is_empty() {
                        window
                    } else {
                        bucket_display
                    };

                    let label = format!("{} ({})", group_label, window_suffix);

                    let quota_win = QuotaWindow {
                        label,
                        percent,
                        resets_at: reset_time,
                    };

                    // Primary window is the Gemini 5h limit
                    if primary.is_none() && (bucket_id == "gemini-5h" || (group_label == "Gemini" && window == "5h")) {
                        primary = Some(quota_win);
                    } else {
                        details.push(quota_win);
                    }
                }
            }
        }
    }

    if primary.is_none() && !details.is_empty() {
        primary = Some(details.remove(0));
    }

    HarnessQuotaSummary {
        harness: "antigravity".to_string(),
        connected: true,
        plan_label,
        primary,
        details,
        updated_at: now,
        status_message: None,
    }
}

pub fn decode_antigravity_user_status(
    status_json: &serde_json::Value,
    now: u64,
) -> HarnessQuotaSummary {
    let user_status = status_json.get("userStatus");
    let plan_label = user_status
        .and_then(|u| u.get("userTier"))
        .and_then(|t| t.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            user_status
                .and_then(|u| u.get("planStatus"))
                .and_then(|p| p.get("planInfo"))
                .and_then(|i| i.get("planName"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string());

    let mut primary: Option<QuotaWindow> = None;
    let mut details: Vec<QuotaWindow> = Vec::new();
    let mut seen_models = std::collections::HashSet::new();

    if let Some(configs) = user_status
        .and_then(|u| u.get("cascadeModelConfigData"))
        .and_then(|c| c.get("clientModelConfigs"))
        .and_then(|v| v.as_array())
    {
        for cfg in configs {
            let label_raw = cfg.get("label").and_then(|v| v.as_str()).unwrap_or("");
            if label_raw.is_empty() {
                continue;
            }

            // Normalize model label e.g. "Gemini 3.8 Flash (Low)" -> "Gemini 3.8 Flash"
            let clean_label = if let Some(idx) = label_raw.find(" (") {
                label_raw[..idx].trim()
            } else {
                label_raw.trim()
            };

            if seen_models.contains(clean_label) {
                continue;
            }
            seen_models.insert(clean_label.to_string());

            if let Some(quota_info) = cfg.get("quotaInfo") {
                let remaining_fraction = quota_info
                    .get("remainingFraction")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1.0);
                let reset_time = quota_info
                    .get("resetTime")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let used_fraction = (1.0 - remaining_fraction).clamp(0.0, 1.0);
                let percent = (used_fraction * 1000.0).round() / 10.0;

                let win = QuotaWindow {
                    label: clean_label.to_string(),
                    percent,
                    resets_at: reset_time,
                };

                if primary.is_none() && clean_label.contains("3.8 Flash") {
                    primary = Some(win);
                } else {
                    details.push(win);
                }
            }
        }
    }

    if primary.is_none() && !details.is_empty() {
        primary = Some(details.remove(0));
    }

    HarnessQuotaSummary {
        harness: "antigravity".to_string(),
        connected: true,
        plan_label,
        primary,
        details,
        updated_at: now,
        status_message: None,
    }
}

// ---------------------------------------------------------------------------
// Antigravity Fetcher
// ---------------------------------------------------------------------------

static LAST_KNOWN_AGY_ENDPOINT: OnceLock<Mutex<Option<(u16, String)>>> = OnceLock::new();

fn get_last_known_endpoint() -> &'static Mutex<Option<(u16, String)>> {
    LAST_KNOWN_AGY_ENDPOINT.get_or_init(|| Mutex::new(None))
}

async fn try_fetch_antigravity_from_port(
    client: &reqwest::Client,
    port: u16,
    csrf_token: &str,
    now: u64,
) -> Result<HarnessQuotaSummary, ()> {
    // First attempt: RetrieveUserQuotaSummary
    let quota_url = format!("https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
    let mut req = client
        .post(&quota_url)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body("{}");

    if !csrf_token.is_empty() {
        req = req.header("X-Codeium-Csrf-Token", csrf_token);
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                // Optionally fetch plan tier from GetUserStatus on the same port
                let status_url = format!("https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus");
                let mut status_req = client
                    .post(&status_url)
                    .header("Content-Type", "application/json")
                    .header("Connect-Protocol-Version", "1")
                    .body("{}");
                if !csrf_token.is_empty() {
                    status_req = status_req.header("X-Codeium-Csrf-Token", csrf_token);
                }

                let plan_label = if let Ok(s_resp) = status_req.send().await {
                    if s_resp.status().is_success() {
                        if let Ok(s_json) = s_resp.json::<serde_json::Value>().await {
                            s_json
                                .get("userStatus")
                                .and_then(|u| u.get("userTier"))
                                .and_then(|t| t.get("name"))
                                .and_then(|v| v.as_str())
                                .or_else(|| {
                                    s_json
                                        .get("userStatus")
                                        .and_then(|u| u.get("planStatus"))
                                        .and_then(|p| p.get("planInfo"))
                                        .and_then(|i| i.get("planName"))
                                        .and_then(|v| v.as_str())
                                })
                                .map(|s| s.to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };

                let summary = decode_antigravity_quota_summary(&json, plan_label, now);
                return Ok(summary);
            }
        }
    }

    // Fallback attempt: GetUserStatus
    let status_url = format!("https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus");
    let mut req = client
        .post(&status_url)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body("{}");

    if !csrf_token.is_empty() {
        req = req.header("X-Codeium-Csrf-Token", csrf_token);
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                let summary = decode_antigravity_user_status(&json, now);
                return Ok(summary);
            }
        }
    }

    Err(())
}

async fn fetch_antigravity_quota(now: u64) -> Result<(HarnessQuotaSummary, Option<u64>), String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for Antigravity: {e}"))?;

    // Fast-path: try last known working endpoint directly (avoids 4-5s PowerShell WMI query)
    let cached_endpoint = get_last_known_endpoint().lock().ok().and_then(|g| g.clone());
    if let Some((port, ref csrf_token)) = cached_endpoint {
        if let Ok(summary) = try_fetch_antigravity_from_port(&client, port, csrf_token, now).await {
            return Ok((summary, None));
        }
    }

    let procs = discover_antigravity_processes().await;
    if procs.is_empty() {
        return Ok((
            HarnessQuotaSummary {
                harness: "antigravity".to_string(),
                connected: false,
                plan_label: None,
                primary: None,
                details: Vec::new(),
                updated_at: now,
                status_message: None,
            },
            None,
        ));
    }

    for proc in procs {
        let csrf_token = extract_arg_value(&proc.cmdline, "--csrf_token").unwrap_or_default();
        let mut candidate_ports = proc.ports.clone();

        if let Some(ext_port_str) = extract_arg_value(&proc.cmdline, "--extension_server_port") {
            if let Ok(p) = ext_port_str.parse::<u16>() {
                if p > 0 && !candidate_ports.contains(&p) {
                    candidate_ports.push(p);
                }
            }
        }

        if let Some(https_port_str) = extract_arg_value(&proc.cmdline, "--https_server_port") {
            if let Ok(p) = https_port_str.parse::<u16>() {
                if p > 0 && !candidate_ports.contains(&p) {
                    candidate_ports.push(p);
                }
            }
        }

        for port in candidate_ports {
            if let Ok(summary) = try_fetch_antigravity_from_port(&client, port, &csrf_token, now).await {
                if let Ok(mut lock) = get_last_known_endpoint().lock() {
                    *lock = Some((port, csrf_token));
                }
                return Ok((summary, None));
            }
        }
    }

    Ok((
        HarnessQuotaSummary {
            harness: "antigravity".to_string(),
            connected: false,
            plan_label: None,
            primary: None,
            details: Vec::new(),
            updated_at: now,
            status_message: None,
        },
        None,
    ))
}

// ---------------------------------------------------------------------------
// Codex Implementation
// ---------------------------------------------------------------------------

pub fn decode_codex_usage(
    usage_json: &serde_json::Value,
    now: u64,
) -> HarnessQuotaSummary {
    let plan_label = usage_json.get("plan_type").and_then(|v| v.as_str()).map(|p| {
        let mut chars = p.chars();
        match chars.next() {
            None => String::new(),
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        }
    });

    let rate_limit = usage_json.get("rate_limit");
    let mut primary: Option<QuotaWindow> = None;
    let mut details: Vec<QuotaWindow> = Vec::new();

    if let Some(rl) = rate_limit {
        if let Some(pw) = rl.get("primary_window") {
            let used_pct = pw.get("used_percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let win_secs = pw.get("limit_window_seconds").and_then(|v| v.as_u64());
            let reset_at_ts = pw.get("reset_at").and_then(|v| v.as_i64());
            let resets_at = reset_at_ts.and_then(|ts| DateTime::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339()));
            let label = if win_secs == Some(18000) {
                "5-Hour Window".to_string()
            } else if let Some(s) = win_secs {
                format!("{}h Window", s / 3600)
            } else {
                "5-Hour Window".to_string()
            };
            primary = Some(QuotaWindow {
                label,
                percent: used_pct,
                resets_at,
            });
        }

        if let Some(sw) = rl.get("secondary_window") {
            let used_pct = sw.get("used_percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let win_secs = sw.get("limit_window_seconds").and_then(|v| v.as_u64());
            let reset_at_ts = sw.get("reset_at").and_then(|v| v.as_i64());
            let resets_at = reset_at_ts.and_then(|ts| DateTime::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339()));
            let label = if win_secs == Some(604800) {
                "Weekly Window".to_string()
            } else if let Some(s) = win_secs {
                format!("{}d Window", s / 86400)
            } else {
                "Weekly Window".to_string()
            };
            details.push(QuotaWindow {
                label,
                percent: used_pct,
                resets_at,
            });
        }

        if let Some(cr) = usage_json.get("code_review_rate_limit").filter(|v| !v.is_null()) {
            if let Some(pw) = cr.get("primary_window") {
                let used_pct = pw.get("used_percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let reset_at_ts = pw.get("reset_at").and_then(|v| v.as_i64());
                let resets_at = reset_at_ts.and_then(|ts| DateTime::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339()));
                details.push(QuotaWindow {
                    label: "Code Review Limit".to_string(),
                    percent: used_pct,
                    resets_at,
                });
            }
        }
    }

    HarnessQuotaSummary {
        harness: "codex".to_string(),
        connected: true,
        plan_label,
        primary,
        details,
        updated_at: now,
        status_message: None,
    }
}

async fn refresh_codex_token(
    client: &reqwest::Client,
    refresh_token: &str,
    auth_path: &Path,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    });

    let resp = client
        .post("https://auth.openai.com/oauth/token")
        .header("Content-Type", "application/json")
        .header("User-Agent", "codex/1.0")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Token refresh request error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Token refresh failed: HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Token refresh JSON parse error: {e}"))?;

    let new_access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing access_token in refresh response".to_string())?
        .to_string();

    let new_refresh_token = json.get("refresh_token").and_then(|v| v.as_str());

    // Update auth.json file safely
    if let Ok(raw) = std::fs::read_to_string(auth_path) {
        if let Ok(mut auth_val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if auth_val.get("tokens").map(|t| t.is_object()).unwrap_or(false) {
                if let Some(tok_obj) = auth_val.get_mut("tokens").and_then(|t| t.as_object_mut()) {
                    tok_obj.insert("access_token".to_string(), serde_json::json!(new_access_token));
                    if let Some(nrt) = new_refresh_token {
                        tok_obj.insert("refresh_token".to_string(), serde_json::json!(nrt));
                    }
                }
            } else {
                auth_val["access_token"] = serde_json::json!(new_access_token);
                if let Some(nrt) = new_refresh_token {
                    auth_val["refresh_token"] = serde_json::json!(nrt);
                }
            }
            auth_val["last_refresh"] = serde_json::json!(Utc::now().to_rfc3339());

            if let Ok(formatted) = serde_json::to_string_pretty(&auth_val) {
                let _ = std::fs::write(auth_path, formatted);
            }
        }
    }

    Ok(new_access_token)
}

async fn fetch_codex_quota(now: u64) -> Result<(HarnessQuotaSummary, Option<u64>), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let auth_path = home.join(".codex").join("auth.json");

    if !auth_path.exists() {
        return Ok((
            HarnessQuotaSummary {
                harness: "codex".to_string(),
                connected: false,
                plan_label: None,
                primary: None,
                details: Vec::new(),
                updated_at: now,
                status_message: None,
            },
            None,
        ));
    }

    let auth_data = std::fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read {}: {e}", auth_path.display()))?;

    let auth_json: serde_json::Value = serde_json::from_str(&auth_data)
        .map_err(|e| format!("Invalid JSON in {}: {e}", auth_path.display()))?;

    let tokens = auth_json.get("tokens");
    let access_token = tokens
        .and_then(|t| t.get("access_token"))
        .and_then(|v| v.as_str())
        .or_else(|| auth_json.get("access_token").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let refresh_token = tokens
        .and_then(|t| t.get("refresh_token"))
        .and_then(|v| v.as_str())
        .or_else(|| auth_json.get("refresh_token").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let account_id = tokens
        .and_then(|t| t.get("account_id"))
        .and_then(|v| v.as_str())
        .or_else(|| auth_json.get("account_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let current_token = match access_token {
        Some(t) if !t.trim().is_empty() => t,
        _ => {
            return Ok((
                HarnessQuotaSummary {
                    harness: "codex".to_string(),
                    connected: false,
                    plan_label: None,
                    primary: None,
                    details: Vec::new(),
                    updated_at: now,
                    status_message: None,
                },
                None,
            ));
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let send_usage = |token: &str| {
        let mut req = client
            .get("https://chatgpt.com/backend-api/wham/usage")
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", "codex/1.0")
            .header("Accept", "application/json");

        if let Some(ref acc) = account_id {
            req = req.header("chatgpt-account-id", acc);
        }
        req
    };

    let mut resp = send_usage(&current_token)
        .send()
        .await
        .map_err(|e| format!("Codex usage request error: {e}"))?;

    // Handle 401 Unauthorized with token refresh retry
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(ref rt) = refresh_token {
            log::info!("[harness_quota] Codex token 401: attempting OAuth token refresh");
            if let Ok(new_token) = refresh_codex_token(&client, rt, &auth_path).await {
                resp = send_usage(&new_token)
                    .send()
                    .await
                    .map_err(|e| format!("Codex usage retry request error: {e}"))?;
            }
        }
    }

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(30, 300);

        log::warn!("[harness_quota] Codex 429 rate limit hit, backoff for {}s", retry_after);
        return Ok((
            HarnessQuotaSummary {
                harness: "codex".to_string(),
                connected: true,
                plan_label: None,
                primary: None,
                details: Vec::new(),
                updated_at: now,
                status_message: None,
            },
            Some(retry_after),
        ));
    }

    if !resp.status().is_success() {
        return Err(format!("Codex usage endpoint returned HTTP {}", resp.status()));
    }

    let usage_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Codex usage response: {e}"))?;

    let summary = decode_codex_usage(&usage_json, now);
    Ok((summary, None))
}

// ---------------------------------------------------------------------------
// Claude Code Implementation
// ---------------------------------------------------------------------------

/// Cooldown applied after a 429 from the usage endpoint. The endpoint shares its
/// budget with Claude Code itself and sends a long `Retry-After` (often 20+
/// minutes); calling again during the cooldown only renews the penalty, so the
/// server's value is honoured up to an hour.
const CLAUDE_COOLDOWN_DEFAULT_SECS: u64 = 300;
const CLAUDE_COOLDOWN_MIN_SECS: u64 = 60;
const CLAUDE_COOLDOWN_MAX_SECS: u64 = 3600;
/// In-memory reuse window for a successful poll (Codex/Antigravity use 300s).
const CLAUDE_CACHE_TTL_SECS: u64 = 120;
const CLAUDE_NATIVE_TTL_SECS: u64 = 120;
static CLAUDE_NATIVE_USAGE: std::sync::LazyLock<Mutex<HashMap<String, HarnessQuotaSummary>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static CLAUDE_FETCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
// The identity is process-local, never serialized: CLI may omit account UUIDs.
// Re-read credentials before reusing quota so an account switch cannot reuse bars.
static CLAUDE_HTTP_CACHE: Mutex<Option<(String, QuotaCacheEntry)>> = Mutex::new(None);

fn reusable_claude_entry(
    key: &str,
    entry: &QuotaCacheEntry,
    credential: &str,
    force: bool,
    now: u64,
) -> bool {
    key == credential
        && !force
        && entry.cached_at <= now
        && now - entry.cached_at < CLAUDE_CACHE_TTL_SECS
        && (entry.backoff_until == 0 || entry.backoff_until > now)
        && entry
            .summary
            .primary
            .iter()
            .chain(&entry.summary.details)
            .all(|w| {
                w.resets_at
                    .as_ref()
                    .and_then(|r| DateTime::parse_from_rfc3339(r).ok())
                    .is_none_or(|r| r.timestamp() > now as i64)
            })
}

/// Statusline schema has a session ID but no account/org. Store it separately:
/// it cannot overwrite OAuth-owned quota or bypass credential selection.
pub fn observe_claude_usage(event: &serde_json::Value) -> bool {
    record_claude_native_usage(&mut CLAUDE_NATIVE_USAGE.lock().unwrap(), event, unix_now())
}

fn record_claude_native_usage(
    readings: &mut HashMap<String, HarnessQuotaSummary>,
    event: &serde_json::Value,
    now: u64,
) -> bool {
    let Some(session) = event["session_id"].as_str().filter(|s| !s.is_empty()) else {
        return false;
    };
    let Some(summary) = decode_claude_statusline(event, now) else {
        return false;
    };
    readings.retain(|_, s| s.updated_at <= now && now - s.updated_at < CLAUDE_NATIVE_TTL_SECS);
    if !readings.contains_key(session) && readings.len() >= 128 {
        return false;
    }
    readings.insert(session.to_owned(), summary);
    true
}

fn decode_claude_statusline(event: &serde_json::Value, now: u64) -> Option<HarnessQuotaSummary> {
    let limits = event.get("rate_limits")?;
    let window = |key: &str, label: &str| -> Option<QuotaWindow> {
        let value = limits.get(key)?;
        let percent = value.get("used_percentage")?.as_f64()?;
        let reset = value.get("resets_at").and_then(|v| v.as_i64());
        if reset.is_some_and(|reset| reset <= now as i64) {
            return None;
        }
        Some(QuotaWindow {
            label: label.into(),
            percent: percent.clamp(0.0, 100.0),
            resets_at: reset
                .and_then(|r| DateTime::from_timestamp(r, 0))
                .map(|r| r.to_rfc3339()),
        })
    };
    let mut primary = window("five_hour", "5-Hour Window");
    let mut details: Vec<_> = window("seven_day", "Weekly Window").into_iter().collect();
    if primary.is_none() && !details.is_empty() {
        primary = Some(details.remove(0));
    }
    primary.as_ref()?;
    Some(HarnessQuotaSummary {
        harness: "claude".into(),
        connected: true,
        plan_label: None,
        primary,
        details,
        updated_at: now,
        status_message: None,
    })
}

fn unscoped_claude_native_usage(
    readings: &HashMap<String, HarnessQuotaSummary>,
    oauth_identity: bool,
    now: u64,
) -> Option<HarnessQuotaSummary> {
    if oauth_identity {
        return None;
    }
    let mut fresh = readings.values().filter(|s| {
        s.updated_at <= now
            && now - s.updated_at < CLAUDE_NATIVE_TTL_SECS
            && s.primary
                .as_ref()
                .and_then(|w| w.resets_at.as_ref())
                .and_then(|r| DateTime::parse_from_rfc3339(r).ok())
                .is_none_or(|r| r.timestamp() > now as i64)
    });
    let only = fresh.next()?.clone();
    // The aggregate UI has no selected session; don't choose among sessions
    // whose accounts cannot be proven equal.
    fresh.next().is_none().then_some(only)
}
/// How long a persisted last-good reading may still be shown while the
/// endpoint is unreachable or cooling down.
const CLAUDE_LAST_GOOD_MAX_AGE_SECS: u64 = 7 * 24 * 3600;

/// Matches the Tauri `identifier`, i.e. the directory `app_data_dir()` resolves to.
const APP_DATA_DIRNAME: &str = "com.openclaw.ooclaw";
const CLAUDE_STATE_FILE: &str = "claude-usage-state.json";

/// Survives restarts so a relaunch neither re-hits a cooling-down endpoint nor
/// blanks the quota UI.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct ClaudePersistedState {
    last_good: Option<HarnessQuotaSummary>,
    /// Unix seconds until which the endpoint must not be called.
    retry_at: Option<u64>,
    /// `expiresAt` of the credential the cooldown was armed for. It changes on
    /// every login refresh, so a fresh login is not held back by an old
    /// cooldown, and no secret is written to disk.
    cooldown_token_expires_at_ms: Option<u64>,
}

impl ClaudePersistedState {
    /// Remaining cooldown seconds, if one is armed for this credential.
    fn cooldown_remaining(&self, token_expires_at_ms: Option<u64>, now: u64) -> Option<u64> {
        let retry_at = self.retry_at.filter(|&t| t > now)?;
        if self.cooldown_token_expires_at_ms != token_expires_at_ms {
            return None;
        }
        Some(retry_at - now)
    }

    fn fresh_last_good(&self, now: u64) -> Option<HarnessQuotaSummary> {
        let mut summary = self
            .last_good
            .clone()
            .filter(|s| s.updated_at <= now && now - s.updated_at <= CLAUDE_LAST_GOOD_MAX_AGE_SECS)?;
        let usable = |w: &QuotaWindow| {
            w.resets_at
                .as_ref()
                .and_then(|r| DateTime::parse_from_rfc3339(r).ok())
                .is_none_or(|r| r.timestamp() > now as i64)
        };
        summary.primary = summary.primary.filter(&usable);
        summary.details.retain(usable);
        if summary.primary.is_none() && !summary.details.is_empty() {
            summary.primary = Some(summary.details.remove(0));
        }
        summary.primary.as_ref()?;
        Some(summary)
    }
}

fn claude_state_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_DATA_DIRNAME).join(CLAUDE_STATE_FILE))
}

/// Never import the legacy shared CLI state: its account cannot be proved.
/// Custom configs have no verified identity metadata yet, so they use only
/// token-scoped in-memory reuse rather than borrowing another login's disk data.
fn scoped_claude_state_path(
    base: &Path,
    desktop_key: Option<&str>,
    cli_identity: Option<&(String, String)>,
    custom_config: bool,
) -> Option<std::path::PathBuf> {
    let key = if let Some(key) = desktop_key {
        key.to_owned()
    } else {
        if custom_config {
            return None;
        }
        let (account, org) = cli_identity?;
        if account.trim().is_empty() || org.trim().is_empty() {
            return None;
        }
        // JSON encodes both IDs unambiguously; CLI and Desktop namespaces differ.
        format!("cli-{}", serde_json::to_string(&(account, org)).ok()?)
    };
    let safe = percent_encoding::utf8_percent_encode(&key, percent_encoding::NON_ALPHANUMERIC);
    Some(base.with_file_name(format!("claude-usage-{safe}.json")))
}

fn load_claude_state(path: &Path) -> ClaudePersistedState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Best effort: a failed write only costs the persistence, never the quota UI.
fn save_claude_state(path: &Path, state: &ClaudePersistedState) {
    let Ok(raw) = serde_json::to_string(state) else {
        return;
    };
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ClaudeOauthCredentials {
    access_token: String,
    /// Unix epoch milliseconds, as written by Claude Code.
    expires_at_ms: Option<u64>,
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

fn disconnected_summary(harness: &str, now: u64) -> HarnessQuotaSummary {
    HarnessQuotaSummary {
        harness: harness.to_string(),
        connected: false,
        plan_label: None,
        primary: None,
        details: Vec::new(),
        updated_at: now,
        status_message: None,
    }
}

/// Parse the `~/.claude/.credentials.json` payload (`{"claudeAiOauth": {...}}`).
fn parse_claude_credentials(raw: &str) -> Option<ClaudeOauthCredentials> {
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken")?.as_str()?.trim().to_string();
    if access_token.is_empty() {
        return None;
    }
    Some(ClaudeOauthCredentials {
        access_token,
        expires_at_ms: oauth.get("expiresAt").and_then(|v| v.as_u64()),
        subscription_type: oauth
            .get("subscriptionType")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        rate_limit_tier: oauth
            .get("rateLimitTier")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn claude_config_dir() -> Option<std::path::PathBuf> {
    crate::claude_metadata::config_dir()
}

/// Read Claude Code's subscription login. Windows/Linux keep it in
/// `.credentials.json`; macOS keeps it in the Keychain (with the file as a
/// fallback when the Keychain rejected the write).
async fn read_claude_credentials() -> Option<ClaudeOauthCredentials> {
    if let Some(path) = claude_config_dir().map(|d| d.join(".credentials.json")) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(creds) = parse_claude_credentials(&raw) {
                return Some(creds);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Only the default (no CLAUDE_CONFIG_DIR) service name is supported; a
        // custom config dir keys the Keychain entry with a directory hash.
        if std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .is_none()
        {
            let mut cmd = tokio::process::Command::new("security");
            cmd.args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ]);
            if let Ok(Ok(out)) =
                tokio::time::timeout(std::time::Duration::from_secs(4), cmd.output()).await
            {
                if out.status.success() {
                    return parse_claude_credentials(&String::from_utf8_lossy(&out.stdout));
                }
            }
        }
    }

    None
}

fn claude_plan_label(creds: &ClaudeOauthCredentials) -> Option<String> {
    let sub = creds.subscription_type.as_deref()?.trim();
    if sub.is_empty() {
        return None;
    }
    let mut chars = sub.chars();
    let mut label = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => return None,
    };
    if let Some(tier) = creds.rate_limit_tier.as_deref() {
        let tier = tier.to_ascii_lowercase();
        if tier.contains("max_20x") {
            label.push_str(" 20x");
        } else if tier.contains("max_5x") {
            label.push_str(" 5x");
        }
    }
    Some(label)
}

pub fn decode_claude_usage(
    usage_json: &serde_json::Value,
    plan_label: Option<String>,
    now: u64,
) -> HarnessQuotaSummary {
    // `utilization` is already a 0-100 percentage of the window consumed.
    let window = |key: &str, label: &str| -> Option<QuotaWindow> {
        let w = usage_json.get(key).filter(|v| v.is_object())?;
        let percent = w.get("utilization").and_then(|v| v.as_f64())?;
        Some(QuotaWindow {
            label: label.to_string(),
            percent: percent.clamp(0.0, 100.0),
            resets_at: w
                .get("resets_at")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        })
    };

    let primary = window("five_hour", "5-Hour Window");
    let mut details: Vec<QuotaWindow> = [
        ("seven_day", "Weekly Window"),
        ("seven_day_opus", "Weekly Opus"),
        ("seven_day_sonnet", "Weekly Sonnet"),
    ]
    .iter()
    .filter_map(|(key, label)| window(key, label))
    .collect();

    // Newer model-scoped weekly windows only appear in the generic `limits`
    // array (`kind: "weekly_scoped"`); the legacy top-level fields stay null for
    // them. Skip entries that repeat a window already read above.
    if let Some(limits) = usage_json.get("limits").and_then(|v| v.as_array()) {
        for entry in limits {
            if entry.get("kind").and_then(|v| v.as_str()) != Some("weekly_scoped") {
                continue;
            }
            let model = entry.get("scope").and_then(|s| s.get("model"));
            let name = ["display_name", "id"]
                .iter()
                .find_map(|k| model.and_then(|m| m.get(k)).and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|n| !n.is_empty());
            let (Some(name), Some(percent)) = (name, entry.get("percent").and_then(|v| v.as_f64()))
            else {
                continue;
            };
            let label = format!("Weekly {name}");
            if details.iter().any(|d| d.label.eq_ignore_ascii_case(&label)) {
                continue;
            }
            details.push(QuotaWindow {
                label,
                percent: percent.clamp(0.0, 100.0),
                resets_at: entry
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }

    let mut primary = primary;
    if primary.is_none() && !details.is_empty() {
        primary = Some(details.remove(0));
    }

    HarnessQuotaSummary {
        harness: "claude".to_string(),
        connected: true,
        plan_label,
        primary,
        details,
        updated_at: now,
        status_message: None,
    }
}

/// Cooldown for a 429, from the `Retry-After` header when it carries seconds.
fn claude_cooldown_secs(retry_after: Option<&str>) -> u64 {
    retry_after
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(CLAUDE_COOLDOWN_DEFAULT_SECS)
        .clamp(CLAUDE_COOLDOWN_MIN_SECS, CLAUDE_COOLDOWN_MAX_SECS)
}

/// What to show while the endpoint cannot be asked: the last good reading if
/// there is one, otherwise a connected-but-empty summary (the UI hides it).
fn claude_fallback_summary(state: &ClaudePersistedState, now: u64) -> HarnessQuotaSummary {
    state.fresh_last_good(now).unwrap_or(HarnessQuotaSummary {
        connected: true,
        ..disconnected_summary("claude", now)
    })
}

fn desktop_claude_quota(usage: crate::claude_desktop::Usage, now: u64) -> HarnessQuotaSummary {
    let mut summary = disconnected_summary("claude", usage.sampled_at);
    // Desktop samples background usage every 15 minutes, but its UI may stop
    // refreshing. Retain the actual measurement time and never label old data
    // as a current balance or invent a reset time absent from the history.
    if usage.sampled_at > now || now.saturating_sub(usage.sampled_at) > 20 * 60 {
        let readings = usage
            .windows
            .iter()
            .map(|(label, percent)| format!("{label}已用 {percent}%"))
            .collect::<Vec<_>>()
            .join("，");
        summary.status_message = Some(format!("Claude Desktop 配额缓存已过期（{readings}）。Desktop 更新配额后会自动读取；当前余额未知。"));
        return summary;
    }
    summary.connected = true;
    let mut windows = usage
        .windows
        .into_iter()
        .map(|(label, percent)| QuotaWindow {
            label,
            percent,
            resets_at: None,
        })
        .collect::<Vec<_>>();
    if !windows.is_empty() {
        summary.primary = Some(windows.remove(0));
    }
    summary.details = windows;
    summary.status_message =
        Some("读取自 Claude Desktop 最近的配额记录；该记录未提供重置时间。".into());
    summary
}

async fn fetch_claude_quota(
    now: u64,
    force: bool,
) -> Result<(HarnessQuotaSummary, Option<u64>), String> {
    let cli = read_claude_credentials().await;
    let expired = cli.as_ref().is_some_and(|c| {
        c.expires_at_ms
            .is_some_and(|t| t <= now.saturating_mul(1000) + 30_000)
    });
    // A custom CLI config may have a different account; default metadata is
    // not proof of its identity, so never borrow based on that file.
    let identity = dirs::home_dir()
        .filter(|_| {
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .filter(|v| !v.is_empty())
                .is_none()
        })
        .and_then(|home| crate::claude_desktop::json_file(&home.join(".claude.json")))
        .and_then(|json| {
            Some((
                json["oauthAccount"]["accountUuid"].as_str()?.to_owned(),
                json["oauthAccount"]["organizationUuid"]
                    .as_str()?
                    .to_owned(),
            ))
        });
    // CLI and Desktop can be different accounts. Only borrow for an expired
    // CLI login when both IDs match; an absent CLI uses Desktop independently.
    let desktop = if cli.is_none() {
        crate::claude_desktop_auth::read_credentials(None, now)
    } else if expired {
        identity
            .as_ref()
            .and_then(|(a, o)| crate::claude_desktop_auth::read_credentials(Some((a, o)), now))
    } else {
        None
    };
    let desktop_key = desktop.as_ref().map(|c| c.account_key.clone());
    let creds = match desktop
        .map(|d| ClaudeOauthCredentials {
            access_token: d.access_token,
            expires_at_ms: Some(d.expires_at_ms),
            subscription_type: d.subscription_type,
            rate_limit_tier: d.rate_limit_tier,
        })
        .or(cli)
    {
        Some(c) => c,
        None => {
            let oauth_identity =
                identity.is_some() || crate::claude_desktop_auth::has_selected_account();
            if let Some(native) = unscoped_claude_native_usage(
                &CLAUDE_NATIVE_USAGE.lock().unwrap(),
                oauth_identity,
                now,
            ) {
                return Ok((native, None));
            }
            if let Some(usage) = crate::claude_desktop::snapshot().usage {
                return Ok((desktop_claude_quota(usage, now), None));
            }
            let mut summary = disconnected_summary("claude", now);
            summary.status_message = Some("未找到 Claude Code 的订阅登录。Desktop 和终端可能使用独立登录；支持时将自动读取 Claude 提供的配额。".into());
            return Ok((summary, None));
        }
    };

    let credential_key = creds.access_token.clone();
    {
        let mut cache = CLAUDE_HTTP_CACHE.lock().unwrap();
        if cache.as_ref().is_none_or(|(key, _)| key != &credential_key) {
            *cache = None;
            get_cache().lock().unwrap().remove("claude");
        }
        if let Some((key, entry)) = cache.as_ref() {
            if reusable_claude_entry(key, entry, &credential_key, force, now) {
                return Ok((
                    entry.summary.clone(),
                    entry.backoff_until.checked_sub(now).filter(|t| *t > 0),
                ));
            }
        }
    }
    // Every persisted reading/cooldown belongs to one known account and org.
    let state_path = claude_state_path().and_then(|path| {
        scoped_claude_state_path(
            &path,
            desktop_key.as_deref(),
            identity.as_ref(),
            std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty()),
        )
    });
    let state = state_path
        .as_deref()
        .map(load_claude_state)
        .unwrap_or_default();
    let result = poll_claude_usage(
        now,
        &creds,
        state_path.as_deref(),
        state,
        desktop_key.is_some(),
    )
    .await;
    if let Ok((summary, backoff)) = &result {
        *CLAUDE_HTTP_CACHE.lock().unwrap() = Some((
            credential_key,
            QuotaCacheEntry {
                cached_at: unix_now(),
                summary: summary.clone(),
                backoff_until: backoff.map(|b| now + b).unwrap_or(0),
            },
        ));
    }
    result
}

fn claude_rate_limited(
    now: u64,
    creds: &ClaudeOauthCredentials,
    state_path: Option<&Path>,
    mut state: ClaudePersistedState,
    cooldown: u64,
) -> (HarnessQuotaSummary, Option<u64>) {
    state.retry_at = Some(now + cooldown);
    state.cooldown_token_expires_at_ms = creds.expires_at_ms;
    if let Some(path) = state_path {
        save_claude_state(path, &state);
    }
    let mut summary = claude_fallback_summary(&state, now);
    summary.status_message = Some(format!(
        "Claude 暂时限制配额查询，将在约 {} 分钟后重试。",
        cooldown.div_ceil(60)
    ));
    (summary, Some(cooldown))
}

async fn poll_claude_usage(
    now: u64,
    creds: &ClaudeOauthCredentials,
    state_path: Option<&Path>,
    mut state: ClaudePersistedState,
    desktop: bool,
) -> Result<(HarnessQuotaSummary, Option<u64>), String> {
    // Claude Code rotates its refresh token on every refresh. If oc-claw
    // refreshed too, Claude Code's copy of the token could be invalidated and
    // force a re-login, so never refresh or write the credentials file here.
    // Claude Code renews the file itself whenever it runs.
    if let Some(expires_at_ms) = creds.expires_at_ms {
        if expires_at_ms <= now.saturating_mul(1000) + 30_000 {
            return match state.fresh_last_good(now) {
                Some(last_good) => Ok((last_good, None)),
                None => Err(
                    "Claude Code login token expired; it refreshes the next time Claude Code runs"
                        .to_string(),
                ),
            };
        }
    }

    // Honour a cooldown armed by an earlier poll or an earlier app run. This is
    // checked here rather than only in the in-memory cache so that neither a
    // restart nor a manual refresh can punch through it.
    if let Some(remaining) = state.cooldown_remaining(creds.expires_at_ms, now) {
        let mut summary = claude_fallback_summary(&state, now);
        summary.status_message = Some(format!(
            "Claude 暂时限制配额查询，将在约 {} 分钟后重试。",
            remaining.div_ceil(60)
        ));
        return Ok((summary, Some(remaining)));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "oc-claw")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Claude usage request error: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let cooldown = claude_cooldown_secs(
            resp.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()),
        );
        log::warn!(
            "[harness_quota] Claude 429 rate limit hit, cooling down for {}s",
            cooldown
        );
        return Ok(claude_rate_limited(now, creds, state_path, state, cooldown));
    }

    // 403: token lacks the `user:profile` scope (e.g. a `setup-token` login) or
    // the account is not a claude.ai subscription, so there is no quota to show.
    if status == reqwest::StatusCode::FORBIDDEN {
        let mut summary = disconnected_summary("claude", now);
        summary.status_message = Some("当前 Claude 登录没有订阅配额查询权限。".into());
        return Ok((summary, None));
    }
    if !status.is_success() {
        return Err(format!("Claude usage endpoint returned HTTP {status}"));
    }

    let usage_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude usage response: {e}"))?;

    let mut summary = decode_claude_usage(&usage_json, claude_plan_label(&creds), unix_now());
    if desktop {
        summary.status_message = Some("使用 Claude Desktop 登录直接查询配额。".into());
    }
    if summary.primary.is_some() {
        state.last_good = Some(summary.clone());
    }
    state.retry_at = None;
    state.cooldown_token_expires_at_ms = None;
    if let Some(path) = state_path.as_deref() {
        save_claude_state(path, &state);
    }
    Ok((summary, None))
}

// ---------------------------------------------------------------------------
// Public Tauri Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_harness_quota(
    harness: String,
    force_refresh: Option<bool>,
) -> Result<Option<HarnessQuotaSummary>, String> {
    let harness_key = harness.trim().to_ascii_lowercase();
    if !matches!(harness_key.as_str(), "codex" | "antigravity" | "claude") {
        return Ok(None);
    }

    let force = force_refresh.unwrap_or(false);
    // Several UI consumers mount together; do not send duplicate cold polls to
    // the shared, rate-limited OAuth endpoint.
    let _claude_fetch_guard = if harness_key == "claude" {
        Some(CLAUDE_FETCH_LOCK.lock().await)
    } else {
        None
    };
    let now = unix_now();

    // Check cache and active 429 backoff
    {
        let cache = get_cache().lock().unwrap();
        if let Some(entry) = cache.get(&harness_key).filter(|_| harness_key != "claude") {
            // Claude's cooldown is enforced (and cleared on re-login) by its
            // persisted state inside fetch_claude_quota, so it is not short-circuited here.
            if entry.backoff_until > now && harness_key != "claude" {
                log::warn!(
                    "[harness_quota] {} is in 429 backoff until {} (remaining {}s)",
                    harness_key,
                    entry.backoff_until,
                    entry.backoff_until - now
                );
                return Ok(Some(entry.summary.clone()));
            }
            let ttl = if harness_key == "claude" {
                CLAUDE_CACHE_TTL_SECS
            } else {
                300
            };
            if !force && now.saturating_sub(entry.cached_at) < ttl {
                return Ok(Some(entry.summary.clone()));
            }
        }
    }

    let result = match harness_key.as_str() {
        "codex" => fetch_codex_quota(now).await,
        "antigravity" => fetch_antigravity_quota(now).await,
        "claude" => fetch_claude_quota(now, force).await,
        _ => unreachable!(),
    };

    match result {
        Ok((summary, backoff_opt)) => {
            let backoff_until = if let Some(secs) = backoff_opt {
                now + secs
            } else {
                0
            };
            let mut cache = get_cache().lock().unwrap();
            cache.insert(
                harness_key,
                QuotaCacheEntry {
                    summary: summary.clone(),
                    cached_at: now,
                    backoff_until,
                },
            );
            Ok(Some(summary))
        }
        Err(err) => {
            log::error!(
                "[harness_quota] Failed to fetch quota for {}: {}",
                harness_key,
                err
            );
            // Fall back to cached entry if present
            let cache = get_cache().lock().unwrap();
            if harness_key == "claude" {
                let mut summary = ClaudePersistedState {
                    last_good: cache.get(&harness_key).map(|e| e.summary.clone()),
                    ..Default::default()
                }
                .fresh_last_good(unix_now())
                .unwrap_or_else(|| disconnected_summary("claude", now));
                summary.status_message = Some(if summary.primary.is_some() {
                    format!("{err} 显示上次成功查询的配额。")
                } else {
                    err
                });
                return Ok(Some(summary));
            }
            if let Some(entry) = cache.get(&harness_key) {
                return Ok(Some(entry.summary.clone()));
            }
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_account_switch_does_not_borrow_a_balance_or_cooldown_on_b_429() {
        let dir = std::env::temp_dir().join(format!("oc-claw-cli-429-{}", std::process::id()));
        let base = dir.join(CLAUDE_STATE_FILE);
        let a = ("account-a".into(), "org".into());
        let b = ("account-b".into(), "org".into());
        let path_a = scoped_claude_state_path(&base, None, Some(&a), false).unwrap();
        let path_b = scoped_claude_state_path(&base, None, Some(&b), false).unwrap();
        let state_a = ClaudePersistedState {
            last_good: Some(decode_claude_usage(
                &serde_json::json!({"five_hour":{"utilization":91}}),
                None,
                1000,
            )),
            retry_at: Some(5000),
            cooldown_token_expires_at_ms: Some(2000000),
        };
        save_claude_state(&path_a, &state_a);
        // The old shared file also must never migrate into B's state.
        save_claude_state(&base, &state_a);
        assert_ne!(path_a, path_b);
        let state_b = load_claude_state(&path_b);
        assert_eq!(state_b, ClaudePersistedState::default());
        let creds_b = ClaudeOauthCredentials {
            access_token: "b-token".into(),
            expires_at_ms: Some(2000000),
            subscription_type: None,
            rate_limit_tier: None,
        };
        let (quota_b, retry) = claude_rate_limited(1001, &creds_b, Some(&path_b), state_b, 600);
        assert!(quota_b.primary.is_none());
        assert_eq!(retry, Some(600));
        let persisted_b = load_claude_state(&path_b);
        assert!(persisted_b.last_good.is_none());
        assert_eq!(
            persisted_b.cooldown_remaining(Some(2000000), 1001),
            Some(600)
        );
        assert_eq!(load_claude_state(&path_a), state_a);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cli_account_switch_does_not_borrow_a_balance_with_b_expired_token() {
        let dir = std::env::temp_dir().join(format!("oc-claw-cli-expired-{}", std::process::id()));
        let base = dir.join(CLAUDE_STATE_FILE);
        let a = ("account-a".into(), "org".into());
        let b = ("account-b".into(), "org".into());
        let path_a = scoped_claude_state_path(&base, None, Some(&a), false).unwrap();
        let path_b = scoped_claude_state_path(&base, None, Some(&b), false).unwrap();
        let state_a = ClaudePersistedState {
            last_good: Some(decode_claude_usage(
                &serde_json::json!({"five_hour":{"utilization":91}}),
                None,
                1000,
            )),
            ..Default::default()
        };
        save_claude_state(&path_a, &state_a);
        save_claude_state(&base, &state_a);
        let expired = ClaudeOauthCredentials {
            access_token: "b-token".into(),
            expires_at_ms: Some(1),
            subscription_type: None,
            rate_limit_tier: None,
        };
        let result = poll_claude_usage(
            1001,
            &expired,
            Some(&path_b),
            load_claude_state(&path_b),
            false,
        )
        .await;
        assert!(result.unwrap_err().contains("token expired"));
        // Its own known balance remains usable; no HTTP is made for expired tokens.
        let own = poll_claude_usage(
            1001,
            &expired,
            Some(&path_a),
            load_claude_state(&path_a),
            false,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(own.primary.unwrap().percent, 91.0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cli_persistence_requires_known_identity_and_never_shares_custom_config_state() {
        let base = Path::new("cache").join(CLAUDE_STATE_FILE);
        let account = ("account".into(), "org".into());
        let other_org = ("account".into(), "other-org".into());
        let cli = scoped_claude_state_path(&base, None, Some(&account), false).unwrap();
        assert_ne!(cli, base);
        assert_ne!(
            cli,
            scoped_claude_state_path(&base, None, Some(&other_org), false).unwrap()
        );
        assert_ne!(
            cli,
            scoped_claude_state_path(&base, Some("account:org"), None, false).unwrap()
        );
        assert!(scoped_claude_state_path(&base, None, None, false).is_none());
        assert!(
            scoped_claude_state_path(&base, None, Some(&("".into(), "org".into())), false)
                .is_none()
        );
        // Even supplied default metadata cannot prove a custom config's account.
        assert!(scoped_claude_state_path(&base, None, Some(&account), true).is_none());
        assert!(scoped_claude_state_path(&base, None, None, true).is_none());
    }

    #[test]
    fn cli_a_statusline_cannot_replace_desktop_b_oauth_quota() {
        let mut readings = HashMap::new();
        let cli_a = serde_json::json!({"session_id":"cli-account-a",
            "rate_limits":{"five_hour":{"used_percentage":91,"resets_at":2000}}});
        assert!(record_claude_native_usage(&mut readings, &cli_a, 1000));
        assert_eq!(
            unscoped_claude_native_usage(&readings, false, 1001)
                .unwrap()
                .primary
                .unwrap()
                .percent,
            91.0
        );
        // Desktop B owns the aggregate UI even if its OAuth lookup is expired,
        // cooling down or unavailable; the unbound A reading is never eligible.
        assert!(unscoped_claude_native_usage(&readings, true, 1001).is_none());
        let desktop_b = serde_json::json!({"session_id":"desktop-account-b",
            "rate_limits":{"five_hour":{"used_percentage":12,"resets_at":2000}}});
        assert!(record_claude_native_usage(&mut readings, &desktop_b, 1001));
        assert_eq!(readings.len(), 2);
        assert!(unscoped_claude_native_usage(&readings, false, 1001).is_none());
        assert!(unscoped_claude_native_usage(&readings, true, 1001).is_none());
        assert!(unscoped_claude_native_usage(&readings, false, 1121).is_none());
        assert!(!record_claude_native_usage(
            &mut readings,
            &serde_json::json!({"rate_limits":{"five_hour":{"used_percentage":5}}}),
            1001
        ));
    }

    #[test]
    fn desktop_usage_keeps_measurement_age_and_hides_stale_or_future_balances() {
        let usage = crate::claude_desktop::Usage {
            sampled_at: 1000,
            windows: vec![("5小时".into(), 0.0), ("7天".into(), 44.0)],
        };
        let fresh = desktop_claude_quota(usage.clone(), 2000);
        assert!(fresh.connected);
        assert_eq!(fresh.updated_at, 1000);
        assert_eq!(fresh.primary.unwrap().percent, 0.0);
        assert!(fresh.details[0].resets_at.is_none());
        for now in [999, 2201] {
            let stale = desktop_claude_quota(usage.clone(), now);
            assert!(!stale.connected);
            assert!(stale.primary.is_none());
            assert!(stale.details.is_empty());
            assert_eq!(stale.updated_at, 1000);
            assert!(stale.status_message.unwrap().contains("当前余额未知"));
        }
    }
    #[test]
    fn claude_statusline_usage_handles_zero_absent_and_expired_windows() {
        let event = serde_json::json!({"rate_limits": {
            "five_hour":{"used_percentage":0.0,"resets_at":2000},
            "seven_day":{"used_percentage":42.5,"resets_at":3000}
        }});
        let summary = decode_claude_statusline(&event, 1000).unwrap();
        assert_eq!(summary.primary.unwrap().percent, 0.0);
        assert_eq!(summary.details[0].percent, 42.5);
        let summary = decode_claude_statusline(&event, 2000).unwrap();
        assert_eq!(summary.primary.unwrap().label, "Weekly Window");
        assert!(decode_claude_statusline(&event, 3000).is_none());
        assert!(decode_claude_statusline(&serde_json::json!({}), 1).is_none());
        assert!(
            decode_claude_statusline(&serde_json::json!({"rate_limits":{"five_hour":{}}}), 1)
                .is_none()
        );
    }

    #[test]
    fn test_extract_arg_value() {
        let cmd = r#"language_server.exe --https_server_port 0 --csrf_token cab69527-2da6-4ede-8985-3db31959c0c2 --other="val""#;
        assert_eq!(
            extract_arg_value(cmd, "--csrf_token"),
            Some("cab69527-2da6-4ede-8985-3db31959c0c2".to_string())
        );
        assert_eq!(
            extract_arg_value(cmd, "--https_server_port"),
            Some("0".to_string())
        );
        assert_eq!(
            extract_arg_value(cmd, "--other"),
            Some("val".to_string())
        );
        assert_eq!(extract_arg_value(cmd, "--nonexistent"), None);
    }

    #[test]
    fn test_decode_codex_usage() {
        let raw = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 21,
                    "limit_window_seconds": 18000,
                    "reset_at": 1788421673
                },
                "secondary_window": {
                    "used_percent": 19,
                    "limit_window_seconds": 604800,
                    "reset_at": 1788961479
                }
            }
        });

        let summary = decode_codex_usage(&raw, 1000);
        assert_eq!(summary.harness, "codex");
        assert!(summary.connected);
        assert_eq!(summary.plan_label.as_deref(), Some("Plus"));

        let primary = summary.primary.expect("primary should exist");
        assert_eq!(primary.label, "5-Hour Window");
        assert_eq!(primary.percent, 21.0);
        assert!(primary.resets_at.is_some());

        assert_eq!(summary.details.len(), 1);
        assert_eq!(summary.details[0].label, "Weekly Window");
        assert_eq!(summary.details[0].percent, 19.0);
    }

    #[test]
    fn test_decode_antigravity_quota_summary() {
        let raw = serde_json::json!({
            "response": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {
                                "bucketId": "gemini-weekly",
                                "displayName": "Weekly Limit Remaining",
                                "window": "weekly",
                                "remainingFraction": 0.7497,
                                "resetTime": "2026-09-08T04:14:11Z"
                            },
                            {
                                "bucketId": "gemini-5h",
                                "displayName": "Five Hour Limit Remaining",
                                "window": "5h",
                                "remainingFraction": 0.8017,
                                "resetTime": "2026-09-03T06:11:00Z"
                            }
                        ]
                    },
                    {
                        "displayName": "Claude and GPT models",
                        "buckets": [
                            {
                                "bucketId": "3p-5h",
                                "displayName": "Five Hour Limit Remaining",
                                "window": "5h",
                                "remainingFraction": 1.0,
                                "resetTime": "2026-09-03T08:13:52Z"
                            }
                        ]
                    }
                ]
            }
        });

        let summary = decode_antigravity_quota_summary(&raw, Some("Google AI Pro".to_string()), 2000);
        assert_eq!(summary.harness, "antigravity");
        assert!(summary.connected);
        assert_eq!(summary.plan_label.as_deref(), Some("Google AI Pro"));

        let primary = summary.primary.expect("primary should exist");
        assert_eq!(primary.label, "Gemini (5h)");
        assert!((primary.percent - 19.8).abs() < 0.1);
        assert_eq!(primary.resets_at.as_deref(), Some("2026-09-03T06:11:00Z"));

        assert_eq!(summary.details.len(), 2);
        assert_eq!(summary.details[0].label, "Gemini (Weekly)");
        assert!((summary.details[0].percent - 25.0).abs() < 0.1);
        assert_eq!(summary.details[1].label, "Claude/GPT (5h)");
        assert_eq!(summary.details[1].percent, 0.0);
    }

    #[test]
    fn test_unknown_harness() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = get_harness_quota("cursor".to_string(), None).await;
            assert_eq!(res, Ok(None));
            let res2 = get_harness_quota("hermes".to_string(), None).await;
            assert_eq!(res2, Ok(None));
        });
    }

    #[test]
    fn test_decode_claude_usage() {
        let raw = serde_json::json!({
            "five_hour": { "utilization": 37.0, "resets_at": "2026-09-29T15:00:00.123456+00:00" },
            "seven_day": { "utilization": 12.5, "resets_at": "2026-10-03T04:00:00+00:00" },
            "seven_day_opus": null,
            "seven_day_sonnet": { "utilization": 4.0, "resets_at": null },
            "extra_usage": { "is_enabled": false }
        });

        let summary = decode_claude_usage(&raw, Some("Max 5x".to_string()), 1000);
        assert_eq!(summary.harness, "claude");
        assert!(summary.connected);
        assert_eq!(summary.plan_label.as_deref(), Some("Max 5x"));

        let primary = summary.primary.expect("primary should exist");
        assert_eq!(primary.label, "5-Hour Window");
        assert_eq!(primary.percent, 37.0);
        assert_eq!(
            primary.resets_at.as_deref(),
            Some("2026-09-29T15:00:00.123456+00:00")
        );

        assert_eq!(summary.details.len(), 2);
        assert_eq!(summary.details[0].label, "Weekly Window");
        assert_eq!(summary.details[0].percent, 12.5);
        assert_eq!(summary.details[1].label, "Weekly Sonnet");
        assert_eq!(summary.details[1].resets_at, None);
    }

    #[test]
    fn test_decode_claude_usage_promotes_weekly_when_five_hour_missing() {
        let raw = serde_json::json!({
            "five_hour": null,
            "seven_day": { "utilization": 150.0, "resets_at": "2026-10-03T04:00:00+00:00" }
        });
        let summary = decode_claude_usage(&raw, None, 1);
        let primary = summary.primary.expect("weekly should become primary");
        assert_eq!(primary.label, "Weekly Window");
        assert_eq!(primary.percent, 100.0);
        assert!(summary.details.is_empty());
    }

    #[test]
    fn test_decode_claude_usage_reads_scoped_weekly_windows() {
        let raw = serde_json::json!({
            "five_hour": { "utilization": 10.0, "resets_at": null },
            "seven_day": { "utilization": 20.0, "resets_at": null },
            "seven_day_opus": { "utilization": 30.0, "resets_at": null },
            "limits": [
                { "kind": "weekly_scoped", "scope": { "model": { "display_name": "Opus" } },
                  "percent": 30.0, "resets_at": "2026-10-03T04:00:00+00:00" },
                { "kind": "weekly_scoped", "scope": { "model": { "id": "fable-5" } },
                  "percent": 55.5, "resets_at": "2026-10-03T04:00:00+00:00" },
                { "kind": "weekly_scoped", "scope": { "model": { "display_name": "  " } }, "percent": 9.0 },
                { "kind": "session", "percent": 99.0 }
            ]
        });
        let summary = decode_claude_usage(&raw, None, 1);
        let labels: Vec<&str> = summary.details.iter().map(|d| d.label.as_str()).collect();
        // "Weekly Opus" already comes from the legacy field and must not repeat.
        assert_eq!(labels, ["Weekly Window", "Weekly Opus", "Weekly fable-5"]);
        assert_eq!(summary.details[2].percent, 55.5);
    }

    #[test]
    fn test_claude_cooldown_secs_honours_retry_after_within_bounds() {
        assert_eq!(claude_cooldown_secs(None), CLAUDE_COOLDOWN_DEFAULT_SECS);
        assert_eq!(
            claude_cooldown_secs(Some("garbage")),
            CLAUDE_COOLDOWN_DEFAULT_SECS
        );
        assert_eq!(claude_cooldown_secs(Some("1500")), 1500);
        assert_eq!(claude_cooldown_secs(Some("5")), CLAUDE_COOLDOWN_MIN_SECS);
        assert_eq!(
            claude_cooldown_secs(Some("999999")),
            CLAUDE_COOLDOWN_MAX_SECS
        );
    }

    #[test]
    fn test_claude_cooldown_is_scoped_to_the_credential_it_was_armed_for() {
        let state = ClaudePersistedState {
            last_good: None,
            retry_at: Some(2000),
            cooldown_token_expires_at_ms: Some(111),
        };
        assert_eq!(state.cooldown_remaining(Some(111), 1500), Some(500));
        // Expired cooldown, and a different (re-logged-in) credential, both clear it.
        assert_eq!(state.cooldown_remaining(Some(111), 2000), None);
        assert_eq!(state.cooldown_remaining(Some(222), 1500), None);
        assert_eq!(state.cooldown_remaining(None, 1500), None);
    }

    #[test]
    fn test_claude_fallback_prefers_recent_last_good_and_ignores_stale() {
        let good = decode_claude_usage(
            &serde_json::json!({ "five_hour": { "utilization": 40.0, "resets_at": null } }),
            None,
            1_000_000,
        );
        let state = ClaudePersistedState {
            last_good: Some(good.clone()),
            ..Default::default()
        };
        assert_eq!(claude_fallback_summary(&state, 1_000_600), good);

        let stale_now = 1_000_000 + CLAUDE_LAST_GOOD_MAX_AGE_SECS + 1;
        let fallback = claude_fallback_summary(&state, stale_now);
        assert!(fallback.connected);
        assert!(fallback.primary.is_none());
    }

    #[test]
    fn claude_cache_cannot_cross_credentials_or_window_resets() {
        let mut entry = QuotaCacheEntry {
            summary: decode_claude_usage(
                &serde_json::json!({"five_hour":{"utilization":42}}),
                None,
                1000,
            ),
            cached_at: 1000,
            backoff_until: 0,
        };
        assert!(reusable_claude_entry("a", &entry, "a", false, 1100));
        assert!(!reusable_claude_entry("a", &entry, "b", false, 1100));
        assert!(!reusable_claude_entry("a", &entry, "a", true, 1100));
        assert!(!reusable_claude_entry("a", &entry, "a", false, 1120));
        entry.backoff_until = 1050;
        assert!(!reusable_claude_entry("a", &entry, "a", false, 1100));
        entry.backoff_until = 0;
        entry.summary.primary.as_mut().unwrap().resets_at =
            Some(DateTime::from_timestamp(1050, 0).unwrap().to_rfc3339());
        assert!(!reusable_claude_entry("a", &entry, "a", false, 1100));
    }

    #[test]
    fn claude_fallback_drops_reset_windows_and_future_readings() {
        let summary = decode_claude_usage(
            &serde_json::json!({
                "five_hour":{"utilization":90,"resets_at":"1970-01-01T00:18:20Z"},
                "seven_day":{"utilization":40,"resets_at":"1970-01-01T00:33:20Z"}
            }),
            None,
            1000,
        );
        let state = ClaudePersistedState {
            last_good: Some(summary),
            ..Default::default()
        };
        assert!(state.fresh_last_good(999).is_none());
        let fallback = state.fresh_last_good(1100).unwrap();
        assert_eq!(fallback.primary.unwrap().label, "Weekly Window");
        assert!(fallback.details.is_empty());
        assert!(state.fresh_last_good(2000).is_none());
    }

    #[test]
    fn test_claude_state_round_trips_and_tolerates_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("oc-claw-quota-test-{}", std::process::id()));
        let path = dir.join(CLAUDE_STATE_FILE);
        let state = ClaudePersistedState {
            last_good: Some(decode_claude_usage(
                &serde_json::json!({ "five_hour": { "utilization": 12.0, "resets_at": null } }),
                Some("Pro".to_string()),
                42,
            )),
            retry_at: Some(9999),
            cooldown_token_expires_at_ms: Some(7),
        };
        save_claude_state(&path, &state);
        assert_eq!(load_claude_state(&path), state);

        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_claude_state(&path), ClaudePersistedState::default());
        assert_eq!(
            load_claude_state(&dir.join("missing.json")),
            ClaudePersistedState::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_claude_credentials() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1788421673000,"scopes":["user:profile"],"subscriptionType":"max","rateLimitTier":"default_claude_max_5x"}}"#;
        let creds = parse_claude_credentials(raw).expect("credentials should parse");
        assert_eq!(creds.access_token, "tok");
        assert_eq!(creds.expires_at_ms, Some(1788421673000));
        assert_eq!(claude_plan_label(&creds).as_deref(), Some("Max 5x"));

        assert!(parse_claude_credentials(r#"{"claudeAiOauth":{"accessToken":"  "}}"#).is_none());
        assert!(parse_claude_credentials(r#"{"other":{}}"#).is_none());
        assert!(parse_claude_credentials("not json").is_none());

        let pro = parse_claude_credentials(
            r#"{"claudeAiOauth":{"accessToken":"t","subscriptionType":"pro"}}"#,
        )
        .unwrap();
        assert_eq!(claude_plan_label(&pro).as_deref(), Some("Pro"));
    }

    #[tokio::test]
    async fn test_live_get_harness_quota_antigravity() {
        let res = get_harness_quota("antigravity".to_string(), Some(true)).await;
        assert!(res.is_ok(), "Expected Ok result, got: {:?}", res);
        let summary_opt = res.unwrap();
        assert!(summary_opt.is_some(), "Expected Some(summary)");
        let summary = summary_opt.unwrap();
        println!("Live Antigravity summary: {:?}", summary);
        assert_eq!(summary.harness, "antigravity");
        if summary.connected {
            assert!(summary.primary.is_some(), "Connected Antigravity should have primary window");
        }

        // A second forced refresh remains valid whether a live endpoint was
        // cached or no Antigravity process exists on this machine.
        let res2 = get_harness_quota("antigravity".to_string(), Some(true)).await;
        let summary2 = res2
            .expect("Second forced refresh should succeed")
            .expect("Second forced refresh should return a summary");
        assert_eq!(summary2.harness, "antigravity");
    }

    #[tokio::test]
    async fn test_live_get_harness_quota_codex() {
        let res = get_harness_quota("codex".to_string(), Some(true)).await;
        assert!(res.is_ok(), "Expected Ok result, got: {:?}", res);
        let summary_opt = res.unwrap();
        assert!(summary_opt.is_some(), "Expected Some(summary)");
        let summary = summary_opt.unwrap();
        println!("Live Codex summary: {:?}", summary);
        assert_eq!(summary.harness, "codex");
    }
}
