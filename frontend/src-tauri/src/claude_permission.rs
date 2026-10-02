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
    sender: mpsc::Sender<Response>,
}
pub type PendingPermissions = Arc<Mutex<HashMap<String, PendingPermission>>>;

pub struct Connection {
    pub session_id: String,
    pub request_id: String,
    pub receiver: mpsc::Receiver<Response>,
}

const DELIVERY_FAILED: &str = "Approval response was not delivered; approve in Claude";

pub struct Response {
    response: String,
    delivery: tokio::sync::oneshot::Sender<Result<(), String>>,
}

impl Response {
    /// Command success means the hook socket accepted every byte and flush,
    /// not merely that the local queue accepted this response.
    pub fn deliver(self, stream: &mut impl std::io::Write) -> bool {
        let result = stream
            .write_all(self.response.as_bytes())
            .and_then(|_| stream.flush())
            .map_err(|_| DELIVERY_FAILED.to_owned());
        let delivered = result.is_ok();
        let _ = self.delivery.send(result);
        delivered
    }
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

/// A successful socket write acknowledges this relay request, not tool
/// completion. Leave lifecycle state to Claude; stale callbacks cannot clear
/// a replacement, and failed delivery only removes our unavailable controls.
pub fn finish_interaction(
    interaction: &mut Option<crate::session_activity::PendingInteraction>,
    request_id: &str,
    delivered: bool,
) -> bool {
    if !interaction
        .as_ref()
        .is_some_and(|p| p.request_id.as_deref() == Some(request_id))
    {
        return false;
    }
    if delivered {
        *interaction = None;
    } else {
        let interaction = interaction.as_mut().unwrap();
        interaction.request_id = None;
        interaction.delivery_error = Some(DELIVERY_FAILED.to_owned());
    }
    true
}

pub async fn resolve(
    pending: &PendingPermissions,
    session_id: &str,
    request_id: &str,
    response: String,
) -> Result<(), String> {
    let entry = {
        let mut map = pending.lock().map_err(|e| e.to_string())?;
        let entry = map
            .get(session_id)
            .ok_or("Approval hook is no longer connected; approve in Claude")?;
        if entry.request_id != request_id {
            return Err("This approval has been replaced; use the current request".into());
        }
        map.remove(session_id).unwrap()
    };
    let (delivery, acknowledgement) = tokio::sync::oneshot::channel();
    entry
        .sender
        .send(Response { response, delivery })
        .map_err(|_| "Approval hook disconnected; approve in Claude".to_string())?;
    acknowledgement
        .await
        .map_err(|_| DELIVERY_FAILED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn queued_response_waits_for_socket_write_and_flush_acknowledgement() {
        struct BrokenSocket {
            fail_flush: bool,
        }
        impl std::io::Write for BrokenSocket {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.fail_flush {
                    Ok(bytes.len())
                } else {
                    Err(std::io::ErrorKind::BrokenPipe.into())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        for fail_flush in [false, true] {
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let (event, connection) = prepare(
                r#"{"session_id":"s","hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
                &pending,
            );
            let connection = connection.unwrap();
            let request = connection.request_id.clone();
            let queue = pending.clone();
            let command =
                tokio::spawn(async move { resolve(&queue, "s", &request, "allow".into()).await });
            // Receiving proves mpsc send succeeded, but invoke cannot succeed yet.
            let response = tokio::task::spawn_blocking(move || connection.receiver.recv().unwrap())
                .await
                .unwrap();
            assert!(!command.is_finished());
            assert!(!response.deliver(&mut BrokenSocket { fail_flush }));
            assert_eq!(command.await.unwrap().unwrap_err(), DELIVERY_FAILED);
            let event: Value = serde_json::from_str(&event).unwrap();
            let mut interaction =
                crate::interaction_state::from_hook(&event, "PermissionRequest", "cc");
            let request = interaction.as_ref().unwrap().request_id.clone().unwrap();
            assert!(finish_interaction(&mut interaction, &request, false));
            let fallback = serde_json::to_value(interaction.unwrap()).unwrap();
            assert!(fallback.get("requestId").is_none());
            assert_eq!(fallback["deliveryError"], DELIVERY_FAILED);
        }
    }

    #[tokio::test]
    async fn lost_writer_acknowledgement_never_returns_command_success() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (_, connection) = prepare(
            r#"{"session_id":"s","event":"PermissionRequest"}"#,
            &pending,
        );
        let connection = connection.unwrap();
        let (result, ()) = tokio::join!(
            resolve(&pending, "s", &connection.request_id, "allow".into()),
            async {
                drop(connection.receiver.recv().unwrap());
            }
        );
        assert_eq!(result.unwrap_err(), DELIVERY_FAILED);
    }

    #[tokio::test]
    async fn idless_approval_survives_parallel_result_until_its_own_relay_ack() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (event, conn) = prepare(
            r#"{"session_id":"s","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"pending"}}"#,
            &pending,
        );
        let conn = conn.unwrap();
        let event: Value = serde_json::from_str(&event).unwrap();
        let mut interaction =
            crate::interaction_state::from_hook(&event, "PermissionRequest", "cc");
        assert!(crate::interaction_state::retain(
            interaction.as_ref().unwrap(),
            &json!({"tool_name":"Bash","tool_use_id":"other"}),
            "PostToolUse",
            "cc"
        ));
        let (result, ()) = tokio::join!(
            resolve(&pending, "s", &conn.request_id, "allow".into()),
            async {
                let response = conn.receiver.recv().unwrap();
                assert_eq!(response.response, "allow");
                assert!(response.deliver(&mut Vec::new()));
            }
        );
        result.unwrap();
        assert!(!finish_interaction(&mut interaction, "older", true));
        assert!(finish_interaction(&mut interaction, &conn.request_id, true));
        assert!(interaction.is_none());
        let mut replacement = crate::interaction_state::from_hook(
            &json!({"tool_name":"Bash","request_id":"replacement"}),
            "PermissionRequest",
            "cc",
        );
        assert!(!finish_interaction(
            &mut replacement,
            &conn.request_id,
            true
        ));
        assert!(finish_interaction(&mut replacement, "replacement", false));
        assert!(replacement.is_some());
        let fallback = replacement.unwrap();
        assert!(fallback.request_id.is_none());
        assert_eq!(fallback.delivery_error.as_deref(), Some(DELIVERY_FAILED));
    }

    #[tokio::test]
    async fn relay_is_ready_before_event_publication_and_old_requests_cannot_resolve_or_remove_new_ones(
    ) {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let input = json!({"session_id":"s", "hook_event_name":"PermissionRequest"}).to_string();
        let (event, a) = prepare(&input, &pending);
        let a = a.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap()["request_id"],
            a.request_id
        );
        let (result, ()) = tokio::join!(
            resolve(&pending, "s", &a.request_id, "allow".into()),
            async {
                let response = a.receiver.recv().unwrap();
                assert_eq!(response.response, "allow");
                assert!(response.deliver(&mut Vec::new()));
            }
        );
        result.unwrap();
        let (_, b) = prepare(&input, &pending);
        let b = b.unwrap();
        assert!(resolve(&pending, "s", &a.request_id, "deny".into())
            .await
            .is_err());
        cleanup(&pending, "s", &a.request_id);
        let (result, ()) = tokio::join!(
            resolve(&pending, "s", &b.request_id, "deny".into()),
            async {
                let response = b.receiver.recv().unwrap();
                assert_eq!(response.response, "deny");
                assert!(response.deliver(&mut Vec::new()));
            }
        );
        result.unwrap();
        assert!(resolve(&pending, "s", &b.request_id, "allow".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn unavailable_hook_and_other_harnesses_never_accept_a_claude_decision() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        for source in ["codex", "antigravity", "cursor"] {
            let event =
                json!({"source":source,"session_id":"s","hook_event_name":"PermissionRequest"})
                    .to_string();
            assert!(prepare(&event, &pending).1.is_none());
        }
        assert!(resolve(&pending, "s", "missing", "allow".into())
            .await
            .is_err());
        let (_, connection) = prepare(r#"{"sessionId":"s","event":"PermissionRequest"}"#, &pending);
        let connection = connection.unwrap();
        drop(connection.receiver);
        assert!(
            resolve(&pending, "s", &connection.request_id, "allow".into())
                .await
                .is_err()
        );
    }
}
