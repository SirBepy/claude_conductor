//! The pass over unprocessed voice notes (todo pc-1852, round R7): reads the
//! transcripts `voice_transcribe` left in the vault's `Inbox/Voice`, asks one lean
//! no-tools model call per note whether it names a known project and a concrete
//! action, files a todo in that project's `.claude/todos/` when it does, and marks
//! the note `status: processed` with what was decided. A note is never deleted,
//! overwritten or sent to a chat; one that fits no project stays in the vault.
//!
//! On demand only: the `voice_triage_run` RPC (desktop pipe; absent from
//! `TRANSPORT_TABLE` on purpose, so no phone or peer machine can start a billed
//! run). Nothing starts it by itself, so a cadence is a later caller of `run::run`.

mod lean;
mod notes;
mod projects;
mod prompt;
mod run;
mod todos;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;

#[derive(Deserialize, Default)]
struct RunParams {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    dry_run: bool,
}

/// `voice_triage_run {limit?, dry_run?}` -> the run's report (one row per note
/// looked at). A second call while one runs is refused.
pub fn register_voice_triage(router: &mut Router, state: Arc<DaemonState>, app_data: PathBuf) {
    router.register("voice_triage_run", move |p, _ctx| {
        let (state, app_data) = (state.clone(), app_data.clone());
        async move {
            let p: RunParams = serde_json::from_value(p.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let Some(_guard) = run::RunGuard::take() else {
                return Err(RpcError::invalid_params("a voice triage run is already in progress"));
            };
            let vault = crate::daemon::voice_transcribe::vault::vault_dir();
            let clients = vault.as_deref().map(crate::people::clients_at).unwrap_or_default();
            let deps = run::Deps {
                projects: projects::candidates(&state.settings.snapshot().projects, &clients),
                vault,
                triager: Arc::new(lean::LeanTriager::new(app_data.clone())),
                device: crate::project_dashboard::todo_ids::device_label(),
                log_file: Some(app_data.join("voice-notes").join("triage-log.jsonl")),
                now: Arc::new(|| chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()),
            };
            let opts = run::Options { limit: p.limit.unwrap_or(run::DEFAULT_LIMIT), dry_run: p.dry_run };
            serde_json::to_value(run::run(&deps, opts).await).map_err(|e| RpcError::internal(e.to_string()))
        }
    });
}
