//! Which targets the Projects list shows (open/closed) and which quick-action
//! chips a target pins. Desktop-pipe only, like the rest of the dashboard
//! (none of these names is in `TRANSPORT_TABLE`).

use super::gather::Gathered;
use super::{parse, publish_changed, storage_unavailable, to_json};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::project_dashboard::open_state::{settle_rows, target_key};
use crate::project_dashboard::targets::{build_targets, LiveChat};
use crate::project_dashboard::{store, DashboardListRow, DashboardTargetRef, Scope};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The list rows with their open flags settled (see `settle_rows`).
pub(super) fn list_rows(g: &Gathered) -> Vec<DashboardListRow> {
    let live: Vec<LiveChat> = g
        .live
        .iter()
        .map(|c| LiveChat {
            project_id: c.inst.project_id.clone(),
            cwd: c.inst.cwd.to_string_lossy().into_owned(),
            question: c.status == "question",
            working: c.status == "working",
            started_ms: crate::project_dashboard::snapshot_parts::parse_ms(&c.inst.started_at).unwrap_or(0),
        })
        .collect();
    let build = |closed: &BTreeMap<String, i64>| build_targets(&g.groups, &g.projects, &live, g.now_ms, closed);
    // One read-modify-write, so seeding and reopening cost a single disk write.
    // With no data dir nothing persists, and every target simply reads as open.
    store::update(|s| settle_rows(s, g.now_ms, build)).unwrap_or_else(|| build(&BTreeMap::new()))
}

fn target_key_of(t: &DashboardTargetRef) -> Result<String, RpcError> {
    match t.kind.as_str() {
        "project" | "group" => Ok(target_key(&t.kind, &t.id)),
        other => Err(RpcError::invalid_params(format!("unknown dashboard kind: {other}"))),
    }
}

pub(super) fn register_layout(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct TargetParams {
        target: DashboardTargetRef,
    }
    {
        let state = state.clone();
        router.register("dashboard_close_target", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: TargetParams = parse(params)?;
                let key = target_key_of(&p.target)?;
                let now = chrono::Utc::now().timestamp_millis();
                store::update(|s| s.close_target(&key, now)).ok_or_else(storage_unavailable)?;
                publish_changed(&state);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_open_target", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: TargetParams = parse(params)?;
                let key = target_key_of(&p.target)?;
                let was_closed = store::update(|s| s.open_target(&key)).ok_or_else(storage_unavailable)?;
                publish_changed(&state);
                Ok(json!({"ok": true, "was_closed": was_closed}))
            }
        });
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_project_and_group_targets_have_a_key() {
        let t = |kind: &str| DashboardTargetRef { kind: kind.into(), id: "x".into() };
        assert_eq!(target_key_of(&t("group")).unwrap(), "group:x");
        assert!(target_key_of(&t("project")).unwrap().starts_with("project:"));
        assert!(target_key_of(&t("bogus")).is_err());
    }
}
