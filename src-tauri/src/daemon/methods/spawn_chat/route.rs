//! Routing rules (`crate::routing`) for an ordinary chat's spawn: the account,
//! model and effort a plain `spawn_chat`, a `respawn` of a main chat or a
//! scheduled new chat opens on.

use super::resolve_model_effort;
use crate::daemon::state::DaemonState;
use crate::routing::{self, Applied, Explicit};
use crate::sessions::chat_config::ChatConfig;
use std::sync::Arc;

/// The kind of a new chat: `main_chat` when it becomes a subchats-mode main chat
/// (a `respawn` of one, or a scheduled chat that turns the mode on), else
/// `new_chat`.
pub(crate) fn plain_kind(becomes_main_chat: bool) -> &'static str {
    if becomes_main_chat { "main_chat" } else { "new_chat" }
}

pub(crate) struct PlainRoute {
    pub model: String,
    pub effort: String,
    /// The account a rule picked; `None` keeps the caller's own.
    pub account_id: Option<String>,
    pub applied: Option<Applied>,
}

/// `model` and `effort` are what the caller named; a `respawn` also counts its own
/// (it continues the same work), so a rule can move a successor's account but not
/// override the model it was already running. With no rule for `kind` this is
/// `resolve_model_effort` and nothing else, and no accounts file is read.
pub(crate) fn route_plain(
    state: &Arc<DaemonState>,
    cwd: &std::path::Path,
    kind: &str,
    inherited: &ChatConfig,
    model: Option<&str>,
    effort: Option<&str>,
    respawn: bool,
) -> PlainRoute {
    let settings = state.settings.snapshot();
    let project = routing::project_for(&settings, cwd);
    if !routing::has_rules(&settings, project, kind) {
        let (model, effort) = resolve_model_effort(state, cwd, model, effort, inherited, respawn);
        return PlainRoute { model, effort, account_id: None, applied: None };
    }
    let accounts = crate::accounts::load_registry();
    fn nonblank(v: &str) -> Option<&str> {
        Some(v).filter(|s| !s.trim().is_empty())
    }
    let own = |named: Option<&'_ str>, inherited: &str| -> Option<String> {
        named.and_then(nonblank).or_else(|| nonblank(inherited).filter(|_| respawn)).map(str::to_string)
    };
    let (m, e) = (own(model, &inherited.model), own(effort, &inherited.effort));
    let base = nonblank(&inherited.account_id);
    let r = routing::resolve(&settings, project, &accounts, kind, base, Explicit { account_id: None, model: m.as_deref(), effort: e.as_deref() });
    let (model, effort) = resolve_model_effort(state, cwd, r.model.as_deref(), r.effort.as_deref(), inherited, respawn);
    let applied = Applied::of(kind, &r, &model, &effort, Vec::new());
    PlainRoute { model, effort, account_id: r.account_id, applied }
}

#[cfg(test)]
mod tests;
