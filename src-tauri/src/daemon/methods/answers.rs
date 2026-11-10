//! The chat dashboard's Answers card (docs/chat-dashboard-design.md, "Answers
//! card"): which answers Joe has read, and the threads behind them. A thread is
//! an Ask thread (`methods/ask.rs`), so a follow-up runs the read-only Ask
//! sidecar and needs no spawn path of its own.
//!
//! Desktop-pipe only: absent from `remote_transport_table::TRANSPORT_TABLE`,
//! since the phone always draws the Messages view and never shows the card.

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use crate::ask::answer_state::{self, AnswerState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the sidecar is told when Joe starts a question with the card's +: the
/// card shows a rewritten question and a verdict like every other answer, and
/// this reply is the only place they can come from. The webview parses the two
/// lines (`answers-thread.ts`) and falls back to Joe's words when they are missing.
pub(crate) const NEW_QUESTION_CONTEXT: &str = "Joe asks this from the chat dashboard's Answers card. \
Begin your reply with exactly two lines, then a blank line, then the answer:\n\
QUESTION: <his question rewritten as one clear question>\n\
VERDICT: <the answer in at most 40 characters, as a person would say it out loud>";

/// The first prompt of a thread Joe opened with a question card's Ask: the card
/// (its question and options, as the webview's `question-ask.ts` writes them) is
/// what he asks about, and the reply still opens with the two lines the card
/// parses, since it lands in Answers like a + question.
pub(crate) fn card_question_context(card: &str) -> String {
    format!(
        "Joe has a question card from his chat waiting for his answer, and asks about it before \
answering. The card:\n{}\n\n{NEW_QUESTION_CONTEXT}",
        card.trim()
    )
}

/// The first prompt of a follow-up thread on an answer the chat gave.
pub(crate) fn follow_up_context(question: &str, answer: &str) -> String {
    let mut out = String::from("Joe is following up on an answer his chat gave him.");
    if !question.trim().is_empty() {
        out.push_str(&format!("\nHis question was: {}", question.trim()));
    }
    if !answer.trim().is_empty() {
        out.push_str(&format!("\nThe answer was:\n{}", answer.trim()));
    }
    out.push_str("\nHis follow-up:");
    out
}

fn state_json(s: &AnswerState) -> Result<Value, RpcError> {
    serde_json::to_value(s).map_err(|e| RpcError::internal(e.to_string()))
}

fn parse<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

pub fn register_answers(router: &mut Router, _state: Arc<DaemonState>) {
    router.register("answers_state", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
        }
        let p: P = parse(params)?;
        state_json(&answer_state::load(&p.session_id))
    });

    router.register("answers_mark", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
            keys: Vec<String>,
            #[serde(default = "yes")]
            read: bool,
        }
        fn yes() -> bool {
            true
        }
        let p: P = parse(params)?;
        let s = answer_state::update(&p.session_id, |s| s.mark(&p.keys, p.read, now_ms()))
            .map_err(|e| RpcError::internal(format!("{e:#}")))?;
        state_json(&s)
    });

    // Blocks for the sidecar's whole run. `key` names the answer the thread
    // follows up on; no `key` starts a + question, whose thread then stands for
    // its own answer, and `about_question` on such a question is the question
    // card it was asked from.
    router.register("answers_thread_send", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
            #[serde(default)]
            key: Option<String>,
            question: String,
            #[serde(default)]
            cwd: Option<String>,
            #[serde(default)]
            about_question: String,
            #[serde(default)]
            about_answer: String,
        }
        let p: P = parse(params)?;
        let key = p.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
        // A link to a thread missing from the store (its file lost or unreadable)
        // starts a fresh thread instead of failing every later follow-up with
        // "no Ask thread".
        let existing = key
            .and_then(|k| answer_state::load(&p.session_id).thread_of(k))
            .filter(|id| crate::ask::store::load(&p.session_id).iter().any(|t| &t.id == id));
        let context = match key {
            Some(_) => follow_up_context(&p.about_question, &p.about_answer),
            None if !p.about_question.trim().is_empty() => card_question_context(&p.about_question),
            None => NEW_QUESTION_CONTEXT.to_string(),
        };
        let thread = super::ask::ask_send_with(
            &p.session_id,
            existing.as_deref(),
            &p.question,
            p.cwd.as_deref(),
            Some(&context),
        )
        .await
        .map_err(RpcError::internal)?;
        let state = answer_state::update(&p.session_id, |s| match key {
            Some(k) => s.link_thread(k, &thread.id),
            None => s.add_question(&thread.id, now_ms()),
        })
        .map_err(|e| RpcError::internal(format!("{e:#}")))?;
        Ok(json!({ "thread": thread, "state": state }))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follow_up_context_names_the_question_and_the_answer() {
        let c = follow_up_context("Does the token need write access?", "No, read-only is enough");
        assert!(c.contains("His question was: Does the token need write access?"));
        assert!(c.contains("The answer was:\nNo, read-only is enough"));
        assert!(c.ends_with("His follow-up:"));
        assert!(!follow_up_context("", "").contains("question was"));
    }

    #[test]
    fn card_question_context_carries_the_card_and_the_two_lines() {
        let c = card_question_context("  Where should the key live?\n\n- **Key modal**: in .env  ");
        assert!(c.contains("The card:\nWhere should the key live?\n\n- **Key modal**: in .env\n"));
        assert!(c.contains("\nQUESTION: ") && c.contains("\nVERDICT: "));
    }

    #[test]
    fn new_question_context_asks_for_the_two_lines_the_card_parses() {
        assert!(NEW_QUESTION_CONTEXT.contains("\nQUESTION: "));
        assert!(NEW_QUESTION_CONTEXT.contains("\nVERDICT: "));
    }
}
