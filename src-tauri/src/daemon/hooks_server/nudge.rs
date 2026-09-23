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

/// Wraps the drained text so the model reads it as Joe talking, not as
/// ambient background. Without the framing it arrives as unattributed
/// context mid-task, which is exactly the shape a model is trained to note
/// and move past - the opposite of the point.
fn frame(messages: &[String]) -> String {
    let plural = if messages.len() == 1 { "" } else { "s" };
    let body = messages.join("\n\n");
    format!(
        "<user-message-mid-turn>\n\
         The user sent the following message{plural} while you were working. This is a real \
         instruction from them, delivered without interrupting your turn - not background \
         context. Read it now and let it change what you are doing if it should. If it does not \
         change anything, acknowledge it in your next message rather than silently ignoring it.\n\n\
         {body}\n\
         </user-message-mid-turn>"
    )
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
}
