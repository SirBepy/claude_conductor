//! The dashboard target list and which quick-action chips a target pins.
//! Pinning stays desktop-pipe only, like every card write.

use super::gather::Gathered;
use super::{parse, publish_changed, storage_unavailable, to_json};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::project_dashboard::targets::{build_targets, LiveChat};
use crate::project_dashboard::{store, DashboardListRow, Scope};
use serde_json::json;
use std::sync::Arc;

/// One row per group, plus one per project no group swallowed.
pub(super) fn list_rows(g: &Gathered) -> Vec<DashboardListRow> {
    let live: Vec<LiveChat> = g
        .live
        .iter()
        .map(|c| LiveChat {
            project_id: c.inst.project_id.clone(),
            cwd: c.inst.cwd.to_string_lossy().into_owned(),
            question: c.status == "question",
            working: c.status == "working",
        })
        .collect();
    build_targets(&g.groups, &g.projects, &live, g.now_ms)
}

pub(super) fn register_layout(router: &mut Router, state: Arc<DaemonState>) {
    router.register("dashboard_set_pinned_actions", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                scope: Scope,
                actions: Vec<String>,
            }
            let p: P = parse(params)?;
            let key = p.scope.scope_key();
            let saved = store::update(|s| s.set_pinned_actions(&key, p.actions))
                .ok_or_else(storage_unavailable)?
                .map_err(RpcError::invalid_params)?;
            publish_changed(&state);
            to_json(&json!({"ok": true, "actions": saved}))
        }
    });
}
