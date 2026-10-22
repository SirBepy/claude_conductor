//! The dashboard's read RPCs. All four are desktop-pipe only (absent from
//! `TRANSPORT_TABLE`): they expose local file paths, git state and transcript
//! contents, none of which a phone or paired machine may pull.

use super::gather::gather;
use super::{history, parse, snapshot, to_json, IdOnly};
use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::targets::{build_targets, LiveChat};
use crate::project_dashboard::DashboardTargetRef;
use std::sync::Arc;

#[derive(serde::Deserialize)]
struct TargetParams {
    target: DashboardTargetRef,
}

pub(super) fn register_read(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("dashboard_list_targets", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let g = gather(&state).await;
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
                to_json(&build_targets(&g.groups, &g.projects, &live, g.now_ms))
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_snapshot", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: TargetParams = parse(params)?;
                to_json(&snapshot::snapshot(&state, p.target).await?)
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_history", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: TargetParams = parse(params)?;
                to_json(&history::history(&state, p.target).await?)
            }
        });
    }
    router.register("dashboard_gallery_image", move |params, _ctx| async move {
        let p: IdOnly = parse(params)?;
        to_json(&history::gallery_image(p.id).await?)
    });
}
