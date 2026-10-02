//! Read Desktop-owned metadata. No credentials, network calls, or lifecycle inference.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct Snapshot {
    pub titles: HashMap<String, String>,
    pub usage: Option<Usage>,
}

#[derive(Clone)]
pub struct Usage {
    pub sampled_at: u64,
    pub windows: Vec<(String, f64)>,
}

pub(crate) fn json_file(path: &Path) -> Option<Value> {
    // Session metadata can contain tool schemas. Bound reads; the snapshot
    // caller selects title/history fields only. Credential decoding is owned
    // separately by claude_desktop_auth.
    if std::fs::metadata(path).ok()?.len() > 2 * 1024 * 1024 {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub(crate) fn roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = dirs::config_dir() {
        roots.push(dir.join("Claude"));
    }
    #[cfg(windows)]
    if let Some(dir) = dirs::data_local_dir() {
        // Store apps redirect their roaming data into their package. Discover
        // the installed family rather than embedding one publisher's suffix.
        if let Ok(entries) = std::fs::read_dir(dir.join("Packages")) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("Claude_") {
                    roots.push(entry.path().join("LocalCache/Roaming/Claude"));
                }
            }
        }
    }
    roots.retain(|p| p.join("config.json").is_file());
    roots.sort_by_key(|p| {
        std::fs::metadata(p.join("config.json"))
            .and_then(|m| m.modified())
            .ok()
    });
    roots
}

fn read_snapshot(root: &Path) -> Snapshot {
    let mut snapshot = Snapshot::default();
    let Some(config) = json_file(&root.join("config.json")) else {
        return snapshot;
    };
    let Some(account) = config["lastKnownAccountUuid"].as_str() else {
        return snapshot;
    };
    // This ID becomes a single directory component, never an arbitrary path.
    if account.is_empty()
        || !account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return snapshot;
    }
    let mut organizations = HashSet::new();
    let mut title_times = HashMap::new();
    if let Ok(orgs) = std::fs::read_dir(root.join("claude-code-sessions").join(account)) {
        for org in orgs.flatten().filter(|e| e.path().is_dir()) {
            organizations.insert(org.file_name().to_string_lossy().into_owned());
            let Ok(files) = std::fs::read_dir(org.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("local_") || !name.ends_with(".json") {
                    continue;
                }
                let Some(row) = json_file(&file.path()) else {
                    continue;
                };
                if let Some((id, title, time)) = session_title(&row) {
                    if title_times.get(id).is_none_or(|previous| time >= *previous) {
                        title_times.insert(id.to_owned(), time);
                        snapshot.titles.insert(id.to_owned(), title.to_owned());
                    }
                }
            }
        }
    }
    // The history is organization-scoped. If this account has multiple orgs,
    // the cache does not establish which is selected: do not guess or mix them.
    if organizations.len() == 1 {
        if let Some(history) = json_file(&root.join("plan-usage-history.json")) {
            snapshot.usage = decode_history(&history, organizations.iter().next().unwrap());
        }
    }
    snapshot
}

fn session_title(row: &Value) -> Option<(&str, &str, u64)> {
    let id = row["cliSessionId"].as_str()?.trim();
    let title = row["title"].as_str()?.trim();
    if id.is_empty() || title.is_empty() {
        return None;
    }
    Some((id, title, row["lastActivityAt"].as_u64().unwrap_or(0)))
}

fn decode_history(history: &Value, org: &str) -> Option<Usage> {
    if history["version"].as_u64() != Some(2) {
        return None;
    }
    let sample = history["samples"]
        .as_array()?
        .iter()
        .filter(|s| s["org"].as_str() == Some(org))
        .max_by_key(|s| s["t"].as_u64().unwrap_or(0))?;
    let sampled_at = sample["t"].as_u64()? / 1000;
    let mut windows = Vec::new();
    for (key, label) in [
        ("fh", "5小时"),
        ("sd", "7天"),
        ("so", "7天 · Opus"),
        ("sn", "7天 · Sonnet"),
        ("oa", "7天 · OAuth 应用"),
        ("cw", "7天 · Cowork"),
    ] {
        if let Some(percent) = sample["u"][key]
            .as_f64()
            .filter(|v| (0.0..=100.0).contains(v))
        {
            windows.push((label.into(), percent));
        }
    }
    // An empty latest reading supersedes earlier data; never resurrect it.
    (!windows.is_empty()).then_some(Usage {
        sampled_at,
        windows,
    })
}

static CACHE: LazyLock<Mutex<Option<(Instant, Snapshot)>>> = LazyLock::new(|| Mutex::new(None));

pub fn snapshot() -> Snapshot {
    let mut cache = CACHE.lock().unwrap();
    if let Some((time, snapshot)) = cache.as_ref() {
        if time.elapsed() < Duration::from_secs(2) {
            return snapshot.clone();
        }
    }
    let snapshot = roots().last().map(|r| read_snapshot(r)).unwrap_or_default();
    *cache = Some((Instant::now(), snapshot.clone()));
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn desktop_titles_use_cli_identity_and_not_workspace_or_host_id() {
        let row = json!({"sessionId":"local_host", "cliSessionId":"cli", "title":"真实标题", "lastActivityAt":10});
        assert_eq!(session_title(&row), Some(("cli", "真实标题", 10)));
        assert!(session_title(&json!({"sessionId":"host","title":"wrong"})).is_none());
    }

    #[test]
    fn history_is_scoped_latest_and_preserves_zero_without_inventing_resets() {
        let mut history = json!({"version":2,"samples":[
            {"t":1000000,"org":"a","u":{"fh":30,"sd":40}},
            {"t":2000000,"org":"b","u":{"fh":90}},
            {"t":1500000,"org":"a","u":{"fh":0,"sd":44,"sn":101}}
        ]});
        let usage = decode_history(&history, "a").unwrap();
        assert_eq!(usage.sampled_at, 1500);
        assert_eq!(
            usage.windows,
            vec![("5小时".into(), 0.0), ("7天".into(), 44.0)]
        );
        history["samples"]
            .as_array_mut()
            .unwrap()
            .push(json!({"t":2500000,"org":"a","u":{}}));
        assert!(decode_history(&history, "a").is_none());
        history["version"] = json!(1);
        assert!(decode_history(&history, "b").is_none());
    }

    #[test]
    fn snapshot_updates_titles_and_rejects_ambiguous_org_and_account_paths() {
        let root = std::env::temp_dir().join(format!("oc-claw-desktop-{}", std::process::id()));
        let sessions = root.join("claude-code-sessions/account/org");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            root.join("config.json"),
            r#"{"lastKnownAccountUuid":"account"}"#,
        )
        .unwrap();
        let path = sessions.join("local_host.json");
        std::fs::write(&path, r#"{"cliSessionId":"cli","title":"First"}"#).unwrap();
        std::fs::write(
            root.join("plan-usage-history.json"),
            r#"{"version":2,"samples":[{"org":"org","t":1000000,"u":{"fh":0}}]}"#,
        )
        .unwrap();
        assert_eq!(read_snapshot(&root).titles["cli"], "First");
        assert!(read_snapshot(&root).usage.is_some());
        std::fs::write(&path, r#"{"cliSessionId":"cli","title":"Renamed"}"#).unwrap();
        assert_eq!(read_snapshot(&root).titles["cli"], "Renamed");
        std::fs::create_dir_all(root.join("claude-code-sessions/account/other-org")).unwrap();
        assert!(read_snapshot(&root).usage.is_none());
        std::fs::write(
            root.join("config.json"),
            r#"{"lastKnownAccountUuid":"../account"}"#,
        )
        .unwrap();
        assert!(read_snapshot(&root).titles.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
