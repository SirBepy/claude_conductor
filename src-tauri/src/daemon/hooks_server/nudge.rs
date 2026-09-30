//! `PostToolBatch` endpoint: delivers messages Joe typed while a turn was
//! already running INTO that running turn, instead of interrupting it.
//!
//! Before this, a mid-turn message had exactly two fates: wait in the held
//! queue until the turn ended on its own, or ride "Send now", which calls
//! `cancel_turn` first. The interrupt aborts the whole turn, and every
//! in-flight `Agent` call dies with it - so reading Joe sooner cost him all
//! the subagent work already paid for.
//!
//! `PostToolBatch` fires once after each batch of tool calls resolves, right
//! before the next model request, and its `hookSpecificOutput.additionalContext`
//! is injected into that request. So a message queued at any point during a
//! turn reaches the model at its next step, with nothing cancelled. Verified
//! end to end against the daemon's own stream-json spawn shape in
//! `tests/daemon_spike_posttoolbatch_inject.rs` (the marker is written only
//! AFTER the first tool result lands, so a pass cannot be explained by the
//! text being present at spawn).
//!
//! There is no queue of its own here: the held-message list in
//! `draft_store` is already where a typed-while-busy message goes, already
//! synced across surfaces and already persisted client-side. This endpoint
//! just drains it early. Anything it leaves behind still flushes the old way
//! when the turn ends, so a session with no hook registered (a channel spawn)
//! degrades to exactly today's behavior.

use super::HookCtx;
use crate::daemon::methods::drafts::sync_held_count;
use crate::types::ContentBlock;
use axum::{
    extract::{Query, State as AxState},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct ToolBatchQuery {
    /// OUR registry id, baked into the hook URL by `claude_config` - same
    /// reason as `prompt-submit`: the id the daemon keys on cannot drift on a
    /// fork the way the CLI's own session id can.
    #[serde(default)]
    session_id: String,
}

/// Opening/closing tags of `frame()`'s output, shared with `parse_mid_turn_frame`
/// so the two stay byte-compatible without duplicating the literal.
const FRAME_OPEN: &str = "<user-message-mid-turn>\n";
const FRAME_CLOSE: &str = "\n</user-message-mid-turn>";

/// Wraps the drained text so the model reads it as Joe talking, not as
/// ambient background. Without the framing it arrives as unattributed
/// context mid-task, which is exactly the shape a model is trained to note
/// and move past - the opposite of the point.
fn frame(messages: &[String]) -> String {
    let plural = if messages.len() == 1 { "" } else { "s" };
    let body = messages.join("\n\n");
    format!(
        "{FRAME_OPEN}\
         The user sent the following message{plural} while you were working. This is a real \
         instruction from them, delivered without interrupting your turn - not background \
         context. Read it now and let it change what you are doing if it should. If it does not \
         change anything, acknowledge it in your next message rather than silently ignoring it.\n\n\
         {body}\
         {FRAME_CLOSE}"
    )
}

/// Recovers the held messages from a `frame()`-wrapped hook context. The
/// transcript JSONL never stores a mid-turn delivery any other way (see
/// `chat::parser::parse_line`'s "attachment" arm, which is the only caller):
/// the CLI persists it purely as `PostToolBatch`'s `additionalContext`
/// string, so history replay has nothing to work from but this text.
///
/// The preamble paragraph has no embedded blank line (the plural/singular
/// wording differs but neither variant contains "\n\n"), so the first
/// `"\n\n"` split lands exactly on the preamble/body boundary; everything
/// after is `body`, which is itself `messages.join("\n\n")` - splitting it
/// back on the same separator recovers the original per-item strings.
/// Ambiguous only if an original message itself contained a literal blank
/// line, which `frame` has no way to escape either.
///
/// Returns `None` if `text` isn't (or no longer looks like) a `frame()`
/// output - callers should skip the entry rather than fabricate a message.
pub(crate) fn parse_mid_turn_frame(text: &str) -> Option<Vec<String>> {
    let inner = text.strip_prefix(FRAME_OPEN)?.strip_suffix(FRAME_CLOSE)?;
    let (_preamble, body) = inner.split_once("\n\n")?;
    Some(body.split("\n\n").map(str::to_string).collect())
}

/// Text of a held item, or None if any block in it is not text. An image
/// cannot ride `additionalContext`, and splitting an item to deliver half of
/// it would reorder Joe's own words against the attachment they describe - so
/// the whole item stays queued for the normal end-of-turn flush.
fn item_text(blocks: &[ContentBlock]) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => parts.push(text),
            ContentBlock::Image { .. } => return None,
        }
    }
    let joined = parts.join("\n");
    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}

pub(super) async fn on_tool_batch(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Query(q): Query<ToolBatchQuery>,
    body: String,
) -> impl IntoResponse {
    // A subagent's tool calls fire this hook too, and its context is not where
    // Joe's message belongs: the subagent would consume it, act on it inside a
    // scope that cannot see the conversation, and the main thread would never
    // learn it existed. `agent_id` is present on a hook payload exactly when it
    // fired from inside a subagent, so leaving the queue alone here means the
    // message waits for the main thread's own next batch.
    if fired_inside_subagent(&body) {
        return (StatusCode::OK, String::new());
    }
    if q.session_id.is_empty() {
        return (StatusCode::OK, String::new());
    }

    let held = ctx.state.draft_store.get(&q.session_id).held;
    let mut delivered_ids: Vec<u64> = Vec::new();
    let mut messages: Vec<String> = Vec::new();
    let mut delivered_blocks: Vec<ContentBlock> = Vec::new();
    for item in &held {
        let Some(text) = item_text(&item.blocks) else { continue };
        delivered_ids.push(item.id);
        messages.push(text);
        delivered_blocks.extend(item.blocks.iter().cloned());
    }
    // The common case by volume: nothing queued means EMPTY stdout, never an
    // envelope wrapping an empty string (same rule as `prompt-submit`).
    if messages.is_empty() {
        return (StatusCode::OK, String::new());
    }

    // Consume before serving. A turn that received the text has, by
    // definition, taken delivery of it; leaving the items queued would send
    // them a second time at end of turn.
    for id in &delivered_ids {
        ctx.state.draft_store.remove_held(&q.session_id, *id);
    }
    sync_held_count(&ctx.state, &q.session_id);
    // Live render rides the session's own chat-stream broadcast, not the
    // global notifier below: `subscribe_global` silently drops frames under
    // backpressure (`Err(Lagged(_)) => continue`, methods/lifecycle/notifier.rs),
    // and a busy mid-turn session is exactly when that backpressure peaks - a
    // reproduced live bug (todo 926), not a hypothetical. The per-session
    // broadcast a live turn already streams on (attach.rs) self-heals instead:
    // a lagged receiver gets an explicit `ChatEvent::EventsLagged` the frontend
    // turns into a forced resync, rather than a silently missing frame.
    //
    // `remote_echo: true` for the same reason `lifecycle::teardown`'s send-echo
    // helper sets it: the event-store's runner-channel listener
    // (`event-store.ts`'s `ensureListener`) drops every OTHER live `user_message`
    // on this channel outright (`claude -p --resume` replays history user lines
    // on it too, unmarked) - only a marked echo survives to `deliver()`, whose
    // existing sigOf/isLiveDuplicate gate then dedups it against the desktop's
    // own optimistic bubble (if any) or the JSONL-recovered copy on reload.
    // Content shape matches `chat::parser::parse_line`'s "attachment" arm
    // exactly (one UserMessage, one block per delivered item) so those two
    // never render as two separate rows.
    if let Some(session) = ctx.state.sessions.get(&q.session_id).map(|s| s.clone()) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        crate::daemon::broadcast::publish(&session, crate::types::chat::ChatEvent::UserMessage {
            content: delivered_blocks.clone(),
            timestamp: now_ms,
            remote_echo: true,
            is_meta: false,
            author_session_id: None,
        });
    }
    // Every surface drops these from its own held set and renders them as sent
    // user messages - without this the chip empties with nothing to show for
    // it, which reads as the message being thrown away.
    ctx.state.notifier.publish(
        "held_messages_delivered",
        json!({ "session_id": q.session_id, "ids": delivered_ids, "blocks": delivered_blocks }),
    );
    log::info!(
        "hook /hooks/tool-batch: injected {} held message(s) into {}'s running turn",
        messages.len(),
        q.session_id
    );

    let payload = json!({
        "hookSpecificOutput": {
            "hookEventName": "PostToolBatch",
            "additionalContext": frame(&messages),
        }
    });
    (StatusCode::OK, payload.to_string())
}

/// Whether this hook invocation came from inside an `Agent` call. A malformed
/// body counts as "yes": refusing to drain only delays delivery to the next
/// batch or to the end-of-turn flush, while draining into the wrong context
/// loses the message outright.
fn fired_inside_subagent(body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return true };
    !v.get("agent_id").unwrap_or(&Value::Null).is_null()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    fn text(s: &str) -> ContentBlock {
        ContentBlock::Text { text: s.to_string() }
    }

    /// A real throwaway child process for its `ChildStdin` - `Session::new`
    /// requires a live one and there's no cross-platform stand-in. Same
    /// pattern as `attach.rs`'s `spawn_fake_session` / `teardown.rs`'s
    /// `end_session_drops_the_closed_chats_ask_threads` (Windows-only for the
    /// same reason).
    #[cfg(windows)]
    async fn spawn_fake_session(map: &crate::daemon::session::SessionMap, session_id: &str) -> tokio::process::Child {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let pid = child.id().expect("pid");
        let session = crate::daemon::session::Session::new(
            session_id.to_string(),
            std::env::temp_dir(),
            "m".into(),
            "high".into(),
            pid,
            stdin,
            None,
            None,
            "acct".into(),
        );
        map.insert(session_id.to_string(), session);
        child
    }

    async fn body_text(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    async fn call(ctx: &Arc<HookCtx>, session_id: &str, body: &str) -> String {
        let q = ToolBatchQuery { session_id: session_id.to_string() };
        let resp = on_tool_batch(AxState(ctx.clone()), Query(q), body.to_string())
            .await
            .into_response();
        body_text(resp).await
    }

    #[tokio::test]
    async fn injects_nothing_when_no_message_is_queued() {
        let out = call(&ctx(), "s1", "{}").await;
        assert_eq!(out, "", "an idle queue means no injected bytes at all");
    }

    #[tokio::test]
    async fn injects_and_consumes_a_queued_message() {
        let c = ctx();
        c.state.draft_store.add_held("s1", vec![text("check the logs first")]);
        let out = call(&c, "s1", "{}").await;
        let v: Value = serde_json::from_str(&out).unwrap();
        let injected = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PostToolBatch");
        assert!(injected.contains("check the logs first"));
        assert_eq!(c.state.draft_store.held_count("s1"), 0, "delivered items must not stay queued");
        // A second batch in the same turn must not re-deliver what it already got.
        assert_eq!(call(&c, "s1", "{}").await, "");
    }

    // todo 926: the live pane never showed a delivered held message because
    // rendering rode ONLY the global notifier (`held_messages_delivered`),
    // which drops frames under backpressure with no signal - exactly the
    // conditions of a busy mid-turn session. This asserts the reliable half
    // of the fix: the session's own chat-stream broadcast (what a live turn
    // already streams assistant_delta/tool_use on) carries the delivery too,
    // marked `remote_echo: true` so the frontend's runner-channel listener
    // (which drops every unmarked live user_message as `--resume` history
    // noise) actually lets it through - see event-store.ts's ensureListener.
    #[cfg(windows)]
    #[tokio::test]
    async fn injects_and_broadcasts_a_live_user_message_on_the_chat_stream() {
        let c = ctx();
        let _child = spawn_fake_session(&c.state.sessions, "s1").await;
        let mut rx = c.state.sessions.get("s1").unwrap().events.subscribe();
        c.state.draft_store.add_held("s1", vec![text("BETA")]);

        let _ = call(&c, "s1", "{}").await;

        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("no timeout")
            .expect("a UserMessage broadcast on the session's own chat stream");
        match ev {
            crate::types::chat::ChatEvent::UserMessage { content, is_meta, remote_echo, author_session_id, .. } => {
                assert_eq!(content, vec![text("BETA")]);
                assert!(!is_meta, "a real typed message must not be flagged is_meta");
                assert!(remote_echo, "unmarked would be dropped as --resume history noise by event-store.ts");
                assert_eq!(author_session_id, None);
            }
            other => panic!("expected UserMessage, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_subagents_batch_leaves_the_queue_alone() {
        let c = ctx();
        c.state.draft_store.add_held("s1", vec![text("stop what you are doing")]);
        let out = call(&c, "s1", r#"{"agent_id":"ag_1","agent_type":"Explore"}"#).await;
        assert_eq!(out, "", "a subagent must not consume a message meant for the main thread");
        assert_eq!(c.state.draft_store.held_count("s1"), 1);
    }

    // Fails closed: an unparseable payload delays delivery by one batch, where
    // draining on a guess could hand the message to a subagent and lose it.
    #[tokio::test]
    async fn an_unparseable_payload_leaves_the_queue_alone() {
        let c = ctx();
        c.state.draft_store.add_held("s1", vec![text("hello")]);
        assert_eq!(call(&c, "s1", "not json at all").await, "");
        assert_eq!(c.state.draft_store.held_count("s1"), 1);
    }

    #[tokio::test]
    async fn an_item_carrying_an_image_stays_queued_for_the_end_of_turn_flush() {
        let c = ctx();
        c.state.draft_store.add_held("s1", vec![text("look at this")]);
        c.state.draft_store.add_held(
            "s1",
            vec![
                text("and this one"),
                ContentBlock::Image { mime: "image/png".into(), data: "AAAA".into() },
            ],
        );
        let out = call(&c, "s1", "{}").await;
        assert!(out.contains("look at this"));
        assert!(!out.contains("and this one"), "an image cannot ride additionalContext");
        assert_eq!(c.state.draft_store.held_count("s1"), 1, "the image item survives to flush later");
    }

    #[test]
    fn framing_names_the_sender_and_carries_every_message() {
        let framed = frame(&["first".to_string(), "second".to_string()]);
        assert!(framed.contains("first") && framed.contains("second"));
        assert!(framed.contains("while you were working"));
    }

    #[test]
    fn whitespace_only_text_is_not_worth_a_turn_of_context() {
        assert_eq!(item_text(&[text("   \n ")]), None);
    }

    #[test]
    fn parse_mid_turn_frame_round_trips_a_single_message() {
        let msgs = vec!["check the logs first".to_string()];
        assert_eq!(parse_mid_turn_frame(&frame(&msgs)), Some(msgs));
    }

    #[test]
    fn parse_mid_turn_frame_round_trips_several_messages() {
        let msgs = vec!["first".to_string(), "second".to_string(), "third one".to_string()];
        assert_eq!(parse_mid_turn_frame(&frame(&msgs)), Some(msgs));
    }

    #[test]
    fn parse_mid_turn_frame_rejects_unrelated_text() {
        assert_eq!(parse_mid_turn_frame("just some ordinary hook context"), None);
    }
}
