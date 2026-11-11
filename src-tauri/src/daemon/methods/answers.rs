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
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};

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

/// The most a rewritten question may run to, matching `send_message`'s own `question` cap.
const QUESTION_MAX: usize = 200;
/// What the rewrite call is given of each side. A pasted log in Joe's message
/// or a long answer would only make the call slower; the question is in the
/// first part of both.
const JOE_MAX: usize = 4000;
const ANSWER_MAX: usize = 2000;

fn clip_chars(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// The prompt for the one-shot call that turns Joe's whole message into the one
/// short question the answer replies to. Joe's message often holds several
/// requests; only the part the answer addresses is the question.
pub(crate) fn rewrite_prompt(joe: &str, answer: &str) -> String {
    format!(
        "A developer sent his Claude Code chat the message below. Claude's reply follows it. The \
message may hold several requests or points; the reply answers only one question in it.\n\n\
Write that one question as a single clear sentence, in the developer's voice, at most {QUESTION_MAX} \
characters, ending with a question mark. Reply with the question alone: no quotes, no label, no \
preamble, no second line. Never use the em dash character. Do not use any tool.\n\n\
<message>\n{}\n</message>\n\n<reply>\n{}\n</reply>",
        clip_chars(joe, JOE_MAX),
        clip_chars(answer, ANSWER_MAX)
    )
}

/// The model's reply as a stored question: the first line that reads as a question
/// (after a label and wrapping quotes are removed), capped at `QUESTION_MAX`. A
/// refusal or a preamble line is skipped, and a reply with no such line is `None`,
/// so prose is never stored as an answer's question for good.
pub(crate) fn clean_question(raw: &str) -> Option<String> {
    raw.lines().map(str::trim).filter(|l| !l.is_empty()).find_map(|line| {
        let line = line.trim_start_matches(|c: char| c == '*' || c == '>' || c == '-' || c.is_whitespace());
        let line = match line.get(..9) {
            Some(head) if head.eq_ignore_ascii_case("question:") => &line[9..],
            _ => line,
        };
        let line = line.replace('\u{2014}', "-");
        let line = line.trim().trim_matches(|c: char| matches!(c, '"' | '\'' | '*' | '`' | '\u{201c}' | '\u{201d}'));
        line.ends_with('?').then(|| clip_chars(line, QUESTION_MAX))
    })
}

/// Answers whose rewrite is running now ("<chat>/<key>"), so two windows on the
/// same chat, or a reload, never start a second call for one answer.
static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct FlightGuard(String);

impl FlightGuard {
    fn enter(id: String) -> Option<Self> {
        let mut g = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        if g.get_or_insert_with(HashSet::new).insert(id.clone()) {
            Some(Self(id))
        } else {
            None
        }
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        if let Some(set) = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Writes the short question for one answer once, into the chat's answer state
/// at `path`. `run` is the model call (injected so tests use a fake). An answer
/// that already has one, or whose rewrite is already running, makes no call.
/// A failed or empty call stores nothing, so a later load tries again.
pub(crate) async fn rewrite_question<F, Fut>(
    path: &Path,
    flight_id: String,
    key: &str,
    joe: &str,
    answer: &str,
    run: F,
) -> Result<AnswerState, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let current = answer_state::load_from(path);
    if current.rewrites.contains_key(key) || joe.trim().is_empty() {
        return Ok(current);
    }
    let Some(_guard) = FlightGuard::enter(flight_id) else { return Ok(current) };
    // A call that finished between the check above and taking the guard has stored one already.
    let current = answer_state::load_from(path);
    if current.rewrites.contains_key(key) {
        return Ok(current);
    }
    let reply = run(rewrite_prompt(joe, answer)).await?;
    let question = clean_question(&reply).ok_or_else(|| "the model returned no question".to_string())?;
    answer_state::update_at(path, |s| s.set_rewrite(key, &question)).map_err(|e| format!("{e:#}"))
}

fn state_json(s: &AnswerState) -> Result<Value, RpcError> {
    serde_json::to_value(s).map_err(|e| RpcError::internal(e.to_string()))
}

fn parse<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

pub fn register_answers(router: &mut Router, state: Arc<DaemonState>) {
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

    // Blocks for one cheap model call. The card asks once per answer that has no
    // `question` of its own; the result is stored beside the read marks.
    router.register("answers_rewrite_question", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
            key: String,
            joe: String,
            #[serde(default)]
            answer: String,
        }
        let p: P = parse(params)?;
        let path = answer_state::file_for(&p.session_id).map_err(|e| RpcError::internal(format!("{e:#}")))?;
        let state = rewrite_question(
            &path,
            format!("{}/{}", p.session_id, p.key),
            &p.key,
            &p.joe,
            &p.answer,
            |prompt| async move {
                let session = uuid::Uuid::new_v4().to_string();
                // Never resumed, so it leaves no session for History to list.
                crate::ask::sidecar::run_readonly("Answer question", &prompt, None, &session, None, false)
                    .await
                    .map(|a| a.text)
                    .map_err(|e| format!("{e:#}"))
            },
        )
        .await
        .map_err(RpcError::internal)?;
        state_json(&state)
    });

    // Opening a thread: its warm process starts while Joe types (Joe, 2026-11-11:
    // "a pretty big chance im gonna be asking the thread something if i clicked
    // on the thread button"). `key` names an answer whose thread may already have
    // a session to resume; none means a new question, which gets the spare.
    router.register("answers_thread_prewarm", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
            #[serde(default)]
            key: Option<String>,
        }
        let p: P = parse(params)?;
        let key = p.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
        let thread = key
            .and_then(|k| answer_state::load(&p.session_id).thread_of(k))
            .and_then(|id| crate::ask::store::load(&p.session_id).into_iter().find(|t| t.id == id));
        let (tid, resume) = match &thread {
            Some(t) => (Some(t.id.as_str()), t.sidecar_session_id.as_deref()),
            None => (None, None),
        };
        crate::ask::warm::prewarm(tid, resume).await.map_err(|e| RpcError::internal(format!("{e:#}")))?;
        Ok(json!({ "ok": true }))
    });

    // Blocks for the sidecar's whole run, streaming the reply as
    // `answers_thread_delta` {session_id, stream_id, text} with the text so far
    // (an empty text means a retry started over). `key` names the answer the
    // thread follows up on; no `key` starts a + question, whose thread then
    // stands for its own answer, and `about_question` on such a question is the
    // question card it was asked from.
    let notifier = state.notifier.clone();
    router.register("answers_thread_send", move |params, _ctx| {
        let notifier = notifier.clone();
        async move {
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
            #[serde(default)]
            stream_id: Option<String>,
        }
        let p: P = parse(params)?;
        let key = p.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
        let mut on_delta = delta_publisher(notifier, p.session_id.clone(), p.stream_id.clone());
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
            &mut on_delta,
        )
        .await
        .map_err(RpcError::internal)?;
        let state = answer_state::update(&p.session_id, |s| match key {
            Some(k) => s.link_thread(k, &thread.id),
            None => s.add_question(&thread.id, now_ms()),
        })
        .map_err(|e| RpcError::internal(format!("{e:#}")))?;
        Ok(json!({ "thread": thread, "state": state }))
        }
    });
}

/// How often a streaming reply is pushed to the window: often enough to read as
/// live, rarely enough that a fast reply is not hundreds of events.
const DELTA_EVERY: std::time::Duration = std::time::Duration::from_millis(60);

/// Publishes the reply so far for `stream_id`, at most every `DELTA_EVERY`; an
/// empty text (a retry starting over) always goes out. No `stream_id`, nothing
/// is published: the caller does not listen.
fn delta_publisher(
    notifier: crate::daemon::notifier::Notifier,
    session_id: String,
    stream_id: Option<String>,
) -> impl FnMut(&str) + Send {
    let mut last: Option<std::time::Instant> = None;
    move |text: &str| {
        let Some(stream_id) = &stream_id else { return };
        let now = std::time::Instant::now();
        if !text.is_empty() && last.is_some_and(|t| now.duration_since(t) < DELTA_EVERY) {
            return;
        }
        last = Some(now);
        notifier.publish(
            "answers_thread_delta",
            json!({ "session_id": session_id, "stream_id": stream_id, "text": text }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_streaming_reply_is_published_throttled_and_a_restart_always_goes_out() {
        let n = crate::daemon::notifier::Notifier::new();
        let mut rx = n.subscribe();
        let mut publish = delta_publisher(n.clone(), "chat".into(), Some("s1".into()));
        publish("a");
        publish("ab");
        publish("");
        let first = rx.recv().await.unwrap();
        assert_eq!(first["method"], "answers_thread_delta");
        assert_eq!(first["params"], json!({"session_id": "chat", "stream_id": "s1", "text": "a"}));
        assert_eq!(rx.recv().await.unwrap()["params"]["text"], "", "the throttled 'ab' is skipped, the restart is not");
        assert!(rx.try_recv().is_err());

        let mut silent = delta_publisher(n.clone(), "chat".into(), None);
        silent("x");
        assert!(rx.try_recv().is_err(), "no stream id, no events");
    }

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
    fn the_rewrite_prompt_carries_both_sides_and_stays_bounded() {
        let p = rewrite_prompt("fix the build and why is the card blank?", "Because the host is hidden");
        assert!(p.contains("fix the build and why is the card blank?"));
        assert!(p.contains("Because the host is hidden"));
        let big = rewrite_prompt(&"x".repeat(50_000), &"y".repeat(50_000));
        assert!(big.len() < JOE_MAX + ANSWER_MAX + 1500);
    }

    #[test]
    fn a_model_reply_becomes_one_short_clean_question() {
        assert_eq!(clean_question("\"Why is the card blank?\"\n\nExtra").as_deref(), Some("Why is the card blank?"));
        assert_eq!(clean_question("Question: Why is it blank - really?").as_deref(), Some("Why is it blank - really?"));
        assert_eq!(clean_question("Why is it blank \u{2014} really?").as_deref(), Some("Why is it blank - really?"));
        assert_eq!(clean_question("\n  \n").as_deref(), None);
        // A preamble or a refusal is skipped; prose with no question stores nothing.
        assert_eq!(clean_question("Here is the question:\nWhy is it blank?").as_deref(), Some("Why is it blank?"));
        assert_eq!(clean_question("I cannot tell what he asked.").as_deref(), None);
        assert_eq!(clean_question(&format!("{}?", "q".repeat(500))).unwrap().chars().count(), QUESTION_MAX);
    }

    fn block_on<T>(f: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    #[test]
    fn a_rewrite_is_made_once_per_answer_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.answers.json");
        let calls = std::cell::Cell::new(0);
        let fake = |reply: &'static str| {
            let calls = &calls;
            move |_prompt: String| async move {
                calls.set(calls.get() + 1);
                Ok::<_, String>(reply.to_string())
            }
        };
        let s = block_on(rewrite_question(&path, "c/a1".into(), "a1", "a long message", "an answer", fake("Why?"))).unwrap();
        assert_eq!(s.rewrites.get("a1").map(String::as_str), Some("Why?"));
        // The stored one is read back, with no second call.
        let s = block_on(rewrite_question(&path, "c/a1".into(), "a1", "a long message", "an answer", fake("Other?"))).unwrap();
        assert_eq!(s.rewrites.get("a1").map(String::as_str), Some("Why?"));
        assert_eq!(calls.get(), 1);
        assert_eq!(answer_state::load_from(&path).rewrites.len(), 1);
    }

    #[test]
    fn a_failed_or_empty_call_stores_nothing_and_a_later_load_retries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.answers.json");
        let err = block_on(rewrite_question(&path, "c/b".into(), "b", "msg", "ans", |_| async { Err::<String, _>("boom".into()) }));
        assert_eq!(err.unwrap_err(), "boom");
        let empty = block_on(rewrite_question(&path, "c/b".into(), "b", "msg", "ans", |_| async { Ok::<_, String>("  \n".into()) }));
        assert!(empty.is_err());
        assert!(answer_state::load_from(&path).rewrites.is_empty());
        let ok = block_on(rewrite_question(&path, "c/b".into(), "b", "msg", "ans", |_| async { Ok::<_, String>("Q?".into()) })).unwrap();
        assert_eq!(ok.rewrites.get("b").map(String::as_str), Some("Q?"));
    }

    #[test]
    fn a_blank_message_makes_no_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.answers.json");
        let s = block_on(rewrite_question(&path, "c/blank".into(), "blank", "  \n", "ans", |_| async {
            panic!("a call was made for a blank message")
        }))
        .unwrap();
        assert!(s.rewrites.is_empty());
    }

    #[test]
    fn a_rewrite_already_running_starts_no_second_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.answers.json");
        let _held = FlightGuard::enter("c/busy".into()).unwrap();
        let s = block_on(rewrite_question(&path, "c/busy".into(), "busy", "msg", "ans", |_| async {
            panic!("a second call started")
        }))
        .unwrap();
        assert!(s.rewrites.is_empty());
    }

    #[test]
    fn new_question_context_asks_for_the_two_lines_the_card_parses() {
        assert!(NEW_QUESTION_CONTEXT.contains("\nQUESTION: "));
        assert!(NEW_QUESTION_CONTEXT.contains("\nVERDICT: "));
    }
}
