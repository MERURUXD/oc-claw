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

    let ps_exe = if std::path::Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe").is_file() {
        "pwsh.exe"
    } else {
        "powershell.exe"
    };

    let script = r#"Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language*server*' -or $_.Name -like '*agy*' } | ForEach-Object { $p = $_.ProcessId; $ports = (Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique) -join ','; "$p|||$ports|||$($_.CommandLine)" }"#;

    let mut cmd = tokio::process::Command::new(ps_exe);
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await {
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
    }
}

// ---------------------------------------------------------------------------
// Antigravity Fetcher
// ---------------------------------------------------------------------------

async fn fetch_antigravity_quota(now: u64) -> Result<(HarnessQuotaSummary, Option<u64>), String> {
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
            },
            None,
        ));
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for Antigravity: {e}"))?;

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
            // First attempt: RetrieveUserQuotaSummary
            let quota_url = format!("https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
            let mut req = client
                .post(&quota_url)
                .header("Content-Type", "application/json")
                .header("Connect-Protocol-Version", "1")
                .body("{}");

            if !csrf_token.is_empty() {
                req = req.header("X-Codeium-Csrf-Token", &csrf_token);
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
                            status_req = status_req.header("X-Codeium-Csrf-Token", &csrf_token);
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
                        return Ok((summary, None));
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
                req = req.header("X-Codeium-Csrf-Token", &csrf_token);
            }

            if let Ok(resp) = req.send().await {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        let summary = decode_antigravity_user_status(&json, now);
                        return Ok((summary, None));
                    }
                }
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
// Public Tauri Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_harness_quota(
    harness: String,
    force_refresh: Option<bool>,
) -> Result<Option<HarnessQuotaSummary>, String> {
    let harness_key = harness.trim().to_ascii_lowercase();
    if harness_key != "codex" && harness_key != "antigravity" {
        return Ok(None);
    }

    let force = force_refresh.unwrap_or(false);
    let now = unix_now();

    // Check cache and active 429 backoff
    {
        let cache = get_cache().lock().unwrap();
        if let Some(entry) = cache.get(&harness_key) {
            if entry.backoff_until > now {
                log::warn!(
                    "[harness_quota] {} is in 429 backoff until {} (remaining {}s)",
                    harness_key,
                    entry.backoff_until,
                    entry.backoff_until - now
                );
                return Ok(Some(entry.summary.clone()));
            }
            if !force && now.saturating_sub(entry.cached_at) < 300 {
                return Ok(Some(entry.summary.clone()));
            }
        }
    }

    let result = match harness_key.as_str() {
        "codex" => fetch_codex_quota(now).await,
        "antigravity" => fetch_antigravity_quota(now).await,
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
            log::error!("[harness_quota] Failed to fetch quota for {}: {}", harness_key, err);
            // Fall back to cached entry if present
            let cache = get_cache().lock().unwrap();
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
            let res2 = get_harness_quota("claude".to_string(), None).await;
            assert_eq!(res2, Ok(None));
        });
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
