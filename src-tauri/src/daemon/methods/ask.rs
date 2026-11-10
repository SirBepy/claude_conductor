//! Daemon-side Ask threads: the read-only sidecar runs behind the chat
//! dashboard's Answers card. The daemon owns the store and the sidecar spawn;
//! `methods/answers.rs` sends through `ask_send_with`, and `ask_list_threads` is
//! how the card reads the threads back (`ipc/ask.rs` is its desktop proxy).

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

/// Serializes the read-modify-write of a chat's thread list after a sidecar run.
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs one question and persists both sides. `thread_id` `None` starts a new
/// thread; an existing `sidecar_session_id` is what makes a follow-up a resume.
/// `context` is put ahead of the question in the prompt of a thread's FIRST
/// question only (a follow-up resumes a session that already holds it) and is
/// never stored, so the thread shows what Joe typed. The Answers card uses it to
/// say which answer or question card a thread is about.
pub(crate) async fn ask_send_with(
    session_id: &str,
    thread_id: Option<&str>,
    question: &str,
    cwd: Option<&str>,
    context: Option<&str>,
) -> Result<store::AskThread, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("question is empty".to_string());
    }

    let threads = store::load(session_id);
    let (thread_id, resume) = match thread_id {
        Some(id) => {
            let t = threads.iter().find(|t| t.id == id).ok_or_else(|| format!("no Ask thread {id}"))?;
            (t.id.clone(), t.sidecar_session_id.clone())
        }
        None => (uuid::Uuid::new_v4().to_string(), None),
    };
    let transcript = crate::chat::history::locate_transcript(session_id, cwd).ok();
    let fresh_id = uuid::Uuid::new_v4().to_string();

    let prompted = match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) if resume.is_none() => format!("{c}\n\n{question}"),
        _ => question.to_string(),
    };
    let answer = sidecar::ask(
        &prompted,
        transcript.as_deref(),
        cwd,
        resume.as_deref(),
        &fresh_id,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;

    // Read again after the sidecar's run, under a lock: another thread of this
    // chat (the Answers card runs several at once) may have been saved
    // meanwhile, and saving the list read before the run would drop it.
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut threads = store::load(session_id);
    let idx = match threads.iter().position(|t| t.id == thread_id) {
        Some(i) => i,
        None => {
            threads.insert(0, store::AskThread::new(thread_id.clone(), now_ms()));
            0
        }
    };
    let t = &mut threads[idx];
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
    Ok(out)
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ask_send_rejects_empty_question() {
        let err = ask_send_with("sid", None, "   ", None, None).await.unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[tokio::test]
    async fn ask_send_rejects_unknown_thread_before_spawning() {
        let err = ask_send_with("sid", Some("no-such-thread"), "hi", None, None).await.unwrap_err();
        assert!(err.contains("no Ask thread"), "{err}");
    }
}
