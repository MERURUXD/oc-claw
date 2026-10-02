//! Read Claude-owned titles without treating transcript writes as lifecycle events.
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
}

fn text(row: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        row.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

#[derive(Clone, Default)]
struct Titles {
    custom: Option<String>,
    summary: Option<String>,
}

fn scan_titles(mut reader: impl BufRead, session_id: &str, titles: &mut Titles) -> u64 {
    let mut consumed = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(n) = reader.read_line(&mut line) else {
            break;
        };
        if n == 0 {
            break;
        }
        // A writer may have appended only part of a record. Re-read it next time.
        if !line.ends_with('\n') {
            break;
        }
        consumed += n as u64;
        if !line.contains("customTitle") && !line.contains("\"summary\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if row
            .get("sessionId")
            .or_else(|| row.get("session_id"))
            .and_then(Value::as_str)
            .is_some_and(|id| id != session_id)
        {
            continue;
        }
        match row["type"].as_str() {
            Some("custom-title") => {
                if let Some(title) = text(&row, &["customTitle"]) {
                    titles.custom = Some(title);
                }
            }
            Some("summary") => {
                if let Some(title) = text(&row, &["summary"]) {
                    titles.summary = Some(title);
                }
            }
            _ => {}
        }
    }
    consumed
}

#[cfg(test)]
fn transcript_title(reader: impl BufRead, session_id: &str) -> Option<String> {
    let mut titles = Titles::default();
    scan_titles(reader, session_id, &mut titles);
    titles.custom.or(titles.summary)
}

#[derive(Clone)]
struct CachedTitle {
    stamp: (u64, Option<std::time::SystemTime>),
    offset: u64,
    titles: Titles,
}
static TITLES: std::sync::LazyLock<Mutex<std::collections::HashMap<PathBuf, CachedTitle>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

pub fn read_title(path: &Path, session_id: &str, native_title: Option<&str>) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let metadata = std::fs::metadata(path).ok()?;
    let stamp = (metadata.len(), metadata.modified().ok());
    let mut cache = TITLES.lock().unwrap();
    let cached = cache.get(path).cloned();
    let mut entry = cached.clone().unwrap_or(CachedTitle {
        stamp,
        offset: 0,
        titles: Titles::default(),
    });
    if cached.as_ref().is_none_or(|c| c.stamp != stamp) {
        // Claude appends JSONL records. Retain metadata and scan only new complete
        // records; long sessions must not re-read the whole transcript each poll.
        if cached.as_ref().is_some_and(|c| stamp.0 <= c.stamp.0) {
            entry.offset = 0;
            entry.titles = Titles::default();
        }
        let mut file = std::fs::File::open(path).ok()?;
        file.seek(SeekFrom::Start(entry.offset)).ok()?;
        entry.offset += scan_titles(BufReader::new(file), session_id, &mut entry.titles);
        entry.stamp = stamp;
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(path.to_owned(), entry.clone());
    }
    let mut index_custom = None;
    let mut index_summary = None;
    if let Some(index_path) = path.parent().map(|p| p.join("sessions-index.json")) {
        if let Ok(raw) = std::fs::read_to_string(index_path) {
            if let Ok(index) = serde_json::from_str::<Value>(&raw) {
                if let Some(row) = index["entries"].as_array().and_then(|rows| {
                    rows.iter()
                        .find(|r| r["sessionId"].as_str() == Some(session_id))
                }) {
                    index_custom = text(row, &["customTitle"]);
                    index_summary = text(row, &["summary"]);
                }
            }
        }
    }
    // Live native name takes precedence over summaries; transcript /rename is
    // newer than a potentially stale index and must continue to update.
    entry
        .titles
        .custom
        .or_else(|| native_title.map(str::to_owned))
        .or(index_custom)
        .or(entry.titles.summary)
        .or(index_summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_rename_wins_over_summaries_and_foreign_session_metadata() {
        let records = r#"{"type":"summary","summary":"Generated title"}
{"type":"custom-title","customTitle":"First name","sessionId":"s"}
{"type":"custom-title","customTitle":"Renamed 中文","sessionId":"s"}
{"type":"custom-title","customTitle":"Other session","sessionId":"other"}
{"type":"summary","summary":"Later compaction summary"}
{"type":"assistant","message":{"content":"customTitle summary"}}
{broken"#;
        assert_eq!(
            transcript_title(records.as_bytes(), "s").as_deref(),
            Some("Renamed 中文")
        );
        assert_eq!(
            transcript_title(
                &b"{\"type\":\"summary\",\"summary\":\"Auto title\"}\n"[..],
                "s"
            )
            .as_deref(),
            Some("Auto title")
        );
    }

    #[test]
    fn appended_metadata_partial_lines_native_names_and_index_updates_are_observed() {
        let dir = std::env::temp_dir().join(format!("oc-claw-titles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"summary\",\"summary\":\"Old summary\"}\n",
        )
        .unwrap();
        assert_eq!(
            read_title(&path, "s", Some("Live name")).as_deref(),
            Some("Live name")
        );
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Rename")
            .unwrap();
        assert_eq!(
            read_title(&path, "s", Some("Live name")).as_deref(),
            Some("Live name")
        );
        file.write_all(b"\"}\n").unwrap();
        assert_eq!(
            read_title(&path, "s", Some("Live name")).as_deref(),
            Some("Rename")
        );
        std::fs::write(&path, "{\"type\":\"user\"}\n").unwrap();
        let index = dir.join("sessions-index.json");
        std::fs::write(&index, r#"{"entries":[{"sessionId":"other","customTitle":"wrong"},{"sessionId":"s","summary":"Indexed name"}]}"#).unwrap();
        assert_eq!(
            read_title(&path, "s", None).as_deref(),
            Some("Indexed name")
        );
        std::fs::write(
            &index,
            r#"{"entries":[{"sessionId":"s","customTitle":"Updated index"}]}"#,
        )
        .unwrap();
        assert_eq!(
            read_title(&path, "s", None).as_deref(),
            Some("Updated index")
        );
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
