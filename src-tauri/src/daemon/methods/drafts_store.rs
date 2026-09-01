//! Draft-message RPCs (todo 666). Same trust model as `methods::user_todos`:
//! the project comes from the CALLER'S OWN registry entry, never an argument.
//! Named `drafts_store` because `methods::drafts` is the composer/AUQ/held
//! draft-SYNC module and is a different concept entirely.
//! `Router` wiring lives in the sibling `routes` module, the `UserPromptSubmit`
//! injection block in the sibling `inject` module.

mod inject;
mod routes;

pub(crate) use inject::{mark_drafts_seen, render_for_injection};
pub use routes::register_drafts_store;

use super::channel::{caller_project, display_name};
use crate::daemon::state::DaemonState;
use crate::sessions::message_drafts::{self as store, DraftReceipt, DraftState};
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) fn publish_changed(state: &Arc<DaemonState>, project_id: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn registered() -> Arc<DaemonState> {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-08-26T00:00:00Z");
        state
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
}
