//! Draft-message RPCs (todo 666). Same trust model as `methods::user_todos`:
//! the project comes from the CALLER'S OWN registry entry, never an argument.
//! Named `drafts_store` because `methods::drafts` is the composer/AUQ/held
//! draft-SYNC module and is a different concept entirely.

use super::channel::{caller_project, display_name};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::message_drafts::{self as store, DraftReceipt, DraftState, MessageDraft};
use serde_json::{json, Value};
use std::sync::Arc;

/// Hard ceiling on injected cards: this text is rebuilt every turn.
const MAX_INJECTED: usize = 12;
/// Cards whose full before/after bodies ride along after a user edit. Beyond
/// this the block names them and stops, rather than growing without bound.
const MAX_DIFFED: usize = 2;
const DIFF_EXCERPT: usize = 600;
const SHORT_ID_LEN: usize = 8;

fn publish_changed(state: &Arc<DaemonState>, project_id: &str) {
    state.notifier.publish("message_drafts_changed", json!({"project_id": project_id}));
}

fn parse_state(s: &str) -> Result<DraftState, String> {
    match s {
        "needs-you" => Ok(DraftState::NeedsYou),
        "ready" => Ok(DraftState::Ready),
        "copied" => Ok(DraftState::Copied),
        other => Err(format!("unknown draft state: {other} (want needs-you|ready|copied)")),
    }
}

fn short(id: &str) -> String {
    id.chars().take(SHORT_ID_LEN).collect()
}

fn excerpt(body: &str) -> String {
    let cut: String = body.chars().take(DIFF_EXCERPT).collect();
    if cut.chars().count() < body.chars().count() {
        format!("{cut}...")
    } else {
        cut
    }
}

/// Accepts a full uuid, an unambiguous uuid prefix, or a handle like
/// "Bruno #2" - the id the injected block actually hands the model.
fn resolve_id(project_id: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    let drafts = store::list(project_id);
    if let Some(d) = drafts.iter().find(|d| d.id == id) {
        return Ok(d.id.clone());
    }
    let wanted = id.to_lowercase();
    let by_handle = drafts
        .iter()
        .find(|d| d.variants.iter().any(|v| store::handle_of(v).to_lowercase() == wanted));
    if let Some(d) = by_handle {
        return Ok(d.id.clone());
    }
    let mut hits = drafts.iter().filter(|d| d.id.starts_with(id));
    match (hits.next(), hits.next()) {
        (Some(d), None) => Ok(d.id.clone()),
        (Some(_), Some(_)) => Err(format!("ambiguous draft id: {id}")),
        _ => Err(format!("no such draft: {id}")),
    }
}

/// A handle also names WHICH variant, so "Bruno #2" resolves the recipient too
/// and the caller never has to pass it twice.
fn recipient_from(project_id: &str, id: &str, recipient: &str) -> String {
    if !recipient.trim().is_empty() {
        return recipient.to_string();
    }
    let wanted = id.trim().to_lowercase();
    for d in store::list(project_id) {
        for v in &d.variants {
            if store::handle_of(v).to_lowercase() == wanted {
                return v.recipient.clone();
            }
        }
    }
    String::new()
}

fn receipts_from(value: Option<&Value>) -> Vec<DraftReceipt> {
    let Some(Value::Array(items)) = value else { return Vec::new() };
    items
        .iter()
        .filter_map(|it| {
            let claim = it.get("claim")?.as_str()?.trim();
            let source = it.get("source")?.as_str()?.trim();
            if claim.is_empty() || source.is_empty() {
                return None;
            }
            Some(DraftReceipt { claim: claim.to_string(), source: source.to_string() })
        })
        .collect()
}

pub(crate) fn list_message_drafts(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    Ok(json!({"drafts": store::list(&project_id)}))
}

/// The single `write_draft` MCP tool's four actions.
pub(crate) fn write_draft(
    state: &Arc<DaemonState>,
    session_id: &str,
    action: &str,
    args: &Value,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let s = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = s("id");
    let body = s("body");
    let recipient = s("recipient");

    let draft = match action {
        "add" => {
            let topic = s("topic");
            if topic.trim().is_empty() {
                return Err("topic is required to add a draft".to_string());
            }
            if recipient.trim().is_empty() {
                return Err("recipient is required to add a draft".to_string());
            }
            if body.trim().is_empty() {
                return Err("body is required to add a draft".to_string());
            }
            let label = display_name(state, session_id);
            store::add(
                &project_id,
                store::NewDraft {
                    topic: &topic,
                    recipient: &recipient,
                    body: &body,
                    brief: &s("brief"),
                    receipts: receipts_from(args.get("receipts")),
                    origin_session_id: session_id,
                    origin_label: &label,
                },
            )
            .ok_or_else(|| "no data dir to write drafts into".to_string())?
        }
        "revise" => {
            if body.trim().is_empty() {
                return Err("body is required to revise a draft".to_string());
            }
            let who = recipient_from(&project_id, &id, &recipient);
            let full = resolve_id(&project_id, &id)?;
            store::revise(&project_id, &full, &who, &body, &s("note"))?
        }
        "variant" => {
            if body.trim().is_empty() {
                return Err("body is required to add a variant".to_string());
            }
            let full = resolve_id(&project_id, &id)?;
            store::add_variant(&project_id, &full, &recipient, &body)?
        }
        "drop" => {
            let full = resolve_id(&project_id, &id)?;
            store::remove(&project_id, &full)?;
            publish_changed(state, &project_id);
            return Ok(json!({"ok": true, "dropped": full}));
        }
        other => return Err(format!("unknown action: {other} (want add|revise|variant|drop)")),
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

/// The user's own edit from the panel. Appends a version rather than
/// overwriting, and clears `seen_by_origin` so the next turn is told.
pub(crate) fn set_draft_body(
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    recipient: &str,
    body: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let full = resolve_id(&project_id, id)?;
    let draft = store::set_body(&project_id, &full, recipient, body)?;
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

pub(crate) fn set_draft_version(
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    recipient: &str,
    n: u32,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let full = resolve_id(&project_id, id)?;
    let draft = store::set_current_version(&project_id, &full, recipient, n)?;
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

pub(crate) fn set_draft_state(
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    next: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let next = parse_state(next)?;
    let full = resolve_id(&project_id, id)?;
    let draft = store::set_state(&project_id, &full, next)?;
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

pub(crate) fn delete_draft(state: &Arc<DaemonState>, session_id: &str, id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let full = resolve_id(&project_id, id)?;
    let removed = store::remove(&project_id, &full)?;
    if removed {
        publish_changed(state, &project_id);
    }
    Ok(json!({"ok": true, "removed": removed}))
}

fn open_line(d: &MessageDraft, viewer_session_id: &str) -> String {
    let handles: Vec<String> = d.variants.iter().map(store::handle_of).collect();
    let scope = if d.origin_session_id == viewer_session_id {
        String::new()
    } else {
        format!(" (chat: {})", d.origin_label)
    };
    format!("- [{}] {} - {}{scope}", handles.join(", "), d.topic, short(&d.id))
}

/// The per-turn `UserPromptSubmit` block, or None when there is nothing open
/// and nothing edited. Callers MUST treat rendering as consumption: `mark_seen`
/// runs in the same daemon call, so an edit is reported exactly once.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let project_id = caller_project(state, session_id).ok()?;
    let drafts = store::list(&project_id);

    let open: Vec<&MessageDraft> = drafts.iter().filter(|d| d.state != DraftState::Copied).collect();
    let edited: Vec<&MessageDraft> = drafts
        .iter()
        .filter(|d| !d.seen_by_origin && d.origin_session_id == session_id)
        .collect();
    if open.is_empty() && edited.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[drafts] Message drafts you wrote for the user to send somewhere else, living in this \
         project's Drafts panel. Never paste a draft message into chat - write it there with the \
         `write_draft` tool (add|revise|variant|drop) and refer to it by its handle.\n",
    );
    if !open.is_empty() {
        out.push_str(&format!("Open ({}):\n", open.len()));
        for d in open.iter().take(MAX_INJECTED) {
            out.push_str(&open_line(d, session_id));
            out.push('\n');
        }
        if open.len() > MAX_INJECTED {
            out.push_str(&format!("...and {} more.\n", open.len() - MAX_INJECTED));
        }
    }
    if !edited.is_empty() {
        out.push_str(
            "He edited these himself since your last turn. Read what he changed and carry that \
             preference into every later draft; do not revert it.\n",
        );
        for d in edited.iter().take(MAX_DIFFED) {
            for v in &d.variants {
                let mine = store::last_ai_body(v);
                let theirs = store::current_body(v);
                if mine == theirs {
                    continue;
                }
                out.push_str(&format!("[{}] {}\n", store::handle_of(v), d.topic));
                out.push_str(&format!("  yours: {}\n", excerpt(mine)));
                out.push_str(&format!("  his:   {}\n", excerpt(theirs)));
            }
        }
        if edited.len() > MAX_DIFFED {
            let rest: Vec<String> = edited
                .iter()
                .skip(MAX_DIFFED)
                .flat_map(|d| d.variants.iter().map(store::handle_of))
                .collect();
            out.push_str(&format!("Also edited, not shown: {}.\n", rest.join(", ")));
        }
    }
    Some(out)
}

/// Flips this session's edited cards back to seen. The injection hook calls it
/// in the same request that serves the block.
pub(crate) fn mark_drafts_seen(state: &Arc<DaemonState>, session_id: &str) -> usize {
    let Ok(project_id) = caller_project(state, session_id) else { return 0 };
    let flipped = store::mark_seen(&project_id, session_id);
    if flipped > 0 {
        publish_changed(state, &project_id);
    }
    flipped
}

pub fn register_drafts_store(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionOnly {
        session_id: String,
    }

    {
        let state = state.clone();
        router.register("list_message_drafts", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                list_message_drafts(&state, &p.session_id).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_body", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    #[serde(default)]
                    recipient: String,
                    body: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_body(&state, &p.session_id, &p.id, &p.recipient, &p.body).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_version", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    #[serde(default)]
                    recipient: String,
                    n: u32,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_version(&state, &p.session_id, &p.id, &p.recipient, p.n).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_state", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    state: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_state(&state, &p.session_id, &p.id, &p.state).map_err(RpcError::internal)
            }
        });
    }
    router.register("delete_draft", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                session_id: String,
                id: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            delete_draft(&state, &p.session_id, &p.id).map_err(RpcError::internal)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::message_drafts::{DraftAuthor, DraftVariant, DraftVersion};
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn registered() -> Arc<DaemonState> {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-08-26T00:00:00Z");
        state
    }

    fn variant(recipient: &str, n: u32, bodies: &[(&str, DraftAuthor)]) -> DraftVariant {
        let versions: Vec<DraftVersion> = bodies
            .iter()
            .enumerate()
            .map(|(i, (body, author))| DraftVersion {
                n: i as u32 + 1,
                body: (*body).to_string(),
                author: *author,
                note: String::new(),
                created_at: "2026-08-26T00:00:00Z".to_string(),
            })
            .collect();
        let current = versions.len() as u32;
        DraftVariant { recipient: recipient.to_string(), handle_n: n, versions, current }
    }

    fn draft(variants: Vec<DraftVariant>) -> MessageDraft {
        MessageDraft {
            id: "abcdef1234-5678".to_string(),
            topic: "Sprint slip".to_string(),
            brief: String::new(),
            receipts: vec![],
            variants,
            state: DraftState::NeedsYou,
            origin_session_id: "s1".to_string(),
            origin_label: "chat A".to_string(),
            created_at: "2026-08-26T00:00:00Z".to_string(),
            updated_at: "2026-08-26T00:00:00Z".to_string(),
            seen_by_origin: true,
        }
    }

    #[test]
    fn every_method_rejects_an_unknown_caller() {
        let state = test_state();
        assert!(list_message_drafts(&state, "ghost").is_err());
        assert!(write_draft(&state, "ghost", "add", &json!({})).is_err());
        assert!(set_draft_body(&state, "ghost", "id", "", "x").is_err());
        assert!(set_draft_version(&state, "ghost", "id", "", 1).is_err());
        assert!(set_draft_state(&state, "ghost", "id", "ready").is_err());
        assert!(delete_draft(&state, "ghost", "id").is_err());
    }

    #[test]
    fn unknown_action_and_state_are_rejected_by_name() {
        let state = registered();
        let err = write_draft(&state, "s1", "obliterate", &json!({})).unwrap_err();
        assert!(err.contains("unknown action"), "got {err}");
        let err = set_draft_state(&state, "s1", "any", "sideways").unwrap_err();
        assert!(err.contains("unknown draft state"), "got {err}");
    }

    #[test]
    fn add_names_every_missing_required_field() {
        let state = registered();
        let err = write_draft(&state, "s1", "add", &json!({})).unwrap_err();
        assert!(err.contains("topic"), "got {err}");
        let err = write_draft(&state, "s1", "add", &json!({"topic": "t"})).unwrap_err();
        assert!(err.contains("recipient"), "got {err}");
        let err = write_draft(&state, "s1", "add", &json!({"topic": "t", "recipient": "Bruno"})).unwrap_err();
        assert!(err.contains("body"), "got {err}");
    }

    #[test]
    fn parse_state_covers_every_variant() {
        assert_eq!(parse_state("needs-you").unwrap(), DraftState::NeedsYou);
        assert_eq!(parse_state("ready").unwrap(), DraftState::Ready);
        assert_eq!(parse_state("copied").unwrap(), DraftState::Copied);
        assert!(parse_state("").is_err());
    }

    #[test]
    fn receipts_skip_malformed_entries_instead_of_failing_the_write() {
        let parsed = receipts_from(Some(&json!([
            {"claim": "refreshToken()", "source": "src/auth/session.ts:88"},
            {"claim": "  ", "source": "nowhere"},
            {"claim": "no source"},
            "not an object"
        ])));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].claim, "refreshToken()");
    }

    #[test]
    fn open_line_marks_another_chats_card_but_not_your_own() {
        let d = draft(vec![variant("Bruno", 2, &[("hey", DraftAuthor::Ai)])]);
        assert_eq!(open_line(&d, "s1"), "- [Bruno #2] Sprint slip - abcdef12");
        assert!(open_line(&d, "s2").ends_with("(chat: chat A)"));
    }

    #[test]
    fn open_line_lists_every_recipient_handle() {
        let d = draft(vec![
            variant("Bruno", 2, &[("technical", DraftAuthor::Ai)]),
            variant("Ana", 1, &[("plain", DraftAuthor::Ai)]),
        ]);
        assert!(open_line(&d, "s1").starts_with("- [Bruno #2, Ana #1]"), "got {}", open_line(&d, "s1"));
    }

    #[test]
    fn excerpt_only_marks_truncation_when_it_truncated() {
        assert_eq!(excerpt("short"), "short");
        let long = "y".repeat(DIFF_EXCERPT + 10);
        let cut = excerpt(&long);
        assert!(cut.ends_with("..."));
        assert_eq!(cut.chars().count(), DIFF_EXCERPT + 3);
    }
}
