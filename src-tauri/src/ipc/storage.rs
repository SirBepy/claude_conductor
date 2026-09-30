//! IPC for the SQLite storage / retention management UI (Settings > Data).
//!
//! `rusqlite::Connection` is `!Send`, so these are plain synchronous commands
//! that briefly lock `state.db` (mirrors `get_history` in `scheduler.rs`).
//! Reading/writing the active retention policy goes through `state.settings`
//! and the existing settings save path, so a changed policy survives restart.

use crate::settings::{self, paths};
use crate::state::AppState;
use crate::storage::{self, Dataset, RetentionPolicy};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

/// Frontend handle for a dataset. Mirrors `storage::Dataset` but lives in the
/// IPC layer so the wire type is owned here; `Dataset::from`/`into` bridge them.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DatasetId {
    UsageSnapshots,
    TokenRecords,
    SkillEvents,
}

impl From<DatasetId> for Dataset {
    fn from(id: DatasetId) -> Self {
        match id {
            DatasetId::UsageSnapshots => Dataset::UsageSnapshots,
            DatasetId::TokenRecords => Dataset::TokenRecords,
            DatasetId::SkillEvents => Dataset::SkillEvents,
        }
    }
}

impl DatasetId {
    /// Human-readable label shown on the dataset card.
    fn label(self) -> &'static str {
        match self {
            DatasetId::UsageSnapshots => "Usage History",
            DatasetId::TokenRecords => "Token Records",
            DatasetId::SkillEvents => "Skill Events",
        }
    }

    /// All datasets, in display order.
    fn all() -> [DatasetId; 3] {
        [
            DatasetId::UsageSnapshots,
            DatasetId::TokenRecords,
            DatasetId::SkillEvents,
        ]
    }
}

/// Per-dataset summary for the Settings > Data section.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DatasetInfo {
    pub dataset: DatasetId,
    /// Display label, e.g. "Usage History".
    pub label: String,
    pub record_count: u64,
    /// Oldest row's unix-second timestamp, `None` when empty.
    pub oldest_entry: Option<i64>,
    /// Newest row's unix-second timestamp, `None` when empty.
    pub newest_entry: Option<i64>,
    /// The currently-configured retention policy (from settings).
    pub retention: RetentionPolicy,
    /// Total companion DB file size on disk (db + -wal + -shm), in bytes. The
    /// same value is repeated on every entry since SQLite holds one file for
    /// all three datasets; the UI shows it once as a footer.
    pub total_db_bytes: u64,
}

/// Reads the active retention policy for a dataset from settings.
fn policy_for(state: &State<AppState>, dataset: DatasetId) -> RetentionPolicy {
    state
        .settings
        .lock()
        .unwrap()
        .retention
        .policy_for(dataset.into())
}

/// Sums the companion DB file plus its WAL/SHM sidecars. Missing files count
/// as zero so a freshly-created DB (no `-wal`/`-shm` yet) still reports.
fn total_db_bytes() -> u64 {
    let Ok(db) = paths::companion_db() else {
        return 0;
    };
    let mut total = 0u64;
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db.clone();
        if !suffix.is_empty() {
            let mut name = p.file_name().unwrap_or_default().to_os_string();
            name.push(suffix);
            p.set_file_name(name);
        }
        if let Ok(meta) = std::fs::metadata(&p) {
            total += meta.len();
        }
    }
    total
}

/// Per-dataset record counts, date ranges, retention policies, and total DB
/// file size for the Settings > Data section.
#[tauri::command]
pub async fn get_storage_info(state: State<'_, AppState>) -> Result<Vec<DatasetInfo>, String> {
    let total_db_bytes = total_db_bytes();
    let mgr = state.db.lock().unwrap();
    let conn = mgr.conn();
    let mut out = Vec::with_capacity(3);
    for id in DatasetId::all() {
        let stats = storage::dataset_stats(conn, id.into()).map_err(|e| format!("{e:#}"))?;
        out.push(DatasetInfo {
            dataset: id,
            label: id.label().to_string(),
            record_count: stats.record_count,
            oldest_entry: stats.oldest_entry,
            newest_entry: stats.newest_entry,
            retention: policy_for(&state, id),
            total_db_bytes,
        });
    }
    Ok(out)
}

/// Persists a new retention policy for `dataset`, then immediately prunes that
/// dataset so the dropdown change takes effect right away.
#[tauri::command]
pub async fn set_retention_policy(
    dataset: DatasetId,
    policy: RetentionPolicy,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // Update + persist settings.
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        match dataset {
            DatasetId::UsageSnapshots => s.retention.usage_snapshots = policy,
            DatasetId::TokenRecords => s.retention.token_records = policy,
            DatasetId::SkillEvents => s.retention.skill_events = policy,
        }
        s.bump_generation();
        s.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);

    // Immediately prune the affected dataset under the new policy.
    {
        let mgr = state.db.lock().unwrap();
        storage::prune_one(mgr.conn(), dataset.into(), policy).map_err(|e| format!("{e:#}"))?;
    }
    Ok(())
}

/// Empties a dataset (`DELETE FROM <table>` + `VACUUM`). No confirmation: sole
/// user, recoverable by re-collecting data.
///
/// `VACUUM` rewrites the whole companion DB file, so it runs on the blocking
/// pool rather than just being marked `async` (an async fn that blocks still
/// blocks a runtime worker). `rusqlite::Connection` is `!Send`, so the guard
/// can't cross the `spawn_blocking` boundary - `app` (Send) goes in instead
/// and re-resolves `AppState` inside the closure.
#[tauri::command]
pub async fn clear_dataset(dataset: DatasetId, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mgr = state.db.lock().unwrap();
        storage::clear_dataset(mgr.conn(), dataset.into()).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
