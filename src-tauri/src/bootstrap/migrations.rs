//! One-time startup migrations/backfills, extracted from `bootstrap.rs`
//! (ai_todo 552) - pure move, no behavior change.

use crate::settings::paths;
use crate::state::AppState;
use tauri::Manager;

/// Import `history.jsonl`/`token-history.json`/`skill-usage` legacy files
/// into SQLite, then run a one-time startup prune under the current
/// retention policies (subsequent prunes run on each scheduler poll tick).
pub(super) fn run_sqlite_startup_migration(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut mgr = state.db.lock().unwrap();

    // Before `conn`'s shared borrow: this one needs the mutable handle.
    match crate::storage::token_store::dedupe_records(mgr.conn_mut()) {
        Ok(0) => {}
        Ok(removed) => {
            log::info!("storage: dedupe removed {removed} duplicate token record(s)");
            // Deleting rows only frees pages inside the file (145MB for ~1MB).
            match mgr.conn().execute_batch("VACUUM") {
                Ok(()) => log::info!("storage: vacuumed the database after dedupe"),
                Err(e) => log::warn!("storage: VACUUM after dedupe failed: {e:#}"),
            }
        }
        Err(e) => log::error!("storage: token record dedupe failed: {e:#}"),
    }

    let conn = mgr.conn();

    // Usage (history.jsonl -> usage_snapshots).
    if let Ok(history_path) = paths::history_file() {
        if history_path.exists() {
            match crate::storage::migration::import_usage_jsonl(conn, &history_path) {
                Ok(stats) => log::info!(
                    "storage: imported usage history into SQLite (imported={}, skipped={})",
                    stats.imported,
                    stats.skipped,
                ),
                Err(e) => log::error!("storage: usage history import failed: {e:#}"),
            }
        }
    }

    // The import that was here re-read the whole `token-history.json` on EVERY
    // launch with a bare INSERT, reaching 233k rows for 2.4k sessions.
    crate::storage::migration::retire_token_history_json();

    // Skills (skill-usage/events-*.jsonl -> skill_events). The
    // importer renames each daily file to `.bak`; a dir with no
    // remaining events-*.jsonl is a clean no-op on later launches.
    if let Ok(skill_dir) = paths::skill_usage_dir() {
        let has_events = std::fs::read_dir(&skill_dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.file_name()
                        .to_str()
                        .map(|n| n.starts_with("events-") && n.ends_with(".jsonl"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if has_events {
            match crate::storage::migration::import_skill_events_dir(conn, &skill_dir) {
                Ok(stats) => log::info!(
                    "storage: imported skill events into SQLite (imported={}, skipped={})",
                    stats.imported,
                    stats.skipped,
                ),
                Err(e) => log::error!("storage: skill events import failed: {e:#}"),
            }
        }
    }

    // One-time startup prune of all three datasets under the
    // user-configured retention policies (subsequent prunes run on
    // each scheduler poll tick).
    let policies = state.settings.lock().unwrap().retention;
    match crate::storage::prune_all(conn, &policies) {
        Ok(deleted) => {
            if deleted > 0 {
                log::info!("storage: startup prune removed {deleted} row(s)");
            }
        }
        Err(e) => log::warn!("storage: startup prune failed: {e:#}"),
    }
}

/// Re-writes `~/.claude/settings.json` if the user already accepted hook
/// registration but on an older installer version. Heals the v1 entry
/// whose `matcher: "aiusage-taskbar"` field silently suppressed every
/// SessionStart/SessionEnd firing.
pub(super) fn migrate_hook_install_if_needed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let (should_run, port) = {
        let s = state.settings.lock().unwrap();
        let stale = s.hooks_registered
            && s.hook_install_version < crate::hooks::CURRENT_INSTALL_VERSION;
        (stale, s.hook_port)
    };
    if !should_run { return; }
    let Some(port) = port else { return };
    if let Err(e) = crate::hooks::install(crate::hooks::HookConfig { port }) {
        log::warn!("hook install migration failed: {e}");
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    crate::settings::persist(app, &snapshot);
    log::info!(
        "hook install migrated to v{}",
        crate::hooks::CURRENT_INSTALL_VERSION
    );
}

/// Migration v2: characters are now per-SESSION, not per-project. Convert any
/// `Avatar::Character` entries back to `Avatar::None` so projects no longer
/// carry a character assignment. `Avatar::Emoji` and `Avatar::Image` are left
/// untouched. Guarded by `Settings.extra["characterBackfillVersion"]` so it
/// runs once per install.
pub(super) fn backfill_project_characters_if_needed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let needs = {
        let s = state.settings.lock().unwrap();
        let cur = s
            .extra
            .get("characterBackfillVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        cur < crate::characters::assign::CURRENT_BACKFILL_VERSION
    };
    if !needs {
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        let mut cleared = 0usize;
        for proj in &mut g.projects {
            if matches!(proj.avatar, crate::types::Avatar::Character(_)) {
                proj.avatar = crate::types::Avatar::None;
                cleared += 1;
            }
        }
        g.extra.insert(
            "characterBackfillVersion".into(),
            serde_json::json!(crate::characters::assign::CURRENT_BACKFILL_VERSION),
        );
        log::info!("character migration v2: cleared character avatar from {cleared} project(s)");
        g.clone()
    };
    crate::settings::persist(app, &snapshot);
}
