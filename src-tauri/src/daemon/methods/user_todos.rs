//! "Your Todos" RPCs and the shared handlers behind them. Same trust model as
//! `methods::channel`: the project comes from the CALLER'S OWN registry entry,
//! never an argument. `pub(crate)` because `hooks_server::user_todos` also
//! calls these directly, with no Router in scope.

use super::channel::{caller_project, display_name};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::user_todos::{TodoState, UserTodo};
use crate::sessions::{chat_config, user_todos};
use serde_json::{json, Value};
use std::sync::Arc;

/// Hard ceiling: this text is rebuilt into EVERY turn of every session here.
const MAX_INJECTED: usize = 20;
/// Full uuids would cost ~36 chars per card; `resolve_id` accepts either form.
const SHORT_ID_LEN: usize = 8;

/// Tells every window this project's cards moved. The panel also refetches on
/// open and on window focus, per `project_daemon_notifier_broadcast_lossy` -
/// this broadcast is the fast path, never the only one.
fn publish_changed(state: &Arc<DaemonState>, project_id: &str) {
    state.notifier.publish("user_todos_changed", json!({"project_id": project_id}));
}

fn parse_state(s: &str) -> Result<TodoState, String> {
    match s {
        "open" => Ok(TodoState::Open),
        "done" => Ok(TodoState::Done),
        "archived" => Ok(TodoState::Archived),
        other => Err(format!("unknown todo state: {other} (want open|done|archived)")),
    }
}

/// Accepts a full uuid or any unambiguous prefix of one, so the model can echo
/// back the short id it was given in the injected block.
fn resolve_id(project_id: &str, id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    let todos = user_todos::list(project_id);
    if todos.iter().any(|t| t.id == id) {
        return Ok(id.to_string());
    }
    let mut hits = todos.iter().filter(|t| t.id.starts_with(id));
    match (hits.next(), hits.next()) {
        (Some(t), None) => Ok(t.id.clone()),
        (Some(_), Some(_)) => Err(format!("ambiguous todo id: {id}")),
        _ => Err(format!("no such todo: {id}")),
    }
}

/// The project's cards plus this chat's saved column visibility, one round-trip.
/// Scope is NOT computed here: the frontend derives it from `origin_session_id`,
/// which is the whole point of not storing it.
pub(crate) fn list_user_todos(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let columns = chat_config::get(session_id).map(|c| c.todo_columns).unwrap_or_default();
    Ok(json!({
        "todos": user_todos::list(&project_id),
        "columns": columns,
    }))
}

/// The single `write_user_todo` MCP tool's four actions. Every one of them is
/// an AI-side change, so none of them clears `seen_by_origin`.
pub(crate) fn write_user_todo(
    state: &Arc<DaemonState>,
    session_id: &str,
    action: &str,
    id: &str,
    text: &str,
    reason: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let todo = match action {
        "add" => {
            if text.trim().is_empty() {
                return Err("text is required to add a todo".to_string());
            }
            let label = display_name(state, session_id);
            user_todos::add(&project_id, session_id, &label, text)
        }
        "rewrite" => {
            if text.trim().is_empty() {
                return Err("text is required to rewrite a todo".to_string());
            }
            let full = resolve_id(&project_id, id)?;
            user_todos::rewrite(&project_id, &full, text).ok_or_else(|| format!("no such todo: {id}"))?
        }
        "done" => {
            let full = resolve_id(&project_id, id)?;
            user_todos::set_state(&project_id, &full, TodoState::Done, true)
                .ok_or_else(|| format!("no such todo: {id}"))?
        }
        "drop" => {
            if reason.trim().is_empty() {
                return Err("reason is required to drop a todo".to_string());
            }
            let full = resolve_id(&project_id, id)?;
            user_todos::drop_todo(&project_id, &full, reason).ok_or_else(|| format!("no such todo: {id}"))?
        }
        other => return Err(format!("unknown action: {other} (want add|rewrite|done|drop)")),
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "todo": todo}))
}

/// Joe's own tick/untick from the panel. `by_ai: false` is what clears
/// `seen_by_origin` and therefore raises the notify CTA.
pub(crate) fn set_user_todo_state(
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    next: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let next = parse_state(next)?;
    let full = resolve_id(&project_id, id)?;
    let todo = user_todos::set_state(&project_id, &full, next, false)
        .ok_or_else(|| format!("no such todo: {id}"))?;
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "todo": todo}))
}

/// The `Notify` button and the injection hook share this. Flips every card
/// authored by `origin_session_id` back to seen.
pub(crate) fn mark_todos_seen(
    state: &Arc<DaemonState>,
    session_id: &str,
    origin_session_id: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let target = if origin_session_id.is_empty() { session_id } else { origin_session_id };
    let flipped = user_todos::mark_seen(&project_id, target);
    if flipped > 0 {
        publish_changed(state, &project_id);
    }
    Ok(json!({"ok": true, "flipped": flipped}))
}

pub(crate) fn set_todo_columns(
    state: &Arc<DaemonState>,
    session_id: &str,
    columns: Vec<String>,
) -> Result<Value, String> {
    // Resolve the project purely to reject an unknown caller, same guard as
    // every other method here.
    caller_project(state, session_id)?;
    chat_config::set_todo_columns(session_id, columns.clone());
    Ok(json!({"ok": true, "columns": columns}))
}

pub(crate) fn clear_archived_todos(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let removed = user_todos::clear_archived(&project_id);
    if removed > 0 {
        publish_changed(state, &project_id);
    }
    Ok(json!({"ok": true, "removed": removed}))
}

fn short(id: &str) -> String {
    id.chars().take(SHORT_ID_LEN).collect()
}

fn line_for(todo: &UserTodo, viewer_session_id: &str) -> String {
    let scope = if todo.origin_session_id == viewer_session_id {
        "this chat".to_string()
    } else {
        format!("chat: {}", todo.origin_label)
    };
    format!("- [{}] {} ({scope})", short(&todo.id), todo.text)
}

/// The per-turn `UserPromptSubmit` block, or None when nothing is open and
/// nothing changed. Callers MUST treat rendering as consumption: `mark_todos_seen`
/// runs in the same daemon call, which is what lets the notify CTA clear itself
/// without being clicked.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let project_id = caller_project(state, session_id).ok()?;
    let todos = user_todos::list(&project_id);

    let open: Vec<&UserTodo> = todos.iter().filter(|t| t.state == TodoState::Open).collect();
    // Only cards THIS session authored can be "unseen by origin" from here.
    let changed: Vec<&UserTodo> = todos
        .iter()
        .filter(|t| !t.seen_by_origin && t.origin_session_id == session_id)
        .collect();
    if open.is_empty() && changed.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[your-todos] Action items YOU owe the user, from this project's shared Todos panel. \
         He ticks them off there himself; you change them with the `write_user_todo` tool \
         (add|rewrite|done|drop), never by asking him to edit a list.\n",
    );
    if !open.is_empty() {
        out.push_str(&format!("Open ({}):\n", open.len()));
        for t in open.iter().take(MAX_INJECTED) {
            out.push_str(&line_for(t, session_id));
            out.push('\n');
        }
        if open.len() > MAX_INJECTED {
            out.push_str(&format!("...and {} more.\n", open.len() - MAX_INJECTED));
        }
    }
    if !changed.is_empty() {
        out.push_str("Changed by him since your last turn:\n");
        for t in changed.iter().take(MAX_INJECTED) {
            let what = match t.state {
                TodoState::Done => "ticked",
                TodoState::Open => "put back",
                TodoState::Archived => "archived",
            };
            out.push_str(&format!("- [{}] {what}: {}\n", short(&t.id), t.text));
        }
    }
    Some(out)
}

pub fn register_user_todos(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionOnly {
        session_id: String,
    }

    {
        let state = state.clone();
        router.register("list_user_todos", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                list_user_todos(&state, &p.session_id).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_user_todo_state", move |params, _ctx| {
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
                set_user_todo_state(&state, &p.session_id, &p.id, &p.state).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("mark_todos_seen", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    #[serde(default)]
                    origin_session_id: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                mark_todos_seen(&state, &p.session_id, &p.origin_session_id).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_todo_columns", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    #[serde(default)]
                    columns: Vec<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_todo_columns(&state, &p.session_id, p.columns).map_err(RpcError::internal)
            }
        });
    }
    router.register("clear_archived_todos", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: SessionOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            clear_archived_todos(&state, &p.session_id).map_err(RpcError::internal)
        }
    });
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
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-08-19T00:00:00Z");
        state
    }

    #[test]
    fn every_method_rejects_an_unknown_caller() {
        let state = test_state();
        assert!(list_user_todos(&state, "ghost").is_err());
        assert!(write_user_todo(&state, "ghost", "add", "", "x", "").is_err());
        assert!(set_user_todo_state(&state, "ghost", "id", "done").is_err());
        assert!(mark_todos_seen(&state, "ghost", "").is_err());
        assert!(set_todo_columns(&state, "ghost", vec![]).is_err());
        assert!(clear_archived_todos(&state, "ghost").is_err());
    }

    #[test]
    fn unknown_action_and_state_are_rejected_by_name() {
        let state = registered();
        let err = write_user_todo(&state, "s1", "obliterate", "", "x", "").unwrap_err();
        assert!(err.contains("unknown action"), "got {err}");
        let err = set_user_todo_state(&state, "s1", "any", "sideways").unwrap_err();
        assert!(err.contains("unknown todo state"), "got {err}");
    }

    #[test]
    fn add_requires_text_and_drop_requires_reason() {
        let state = registered();
        assert!(write_user_todo(&state, "s1", "add", "", "   ", "").is_err());
        assert!(write_user_todo(&state, "s1", "drop", "some-id", "", "  ").is_err());
    }

    #[test]
    fn parse_state_covers_every_variant() {
        assert_eq!(parse_state("open").unwrap(), TodoState::Open);
        assert_eq!(parse_state("done").unwrap(), TodoState::Done);
        assert_eq!(parse_state("archived").unwrap(), TodoState::Archived);
        assert!(parse_state("").is_err());
    }

    #[test]
    fn injected_line_marks_scope_from_the_viewer_not_a_stored_field() {
        let todo = UserTodo {
            id: "abcdef1234".to_string(),
            text: "grab a token".to_string(),
            origin_session_id: "s1".to_string(),
            origin_label: "push-notifs".to_string(),
            state: TodoState::Open,
            dropped: false,
            drop_reason: String::new(),
            previous_text: String::new(),
            by_ai: true,
            created_at: "2026-08-19T00:00:00Z".to_string(),
            updated_at: "2026-08-19T00:00:00Z".to_string(),
            seen_by_origin: true,
        };
        // Same card, two viewers, two different scopes - nothing stored changed.
        assert_eq!(line_for(&todo, "s1"), "- [abcdef12] grab a token (this chat)");
        assert_eq!(line_for(&todo, "s2"), "- [abcdef12] grab a token (chat: push-notifs)");
    }
}
