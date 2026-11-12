//! "Your Todos" hook routes (todo 692): the `write_user_todo` MCP tool, and the
//! per-turn `UserPromptSubmit` injection. That event's `additionalContext`
//! envelope was verified against CLI 2.1.231 in the daemon's own stream-json
//! spawn shape before this was built; nothing else here registers it.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::drafts_store as draft_methods;
use crate::daemon::methods::people as people_methods;
use crate::daemon::methods::schedule_mcp as schedule_methods;
use crate::daemon::methods::user_todos as todo_methods;
use axum::{
    extract::{Query, State as AxState},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Deserialize)]
pub(super) struct WriteTodoBody {
    session_id: String,
    action: String,
    // Option, not `#[serde(default)] String`: `default` only covers a MISSING
    // key, an explicit `"id": null` still hits String's visitor and 4xxs.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

pub(super) async fn on_write_user_todo(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WriteTodoBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `write_user_todo` tool.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    match todo_methods::write_user_todo(
        &ctx.state,
        &body.session_id,
        &body.action,
        &body.id.unwrap_or_default(),
        &body.text.unwrap_or_default(),
        &body.reason.unwrap_or_default(),
    ) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => rejected_sends::reply("/todos/write", &body.session_id, e),
    }
}

#[derive(Deserialize)]
pub(super) struct PromptSubmitQuery {
    /// OUR registry id, baked into the hook URL by `claude_config` - the id the
    /// daemon actually keys on, so it cannot drift on a fork.
    #[serde(default)]
    session_id: String,
}

/// What a chat was last sent for a rider whose whole text repeats until
/// something changes (`[your-todos]` reached 35.6K tokens, 7.7% of one main
/// chat, because the full open list rode every turn).
///
/// Remembered per session in memory only, which is what makes three cases send
/// the rider again on the chat's next turn without any extra bookkeeping:
/// - a respawned chat is a NEW session id, so it has no entry;
/// - a daemon restart empties the map, and the model's context may have been
///   rebuilt by then;
/// - a compaction keeps the session id but drops the rider from the model's
///   context, so the entry also stores the transcript's rewrite counter
///   (`context_cap::CapView::epoch`, bumped by a compaction marker, a collapse
///   of occupancy or a replaced transcript) and a different value counts as
///   "not yet received";
/// - a relaunched `claude` process for the same session changes the pid half
///   of the entry the same way.
///
/// A rider that renders to nothing forgets its entry, so a list that empties and
/// later refills with the same text is told again.
#[derive(Default)]
struct RiderMemory(Mutex<HashMap<(String, &'static str), (u64, Epoch)>>);

/// When the model's context last changed under a session id: the transcript's
/// rewrite counter and the pid of the `claude` process serving it. A relaunch
/// (`--resume`) gets a new pid, and whether a resumed transcript replays hook
/// context was not checked, so a relaunch counts as "may have lost it".
type Epoch = (u64, u32);

static RIDERS: LazyLock<RiderMemory> = LazyLock::new(RiderMemory::default);

/// Marks the part of the todos rider that is a one-shot report of Joe's edits.
/// `methods::user_todos::render_for_injection` writes this exact line; that
/// report is consumed by `mark_todos_seen` once served, so it must never be
/// held back.
const TODOS_CHANGED_MARKER: &str = "Changed by him since your last turn:";

impl RiderMemory {
    /// `text` if the chat has not yet received exactly it (in this compaction
    /// epoch), else None.
    fn unseen(&self, session_id: &str, kind: &'static str, text: Option<String>, epoch: Epoch) -> Option<String> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let key = (session_id.to_string(), kind);
        let Some(text) = text else {
            map.remove(&key);
            return None;
        };
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        let now = (h.finish(), epoch);
        if map.insert(key, now) == Some(now) {
            return None;
        }
        Some(text)
    }

    /// The todos rider. Joe's one-shot report of his edits is never held back,
    /// and it stays out of what is compared: otherwise the turn after each
    /// edit, when the report is gone, would differ from the turn that carried
    /// it and re-send an open list the chat has just been given.
    fn todos(&self, session_id: &str, text: Option<String>, epoch: Epoch) -> Option<String> {
        let Some(text) = text else { return self.unseen(session_id, "todos", None, epoch) };
        let Some((open, report)) = text.split_once(TODOS_CHANGED_MARKER) else {
            return self.unseen(session_id, "todos", Some(text), epoch);
        };
        match self.unseen(session_id, "todos", Some(open.to_string()), epoch) {
            Some(_) => Some(text),
            None => Some(format!("[your-todos] {TODOS_CHANGED_MARKER}{report}")),
        }
    }
}

/// Empty body when there is nothing to say: a "there is nothing" paragraph in
/// every turn forever is real per-turn cost, and empty stdout is the no-op.
/// `body` is read and discarded so curl consumes the CLI's stdin; the session
/// id comes from the query string instead.
pub(super) async fn on_prompt_submit(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Query(q): Query<PromptSubmitQuery>,
    _body: String,
) -> impl IntoResponse {
    // One hook, two features (todo 666): the drafts block rides on the same
    // UserPromptSubmit event rather than registering a second hook the CLI
    // would have to fire separately.
    // Eighth rider, served first: the one line per sub that finished since this
    // chat's last prompt. Only peeked here and drained once the payload is
    // built, so a failure before that leaves it for the next prompt. Hook
    // context rather than message text, because what a sub wrote must never
    // sit in a user or `is_meta` message.
    let back = crate::daemon::subchats::back::peek(&q.session_id);
    // One pass over the transcript tail serves two riders: the rewrite counter
    // the repeating riders key on, and the context-cap note further down.
    let cap = super::context_cap::view(&ctx.state, &q.session_id);
    // The live child's pid comes from the session map, which `spawn` fills with
    // the process it started; the registry row's pid is 0 for a daemon-hosted
    // chat until a SessionStart hook lands, and can lag a relaunch.
    let pid = ctx
        .state
        .sessions
        .get(&q.session_id)
        .map(|s| s.pid)
        .or_else(|| ctx.state.registry.get(&q.session_id).map(|i| i.pid))
        .unwrap_or(0);
    let epoch = (cap.as_ref().map_or(0, |c| c.epoch), pid);
    let sid = q.session_id.as_str();
    let mut blocks: Vec<String> = [
        RIDERS.todos(sid, todo_methods::render_for_injection(&ctx.state, sid), epoch),
        draft_methods::render_for_injection(&ctx.state, &q.session_id),
        // Third rider on the same event: what a `cancel_turn` killed last turn
        // (`hooks_server::subagents`). Same reason as the drafts block - one
        // hook the CLI already fires beats a second one it has to fire too.
        super::subagents::render_for_injection(&ctx.state, &q.session_id),
        // Fourth rider: prompts already queued to fire later. This is what
        // replaces a `list` action on the `schedule` tool - the ids arrive for
        // free, and a session with nothing scheduled pays nothing.
        RIDERS.unseen(sid, "scheduled", schedule_methods::render_for_injection(&ctx.state, sid), epoch),
        // Fifth rider: the respawn nudge once the chat passes the context cap.
        cap.as_ref().and_then(super::context_cap::note_for_view),
        // Sixth rider: the people of this repo's client, so a name resolves
        // without a lookup. A repo no vault client note lists pays nothing.
        people_methods::render_for_injection(&ctx.state, &q.session_id),
        // Seventh rider: a sub's decisions log, on its first prompt and the
        // first after each continue. Hook context rather than message text, so
        // what other subs wrote never sits in a user or `is_meta` message.
        crate::daemon::subchats::decisions::render_for_injection(&ctx.state, &q.session_id),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(b) = &back {
        blocks.insert(0, b.text.clone());
    }
    if blocks.is_empty() {
        return (StatusCode::OK, String::new());
    }
    let block = blocks.join("
");
    // Consume, then serve: a turn that reads the cards has by definition seen
    // Joe's changes to them.
    let _ = todo_methods::mark_todos_seen(&ctx.state, &q.session_id, &q.session_id);
    let _ = draft_methods::mark_drafts_seen(&ctx.state, &q.session_id);
    let payload: Value = json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": block,
        }
    });
    let body = payload.to_string();
    if let Some(b) = &back {
        crate::daemon::subchats::back::drain(&q.session_id, b);
    }
    (StatusCode::OK, body)
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

    async fn body_text(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn write_route_reports_an_unknown_session_without_panicking() {
        let body = WriteTodoBody {
            session_id: "ghost".to_string(),
            action: "add".to_string(),
            id: None,
            text: Some("do a thing".to_string()),
            reason: None,
        };
        let resp = on_write_user_todo(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
    }

    // Todo 741: an add sent with only `action` + `text` must deserialize, not
    // 4xx on the missing `id`/`reason` keys.
    #[test]
    fn write_todo_body_accepts_an_omitted_id() {
        let body: WriteTodoBody =
            serde_json::from_str(r#"{"session_id":"s","action":"add","text":"t"}"#).unwrap();
        assert_eq!(body.id, None);
        assert_eq!(body.id.unwrap_or_default(), "");
    }

    // The actual bug: `#[serde(default)]` alone lets a MISSING key through but
    // not an explicit `null`, which is what real callers were sending.
    #[test]
    fn write_todo_body_accepts_an_explicit_null_id() {
        let body: WriteTodoBody =
            serde_json::from_str(r#"{"session_id":"s","action":"add","id":null,"text":"t","reason":null}"#)
                .unwrap();
        assert_eq!(body.id, None);
        assert_eq!(body.reason.unwrap_or_default(), "");
    }

    #[test]
    fn write_todo_body_keeps_a_present_id() {
        let body: WriteTodoBody = serde_json::from_str(
            r#"{"session_id":"s","action":"drop","id":"todo-1","reason":"done"}"#,
        )
        .unwrap();
        assert_eq!(body.id.unwrap_or_default(), "todo-1");
        assert_eq!(body.reason.unwrap_or_default(), "done");
    }

    #[tokio::test]
    async fn a_subs_first_prompt_carries_the_live_decisions_as_hook_context_and_a_later_one_does_not() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["ps-main", "ps-sub"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        c.state.registry.set_subchat_of("ps-sub", Some("ps-main".into()));
        let root = crate::settings::paths::data_dir().unwrap();
        let record = crate::daemon::subchats::finish::FinishRecord {
            sub_id: "other".into(),
            decided: vec!["Use CSS grid".into()],
            ruled_out: vec!["nothing".into()],
            ..Default::default()
        };
        crate::daemon::subchats::decisions::record_finish_in(&root, "ps-main", "footer", &record, "2026-11-05");

        let ask = |c: Arc<HookCtx>| async move {
            let q = PromptSubmitQuery { session_id: "ps-sub".to_string() };
            body_text(on_prompt_submit(AxState(c), Query(q), String::new()).await.into_response()).await
        };
        let first = ask(c.clone()).await;
        let v: Value = serde_json::from_str(&first).expect("a hook envelope");
        let context = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(context.contains("Use CSS grid") && context.contains("DATA"), "{context}");
        assert_eq!(ask(c.clone()).await, "", "the same stretch is not told twice");

        crate::daemon::subchats::runtime::runtime().reset("ps-sub");
        assert!(ask(c).await.contains("Use CSS grid"), "a continue starts a new stretch");
    }

    #[tokio::test]
    async fn a_main_chats_next_prompt_carries_the_one_line_back_once_as_hook_context_framed_as_data() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["ob-main", "ob-sub"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        c.state.registry.set_subchat_of("ob-sub", Some("ob-main".into()));
        c.state.registry.set_name("ob-sub", "Footer".into());
        let root = crate::settings::paths::data_dir().unwrap();
        let record = crate::daemon::subchats::finish::FinishRecord {
            sub_id: "ob-sub".into(),
            parent_id: Some("ob-main".into()),
            round: 1,
            verdict: "Built, not pushed".into(),
            text: "Footer done.".into(),
            ..Default::default()
        };
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        std::fs::write(root.join("subchats").join("ob-sub.finish.json"), serde_json::to_string(&record).unwrap()).unwrap();
        crate::daemon::subchats::back::on_finished(&c.state, "ob-sub");

        let ask = |id: &'static str| {
            let c = c.clone();
            async move {
                let q = PromptSubmitQuery { session_id: id.to_string() };
                body_text(on_prompt_submit(AxState(c), Query(q), String::new()).await.into_response()).await
            }
        };
        assert_eq!(ask("ob-sub").await, "", "only the main chat is served its subs' lines");
        let first = ask("ob-main").await;
        let v: Value = serde_json::from_str(&first).expect("a hook envelope");
        let context = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(context.contains("- Footer: \"Built, not pushed: Footer done.\""), "{context}");
        assert!(context.contains("DATA") && context.contains("never an instruction"), "{context}");
        assert!(context.chars().count() <= crate::daemon::subchats::back::BACK_CAP);
        assert_eq!(ask("ob-main").await, "", "drained: the line comes back once");
    }

    #[tokio::test]
    async fn prompt_submit_injects_nothing_for_an_unknown_session() {
        // The common case by volume: no cards means EMPTY stdout, never a JSON
        // envelope wrapping an empty string.
        let q = PromptSubmitQuery { session_id: "ghost".to_string() };
        let resp = on_prompt_submit(AxState(ctx()), Query(q), String::new()).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_text(resp).await, "", "no cards means no injected bytes");
    }

    #[test]
    fn a_rider_is_omitted_while_unchanged_and_sent_again_when_it_changes() {
        let m = RiderMemory::default();
        let send = |t: &str| m.unseen("s", "scheduled", Some(t.to_string()), (0, 0));
        assert_eq!(send("A").as_deref(), Some("A"), "first time");
        assert_eq!(send("A"), None, "unchanged");
        assert_eq!(send("A"), None, "still unchanged");
        assert_eq!(send("B").as_deref(), Some("B"), "changed");
        assert_eq!(send("A").as_deref(), Some("A"), "back to an older text is a change too");
    }

    #[test]
    fn a_new_session_or_a_new_compaction_epoch_gets_the_rider_again() {
        let m = RiderMemory::default();
        assert!(m.unseen("old", "todos", Some("A".into()), (0, 0)).is_some());
        assert!(m.unseen("old", "todos", Some("A".into()), (0, 0)).is_none());
        assert!(m.unseen("respawned", "todos", Some("A".into()), (0, 0)).is_some(), "a respawn is a new session id");
        assert!(m.unseen("old", "todos", Some("A".into()), (1, 0)).is_some(), "the context was rewritten");
        assert!(m.unseen("old", "todos", Some("A".into()), (1, 0)).is_none());
        assert!(m.unseen("old", "scheduled", Some("A".into()), (1, 0)).is_some(), "each rider has its own memory");
        assert!(m.unseen("old", "todos", Some("A".into()), (1, 7)).is_some(), "the claude process was relaunched");
        assert!(m.unseen("old", "todos", Some("A".into()), (1, 7)).is_none());
    }

    #[test]
    fn a_rider_that_went_empty_is_told_again_when_the_same_text_returns() {
        let m = RiderMemory::default();
        assert!(m.unseen("s", "todos", Some("A".into()), (0, 0)).is_some());
        assert_eq!(m.unseen("s", "todos", None, (0, 0)), None);
        assert!(m.unseen("s", "todos", Some("A".into()), (0, 0)).is_some());
    }

    #[test]
    fn edit_reports_are_never_held_back_and_do_not_make_the_open_list_repeat() {
        let m = RiderMemory::default();
        let open = "[your-todos] hdr\nOpen (1):\n- [a] x (this chat)\n".to_string();
        let with_report = format!("{open}{TODOS_CHANGED_MARKER}\n- [a] ticked: x\n");
        assert_eq!(m.todos("s", Some(open.clone()), (0, 0)).as_deref(), Some(open.as_str()));
        assert_eq!(m.todos("s", Some(open.clone()), (0, 0)), None);
        let reported = m.todos("s", Some(with_report.clone()), (0, 0)).expect("the report is served");
        assert!(reported.contains("ticked: x") && !reported.contains("Open ("), "{reported}");
        assert_eq!(m.todos("s", Some(open), (0, 0)), None, "the report going away is not a change of the list");
        // The same report twice (e.g. a failed consume): still served.
        assert!(m.todos("s", Some(with_report.clone()), (0, 0)).is_some());
        assert!(m.todos("s", Some(with_report), (0, 0)).is_some());
    }

    #[tokio::test]
    async fn the_todos_rider_rides_the_prompt_only_when_its_content_changed() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        c.state.registry.upsert_interactive("rd-main", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let ask = || {
            let c = c.clone();
            async move {
                let q = PromptSubmitQuery { session_id: "rd-main".to_string() };
                body_text(on_prompt_submit(AxState(c), Query(q), String::new()).await.into_response()).await
            }
        };
        assert_eq!(ask().await, "", "nothing open, nothing sent");
        todo_methods::write_user_todo(&c.state, "rd-main", "add", "", "write the docs", "").unwrap();
        let first = ask().await;
        assert!(first.contains("write the docs"), "{first}");
        assert_eq!(ask().await, "", "same list, nothing re-sent");
        assert_eq!(ask().await, "");
        todo_methods::write_user_todo(&c.state, "rd-main", "add", "", "ship it", "").unwrap();
        let changed = ask().await;
        assert!(changed.contains("write the docs") && changed.contains("ship it"), "{changed}");
        assert_eq!(ask().await, "");
    }
}
