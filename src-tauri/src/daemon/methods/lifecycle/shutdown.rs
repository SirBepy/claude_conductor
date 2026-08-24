//! Explicit daemon stop: kill channels and any live chat sessions, then
//! signal the main loop to exit the process. Sessions are NOT spared -
//! this is the deliberate full stop. Not named in the split's original 8
//! (the count was already slightly stale), but it's its own concern and
//! doesn't fit turn-taking/account-move/debug/attach, so it gets the same
//! standalone shape as `register_notifier`/`register_settings`.

use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_shutdown(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("shutdown_daemon", move |_params, _ctx| {
            let state = state.clone();
            async move {
                for c in state.channels.list() {
                    let _ = crate::daemon::channels::stop_channel(&state, &c.project_id);
                }
                crate::daemon::kill_all_sessions(&state);
                state.shutdown.notify_one();
                Ok(json!({"ok": true}))
            }
        });
    }
}
