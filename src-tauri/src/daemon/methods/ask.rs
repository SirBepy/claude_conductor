//! Daemon-side Ask threads: the read-only sidecar runs behind the chat
//! dashboard's Answers card. The daemon owns the store and the sidecar spawn;
//! `methods/answers.rs` sends through `ask_send_with`, and `ask_list_threads` is
//! how the card reads the threads back (`ipc/ask.rs` is its desktop proxy).

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use crate::ask::{sidecar, store, turns, warm};
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
/// thread. `context` says which answer or question card a thread is about: it
/// opens a new thread's first prompt and the seed of a recycled one, and is never
/// stored, so the thread shows what Joe typed. The question runs on the thread's
/// warm process (`ask::warm`), and `on_delta` gets the reply so far as it streams.
pub(crate) async fn ask_send_with(
    session_id: &str,
    thread_id: Option<&str>,
    question: &str,
    cwd: Option<&str>,
    context: Option<&str>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<store::AskThread, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("question is empty".to_string());
    }

    let threads = store::load(session_id);
    let (thread_id, resume, history) = match thread_id {
        Some(id) => {
            let t = threads.iter().find(|t| t.id == id).ok_or_else(|| format!("no Ask thread {id}"))?;
            (t.id.clone(), t.sidecar_session_id.clone(), t.messages.clone())
        }
        None => (uuid::Uuid::new_v4().to_string(), None, Vec::new()),
    };
    let transcript = crate::chat::history::locate_transcript(session_id, cwd).ok();
    let context = context.map(str::trim).filter(|c| !c.is_empty());
    let lead = context.map(|c| format!("{c}\n\n")).unwrap_or_default();

    let first = sidecar::build_prompt(&format!("{lead}{question}"), transcript.as_deref(), cwd);
    let (follow, seed, since) = if resume.is_none() {
        turns::start(&thread_id, transcript.as_deref());
        (first.clone(), first.clone(), None)
    } else {
        let since = turns::since_last(&thread_id, transcript.as_deref());
        let seed_question = format!("{lead}{}{}His new question:\n{question}", earlier(&history), since.text);
        (
            format!("{}His follow-up:\n{question}", since.text),
            sidecar::build_prompt(&seed_question, transcript.as_deref(), cwd),
            Some(since),
        )
    };
    let answer = warm::send(
        warm::Turn { thread_id: &thread_id, resume: resume.as_deref(), first: &first, follow: &follow, seed: &seed },
        on_delta,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    if let Some(since) = since {
        since.commit(&thread_id);
    }

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

/// The thread so far, for a recycled process that starts without it. The newest
/// exchanges win when it is long; the tool output the old process read is not
/// carried, only what was said.
fn earlier(history: &[store::AskMessage]) -> String {
    const MAX: usize = 12_000;
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0;
    for m in history.iter().rev() {
        let who = if m.role == "user" { "Joe" } else { "You" };
        let line = format!("{who}: {}", m.text.trim());
        if total + line.len() > MAX && !lines.is_empty() {
            break;
        }
        total += line.len() + 1;
        lines.push(line);
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.reverse();
    format!("Earlier in this thread:\n{}\n\n", lines.join("\n"))
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
        let err = ask_send_with("sid", None, "   ", None, None, &mut |_: &str| {}).await.unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[tokio::test]
    async fn ask_send_rejects_unknown_thread_before_spawning() {
        let err = ask_send_with("sid", Some("no-such-thread"), "hi", None, None, &mut |_: &str| {}).await.unwrap_err();
        assert!(err.contains("no Ask thread"), "{err}");
    }

    #[test]
    fn a_recycled_thread_is_seeded_with_what_was_said_newest_kept() {
        let m = |role: &str, text: String| store::AskMessage { role: role.to_string(), text, ts: 0 };
        assert_eq!(earlier(&[]), "");
        let short = earlier(&[m("user", "why?".into()), m("assistant", "Because.".into())]);
        assert_eq!(short, "Earlier in this thread:\nJoe: why?\nYou: Because.\n\n");
        let long: Vec<_> = (0..20).map(|i| m("user", format!("{i} {}", "x".repeat(1_000)))).collect();
        let out = earlier(&long);
        assert!(out.contains("Joe: 19 ") && !out.contains("Joe: 0 "), "the newest exchanges are kept");
    }
}
