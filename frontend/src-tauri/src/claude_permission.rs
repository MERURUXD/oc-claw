//! Claude's blocking hook relay. Register before publishing the UI event and
//! scope both decisions and timeout cleanup to the connection's request ID.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

pub const WAIT_SECS: u64 = 600;
pub const HOOK_TIMEOUT_SECS: u64 = WAIT_SECS + 30;
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

pub struct PendingPermission {
    request_id: String,
    sender: mpsc::Sender<String>,
}
pub type PendingPermissions = Arc<Mutex<HashMap<String, PendingPermission>>>;

pub struct Connection {
    pub session_id: String,
    pub request_id: String,
    pub receiver: mpsc::Receiver<String>,
}

pub fn prepare(buf: &str, pending: &PendingPermissions) -> (String, Option<Connection>) {
    let Ok(mut event) = serde_json::from_str::<Value>(buf.trim_start_matches('\u{feff}').trim())
    else {
        return (buf.to_owned(), None);
    };
    let name = event
        .get("event")
        .or_else(|| event.get("hook_event_name"))
        .and_then(Value::as_str);
    let source = event.get("source").and_then(Value::as_str).unwrap_or("cc");
    if name != Some("PermissionRequest") || source != "cc" {
        return (buf.to_owned(), None);
    }
    let Some(sid) = event
        .get("sessionId")
        .or_else(|| event.get("session_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        return (buf.to_owned(), None);
    };
    let request_id = format!("claude:{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = mpsc::channel();
    pending.lock().unwrap().insert(
        sid.clone(),
        PendingPermission {
            request_id: request_id.clone(),
            sender,
        },
    );
    event["request_id"] = Value::String(request_id.clone());
    (
        event.to_string(),
        Some(Connection {
            session_id: sid,
            request_id,
            receiver,
        }),
    )
}

pub fn cleanup(pending: &PendingPermissions, session_id: &str, request_id: &str) {
    let mut map = pending.lock().unwrap();
    if map
        .get(session_id)
        .is_some_and(|p| p.request_id == request_id)
    {
        map.remove(session_id);
    }
}

pub fn resolve(
    pending: &PendingPermissions,
    session_id: &str,
    request_id: &str,
    response: String,
) -> Result<(), String> {
    let mut map = pending.lock().map_err(|e| e.to_string())?;
    let entry = map
        .get(session_id)
        .ok_or("Approval hook is no longer connected; approve in Claude")?;
    if entry.request_id != request_id {
        return Err("This approval has been replaced; use the current request".into());
    }
    entry
        .sender
        .send(response)
        .map_err(|_| "Approval hook disconnected; approve in Claude".to_string())?;
    map.remove(session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relay_is_ready_before_event_publication_and_old_requests_cannot_resolve_or_remove_new_ones()
    {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let input = json!({"session_id":"s", "hook_event_name":"PermissionRequest"}).to_string();
        let (event, a) = prepare(&input, &pending);
        let a = a.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap()["request_id"],
            a.request_id
        );
        resolve(&pending, "s", &a.request_id, "allow".into()).unwrap();
        assert_eq!(a.receiver.recv().unwrap(), "allow");
        let (_, b) = prepare(&input, &pending);
        let b = b.unwrap();
        assert!(resolve(&pending, "s", &a.request_id, "deny".into()).is_err());
        cleanup(&pending, "s", &a.request_id);
        resolve(&pending, "s", &b.request_id, "deny".into()).unwrap();
        assert_eq!(b.receiver.recv().unwrap(), "deny");
        assert!(resolve(&pending, "s", &b.request_id, "allow".into()).is_err());
    }

    #[test]
    fn unavailable_hook_and_other_harnesses_never_accept_a_claude_decision() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        for source in ["codex", "antigravity", "cursor"] {
            let event =
                json!({"source":source,"session_id":"s","hook_event_name":"PermissionRequest"})
                    .to_string();
            assert!(prepare(&event, &pending).1.is_none());
        }
        assert!(resolve(&pending, "s", "missing", "allow".into()).is_err());
        let (_, connection) = prepare(r#"{"sessionId":"s","event":"PermissionRequest"}"#, &pending);
        let connection = connection.unwrap();
        drop(connection.receiver);
        assert!(resolve(&pending, "s", &connection.request_id, "allow".into()).is_err());
    }
}
