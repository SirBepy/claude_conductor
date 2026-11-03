//! The dashboard's read RPCs. All five are reachable from the phone (`P` in
//! `TRANSPORT_TABLE`, for its Projects tab) and never from a paired machine:
//! they expose local file paths, git state and transcript contents, which the
//! phone already reads piecemeal through its list_* methods.

use super::gather::gather;
use super::{closed_chats, history, layout, parse, snapshot, to_json, IdOnly};
use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
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
                to_json(&layout::list_rows(&g))
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
    {
        let state = state.clone();
        router.register("dashboard_closed_chats", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    target: DashboardTargetRef,
                    #[serde(default)]
                    offset: u32,
                    limit: u32,
                }
                let p: P = parse(params)?;
                to_json(&closed_chats::closed_chats(&state, p.target, p.offset, p.limit).await?)
            }
        });
    }
    router.register("dashboard_gallery_image", move |params, _ctx| async move {
        let p: IdOnly = parse(params)?;
        to_json(&history::gallery_image(p.id).await?)
    });
}
