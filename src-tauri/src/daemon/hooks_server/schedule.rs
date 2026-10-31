//! `/schedule/write`: HTTP half of the `schedule` MCP tool. The claimed
//! `session_id` is untrusted here, exactly as in `spawn_chat.rs` - the method
//! re-derives the caller's cwd and inherited chat config from the registry
//! and refuses an unknown session. Outcome rides in the body at `200 OK`, the
//! same shape every other MCP route in this module uses, so a rejected write
//! reaches the model as a readable reason rather than a transport error.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::schedule_mcp::{self, ScheduleArgs};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct WriteScheduleBody {
    session_id: String,
    action: String,
    // Option rather than `#[serde(default)] String` throughout, for the reason
    // spelled out in `user_todos::WriteTodoBody`: `default` covers a missing
    // key, not an explicit null.
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    in_minutes: Option<i64>,
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    repeat: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    guard: Option<String>,
    #[serde(default)]
    after_meeting: Option<bool>,
}

pub(super) async fn on_write_schedule(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WriteScheduleBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `schedule` tool.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let args = ScheduleArgs {
        action: body.action,
        prompt: body.prompt,
        target: body.target,
        in_minutes: body.in_minutes,
        at: body.at,
        repeat: body.repeat,
        cwd: body.cwd,
        name: body.name,
        id: body.id,
        guard: body.guard,
        after_meeting: body.after_meeting,
    };
    if let Err(e) = approve_new_chat(&ctx, &body.session_id, &args).await {
        return (StatusCode::OK, Json(json!({"ok": false, "error": e})));
    }
    match schedule_mcp::write_schedule(&ctx.state, &body.session_id, &args) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

/// `schedule` is pre-trusted (`claude_config::args::PRETRUSTED_TOOLS`) so a
/// reminder into the calling chat never stops for a card, but `add` with the
/// new_chat target (the default) starts a real `claude` process later, and a
/// repeating one outlives the chat that made it. That one action asks a human
/// unless the caller already runs with auto-accept, the same rule the CLI's
/// own permission relay applies. An unregistered caller skips the card:
/// `write_schedule` refuses it anyway, and a card for a session nobody can
/// see would only hang the call.
///
/// A guard is the exception to the auto-accept shortcut: it is a shell command
/// the daemon runs on every firing with no chat and no card around it, so a
/// human sees the exact command before it is stored, for either target.
async fn approve_new_chat(ctx: &Arc<HookCtx>, session_id: &str, args: &ScheduleArgs) -> Result<(), String> {
    if ctx.state.registry.get(session_id).is_none() {
        return Ok(());
    }
    let auto_accept = crate::sessions::chat_config::get(session_id).map(|c| c.auto_accept).unwrap_or(false);
    if !needs_card(args, auto_accept) {
        return Ok(());
    }
    let input = json!({
        "action": "add",
        "target": args.target.as_deref().unwrap_or("new_chat"),
        "guard": args.guard,
        "after_meeting": args.after_meeting,
        "prompt": args.prompt,
        "in_minutes": args.in_minutes,
        "at": args.at,
        "repeat": args.repeat,
        "cwd": args.cwd,
        "name": args.name,
    });
    let id = uuid::Uuid::new_v4().to_string();
    let decision = super::permission::ask_human(&ctx.state, &id, SCHEDULE_TOOL, input, Some(session_id)).await;
    if decision["behavior"] == "allow" {
        Ok(())
    } else {
        Err(decision["message"]
            .as_str()
            .map(|m| format!("not scheduled: {m}"))
            .unwrap_or_else(|| "not scheduled: Joe declined the new chat".to_string()))
    }
}

/// Pure so the auto-accept exemption and its guard exception are testable
/// without the on-disk chat_config store.
fn needs_card(args: &ScheduleArgs, auto_accept: bool) -> bool {
    if args.action != "add" {
        return false;
    }
    let guarded = crate::sessions::scheduled_items::normalize_guard(args.guard.as_deref()).is_some();
    let new_chat = args.target.as_deref().unwrap_or("new_chat") == "new_chat";
    guarded || (new_chat && !auto_accept)
}

const SCHEDULE_TOOL: &str = "mcp__cc_conductor__schedule";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::Value;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    async fn body_text(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn add_body(session_id: &str) -> WriteScheduleBody {
        WriteScheduleBody {
            session_id: session_id.to_string(),
            action: "add".to_string(),
            prompt: Some("check CI".to_string()),
            target: None,
            in_minutes: Some(30),
            at: None,
            repeat: None,
            cwd: None,
            name: None,
            id: None,
            guard: None,
            after_meeting: None,
        }
    }

    fn add_args(target: Option<&str>, guard: Option<&str>) -> ScheduleArgs {
        ScheduleArgs {
            action: "add".into(),
            target: target.map(str::to_string),
            guard: guard.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn a_guard_asks_a_human_even_when_the_chat_has_auto_accept() {
        for target in [None, Some("new_chat"), Some("this_chat")] {
            assert!(needs_card(&add_args(target, Some("python check.py")), true), "{target:?}");
            assert!(needs_card(&add_args(target, Some("python check.py")), false), "{target:?}");
        }
    }

    #[test]
    fn without_a_guard_the_existing_rule_is_unchanged() {
        assert!(needs_card(&add_args(None, None), false), "new_chat asks");
        assert!(!needs_card(&add_args(None, None), true), "auto-accept skips it");
        assert!(!needs_card(&add_args(Some("this_chat"), None), false), "a reminder never asks");
        assert!(!needs_card(&add_args(None, Some("   ")), true), "a blank guard is no guard");
        let cancel = ScheduleArgs { action: "cancel".into(), guard: Some("x".into()), ..Default::default() };
        assert!(!needs_card(&cancel, false));
    }

    #[tokio::test]
    async fn a_guarded_this_chat_add_raises_a_card_that_shows_the_command() {
        let ctx = ctx();
        let sid = registered(&ctx);
        let task_ctx = ctx.clone();
        let mut body = add_body(&sid);
        body.target = Some("this_chat".into());
        body.guard = Some("python check.py".into());
        let handle = tokio::spawn(async move {
            on_write_schedule(AxState(task_ctx), ValidatedJson(body)).await.into_response()
        });

        let id = first_pending_id(&ctx).await;
        let prompts = ctx.state.list_prompts().await;
        let card = prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed");
        assert_eq!(card["payload"]["input"]["guard"], "python check.py");
        assert_eq!(card["payload"]["input"]["target"], "this_chat");

        let tx = ctx.state.pending.lock().await.remove(&id).unwrap();
        tx.send(json!({"behavior": "deny", "message": "no"})).unwrap();
        let v: Value = serde_json::from_str(&body_text(handle.await.unwrap()).await).unwrap();
        assert_eq!(v["ok"], false);
    }

    /// The tool is advertised to every session, so the method's registry
    /// lookup is the only thing standing between it and an item scheduled
    /// against a session that does not exist. Read-only on this path (the
    /// caller check runs before any `upsert`), so it never touches the real
    /// `scheduled-items.json`.
    #[tokio::test]
    async fn add_rejects_an_unregistered_caller() {
        let resp = on_write_schedule(AxState(ctx()), ValidatedJson(add_body("ghost")))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
        assert!(
            v["error"].as_str().unwrap_or_default().contains("unknown caller"),
            "got {v}"
        );
    }

    #[tokio::test]
    async fn an_unknown_action_reports_the_two_that_exist() {
        let mut body = add_body("ghost");
        body.action = "list".to_string();
        let resp = on_write_schedule(AxState(ctx()), ValidatedJson(body)).await.into_response();
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
        let err = v["error"].as_str().unwrap_or_default();
        assert!(err.contains("add") && err.contains("cancel"), "got {err}");
    }

    /// Fresh id per test: chat_config is a real on-disk store, and a minted
    /// uuid can never have an auto-accept record there.
    fn registered(ctx: &Arc<HookCtx>) -> String {
        let sid = format!("sched-gate-{}", uuid::Uuid::new_v4());
        ctx.state.registry.upsert_interactive(&sid, std::path::Path::new("."), "proj-x", "2026-10-18T00:00:00Z");
        sid
    }

    async fn first_pending_id(ctx: &Arc<HookCtx>) -> String {
        for _ in 0..200 {
            if let Some(id) = ctx.state.pending.lock().await.keys().next().cloned() {
                return id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("no permission card was raised");
    }

    /// A declined card must stop the item before `write_schedule` runs, so
    /// this never touches the real scheduled-items.json.
    #[tokio::test]
    async fn a_new_chat_add_without_auto_accept_raises_a_card_and_a_deny_refuses_it() {
        let ctx = ctx();
        let sid = registered(&ctx);
        let task_ctx = ctx.clone();
        let mut body = add_body(&sid);
        body.repeat = Some("daily".to_string());
        let handle = tokio::spawn(async move {
            on_write_schedule(AxState(task_ctx), ValidatedJson(body)).await.into_response()
        });

        let id = first_pending_id(&ctx).await;
        let prompts = ctx.state.list_prompts().await;
        let card = prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed");
        assert_eq!(card["payload"]["tool_name"], SCHEDULE_TOOL);
        assert_eq!(card["payload"]["input"]["repeat"], "daily", "the card shows what would be scheduled");

        let tx = ctx.state.pending.lock().await.remove(&id).unwrap();
        tx.send(json!({"behavior": "deny", "message": "no"})).unwrap();
        let v: Value = serde_json::from_str(&body_text(handle.await.unwrap()).await).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap_or_default().starts_with("not scheduled"), "got {v}");
    }

    #[tokio::test]
    async fn a_this_chat_reminder_and_a_cancel_never_raise_a_card() {
        let ctx = ctx();
        let sid = registered(&ctx);
        let mut reminder = ScheduleArgs { action: "add".into(), target: Some("this_chat".into()), ..Default::default() };
        assert_eq!(approve_new_chat(&ctx, &sid, &reminder).await, Ok(()));
        reminder.action = "cancel".into();
        reminder.target = None;
        assert_eq!(approve_new_chat(&ctx, &sid, &reminder).await, Ok(()));
        assert!(ctx.state.pending.lock().await.is_empty());
    }

    #[test]
    fn body_accepts_an_add_with_only_the_keys_the_relay_sends() {
        let body: WriteScheduleBody = serde_json::from_str(
            r#"{"session_id":"s","action":"add","prompt":"p","in_minutes":30}"#,
        )
        .unwrap();
        assert_eq!(body.in_minutes, Some(30));
        assert_eq!(body.at, None);
    }

    #[test]
    fn body_takes_after_meeting_and_tolerates_it_being_absent_or_null() {
        let with: WriteScheduleBody = serde_json::from_str(
            r#"{"session_id":"s","action":"add","prompt":"p","in_minutes":30,"after_meeting":true}"#,
        )
        .unwrap();
        assert_eq!(with.after_meeting, Some(true));
        let null: WriteScheduleBody =
            serde_json::from_str(r#"{"session_id":"s","action":"add","after_meeting":null}"#).unwrap();
        assert_eq!(null.after_meeting, None);
    }

    #[test]
    fn body_accepts_explicit_nulls() {
        let body: WriteScheduleBody = serde_json::from_str(
            r#"{"session_id":"s","action":"cancel","id":"abc","prompt":null,"at":null,"in_minutes":null}"#,
        )
        .unwrap();
        assert_eq!(body.id.as_deref(), Some("abc"));
        assert_eq!(body.in_minutes, None);
    }
}
