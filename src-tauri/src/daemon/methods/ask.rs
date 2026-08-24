//! Daemon-side Ask RPC. The daemon owns the store and the sidecar spawn, and
//! `ipc/ask.rs` is a thin desktop proxy - same split as `user_todos`, so the
//! phone and the desktop share one implementation instead of two.

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use crate::ask::{sidecar, store};
use serde_json::Value;
use std::sync::Arc;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Runs one question and persists both sides. `thread_id` `None` starts a new
/// thread; an existing `sidecar_session_id` is what makes a follow-up a resume.
pub(crate) async fn ask_send(
    session_id: &str,
    thread_id: Option<&str>,
    question: &str,
    cwd: Option<&str>,
) -> Result<Value, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("question is empty".to_string());
    }

    let mut threads = store::load(session_id);
    let idx = match thread_id {
        Some(id) => threads
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("no Ask thread {id}"))?,
        None => {
            let t = store::AskThread::new(uuid::Uuid::new_v4().to_string(), now_ms());
            threads.insert(0, t);
            0
        }
    };

    let resume = threads[idx].sidecar_session_id.clone();
    let transcript = crate::chat::history::locate_transcript(session_id, cwd).ok();
    let fresh_id = uuid::Uuid::new_v4().to_string();

    let answer = sidecar::ask(
        question,
        transcript.as_deref(),
        cwd,
        resume.as_deref(),
        &fresh_id,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;

    let t = &mut threads[idx];
    if t.title.is_empty() {
        t.title = store::title_from(question);
    }
    t.sidecar_session_id = Some(answer.sidecar_session_id);
    t.updated_at = now_ms();
    t.messages.push(store::AskMessage {
        role: "user".to_string(),
        text: question.to_string(),
        ts: now_ms(),
    });
    t.messages.push(store::AskMessage {
        role: "assistant".to_string(),
        text: answer.text,
        ts: now_ms(),
    });
    let out = t.clone();
    store::save(session_id, &threads).map_err(|e| format!("{e:#}"))?;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

pub fn register_ask(router: &mut Router, _state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionOnly {
        session_id: String,
    }

    router.register("ask_list_threads", move |params, _ctx| async move {
        let p: SessionOnly = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        serde_json::to_value(store::load(&p.session_id)).map_err(|e| RpcError::internal(e.to_string()))
    });

    router.register("ask_send", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            session_id: String,
            #[serde(default)]
            thread_id: Option<String>,
            question: String,
            #[serde(default)]
            cwd: Option<String>,
        }
        let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        ask_send(&p.session_id, p.thread_id.as_deref(), &p.question, p.cwd.as_deref())
            .await
            .map_err(RpcError::internal)
    });

    router.register("ask_delete_thread", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            session_id: String,
            thread_id: String,
        }
        let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let left = store::delete_thread(&p.session_id, &p.thread_id)
            .map_err(|e| RpcError::internal(format!("{e:#}")))?;
        serde_json::to_value(left).map_err(|e| RpcError::internal(e.to_string()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ask_send_rejects_empty_question() {
        let err = ask_send("sid", None, "   ", None).await.unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[tokio::test]
    async fn ask_send_rejects_unknown_thread_before_spawning() {
        let err = ask_send("sid", Some("no-such-thread"), "hi", None).await.unwrap_err();
        assert!(err.contains("no Ask thread"), "{err}");
    }
}
