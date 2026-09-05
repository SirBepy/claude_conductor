//! `list_machines` RPC: this daemon's own machine identity plus its paired
//! peers, token stripped. Desktop-pipe-only (see `remote_handlers`'s
//! `TRANSPORT_TABLE` - absent there, so neither phone nor peer-machine
//! transport can call it).

use std::sync::Arc;

use serde_json::json;

use crate::daemon::machines::PeerMachineView;
use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;

pub fn register_machines(router: &mut Router, state: Arc<DaemonState>) {
    router.register("list_machines", move |_params, _ctx| {
        let state = state.clone();
        async move {
            let mine = state.machines.get().and_then(|r| r.self_machine());
            let peers: Vec<PeerMachineView> = state
                .machines
                .get()
                .map(|r| r.peers().iter().map(PeerMachineView::from).collect())
                .unwrap_or_default();
            Ok(json!({ "self": mine, "peers": peers }))
        }
    });
}
