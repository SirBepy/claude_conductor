//! Persistence for Interactive (Path C) sessions.
//!
//! The in-memory `Registry` is rebuilt on every app start. External /
//! Automated entries get rehydrated from `~/.claude/sessions/*.json` (the
//! live-pid files Claude writes). Interactive entries have NO live process
//! between turns, so they'd vanish on app close without a separate store.
//!
//! This module owns that store: a single JSON file at
//! `<app-data>/interactive-sessions.json` containing one record per
//! resumable Interactive session. Written atomically (tmp + rename) after
//! every Interactive-mutating IPC call. Read once on app startup and
//! merged into the registry via `upsert_interactive`.
//!
//! Eviction policy: entries marked ended (via `clear_session`) are excluded
//! from the snapshot, so they disappear on the next save. On load, entries
//! whose cwd no longer exists are skipped (project deleted) - the file
//! self-cleans the next time we save.

use crate::sessions::kinds::InstanceKind;
use crate::sessions::registry::Registry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedInteractive {
    pub session_id: String,
    pub cwd: PathBuf,
    pub project_id: String,
    pub name: Option<String>,
    pub model: String,
    pub effort: String,
    pub started_at: String,
    /// The registry account this session was spawned under. `#[serde(default)]`
    /// so snapshots written before milestone 02 still load (as `None`).
    #[serde(default)]
    pub account_id: Option<String>,
    /// Last self-reported turn status ("done" / "question" / "waiting" /
    /// "working"). Persisted so a daemon restart doesn't silently reset every
    /// backgrounded chat's sidebar state to "Done". `#[serde(default)]` for
    /// pre-existing snapshots.
    #[serde(default)]
    pub awaiting: Option<String>,
    /// True for the singleton Jarvis orchestrator session (todo 272).
    /// `#[serde(default)]` so snapshots written before this field existed
    /// still load (as `false`).
    #[serde(default)]
    pub jarvis: bool,
    /// Jarvis session id this session was spawned as a worker of, if any.
    /// `#[serde(default)]` for pre-existing snapshots.
    #[serde(default)]
    pub worker_of: Option<String>,
    /// User-frozen flag (Chat menu's Freeze/Unfreeze toggle). Must survive a
    /// daemon restart same as every other Interactive field here - freeze
    /// never implies `ended_at`, so a frozen session stays in this snapshot.
    #[serde(default)]
    pub frozen: bool,
    /// Whether the frozen turn was cancelled mid-flight (vs already idle),
    /// so unfreeze still auto-continues after a daemon restart in between.
    #[serde(default)]
    pub frozen_needs_continue: bool,
    /// Whether `frozen` was set by a rate-limit rejection rather than the
    /// user - see `Instance::auto_frozen`. Must survive a restart so the
    /// queued resume still knows it may clear the freeze itself.
    #[serde(default)]
    pub auto_frozen: bool,
    /// Mirrors `Instance::closing` (todo 625). Round-trips to disk, but
    /// `populate_registry` always clears it to `false` on load: a stale
    /// mid-close flag would make a healthy session look stuck-closing
    /// forever, whereas clearing it just means `/close` re-flags it.
    #[serde(default)]
    pub closing_flagged: bool,
}

/// Best-effort write of every live Interactive entry to `path`. Failures
/// are logged, never propagated: a chat turn must not crash because the
/// snapshot file is read-only or full.
///
/// Guards against wiping the snapshot: a legitimate close removes ONE session
/// per call, so the count only ever drops by 1 per save. A save that would
/// jump straight from several entries to zero means the in-memory registry
/// itself is anomalously empty (e.g. a startup race, or a bug reordering the
/// restore-from-disk step) rather than the user actually closing every chat
/// at once — refuse that write and keep the on-disk history intact. Only
/// blocks the many-to-zero case; a single lingering chat can still close
/// normally down to zero.
pub fn save_snapshot(registry: &Registry, path: &Path) {
    let snapshot: Vec<PersistedInteractive> = registry
        .list()
        .into_iter()
        .filter(|i| matches!(i.kind, InstanceKind::Interactive) && i.ended_at.is_none())
        // `name` here is the resolved title (curated override or first prompt);
        // re-persisting it means disk converges to a /close rename on the next
        // save. The jsonl override stays the source of truth — this snapshot is
        // just a cache so a session shows its name before its transcript is
        // re-resolved on restore.
        .map(|i| PersistedInteractive {
            session_id: i.session_id,
            cwd: i.cwd,
            project_id: i.project_id,
            name: i.name,
            model: i.model,
            effort: i.effort,
            started_at: i.started_at,
            account_id: i.account_id,
            awaiting: i.awaiting,
            jarvis: i.jarvis,
            worker_of: i.worker_of,
            frozen: i.frozen,
            frozen_needs_continue: i.frozen_needs_continue,
            auto_frozen: i.auto_frozen,
            closing_flagged: i.closing,
        })
        .collect();
    if snapshot.is_empty() && load_snapshot(path).len() > 1 {
        log::warn!(
            "persist sessions: refusing to overwrite non-empty snapshot at {} with an empty one; \
             registry looks unexpectedly empty, leaving the on-disk history untouched",
            path.display()
        );
        return;
    }
    let json = match serde_json::to_string_pretty(&snapshot) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("persist sessions: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("persist sessions: write failed: {e}");
    }
}

/// Convenience wrapper: resolve the default snapshot path and call
/// [`save_snapshot`]. Used by IPC handlers that mutate Interactive state.
pub fn save_snapshot_default(registry: &Registry) {
    let path = match crate::settings::paths::interactive_sessions_file() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("persist sessions: path: {e}");
            return;
        }
    };
    save_snapshot(registry, &path);
}

pub fn load_snapshot(path: &Path) -> Vec<PersistedInteractive> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => {
            // Distinguishes "no snapshot file at all" (first run, or the file
            // was never written) from "file present but 0/N entries" below -
            // both used to collapse into a silent empty Vec, which made a
            // "restored 8 sessions" -> "no restored line" transition between
            // two daemon restarts un-diagnosable from daemon.log alone.
            log::info!("persist sessions: no snapshot file at {}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_str::<Vec<PersistedInteractive>>(&raw) {
        Ok(v) => {
            log::info!(
                "persist sessions: loaded snapshot at {} with {} entries",
                path.display(),
                v.len()
            );
            v
        }
        Err(e) => {
            // Preserve the corrupt file for diagnosis instead of letting the next
            // save_snapshot silently clobber it (mirrors settings::store::load).
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.broken-{ts}"));
            let _ = fs::rename(path, &backup);
            log::warn!("persist sessions: parse failed ({e}); preserved at {} and loaded none", backup.display());
            Vec::new()
        }
    }
}

/// Replay a loaded snapshot into the registry. Entries whose cwd is gone
/// from disk are skipped (project deleted off the machine - resuming would
/// fail anyway). All others are upserted as inactive Interactive entries
/// with `busy: false`.
pub fn populate_registry(registry: &Registry, sessions: Vec<PersistedInteractive>) -> usize {
    let mut added = 0usize;
    for s in sessions {
        if !s.cwd.exists() {
            continue;
        }
        registry.upsert_interactive(&s.session_id, &s.cwd, &s.project_id, &s.started_at);
        if !s.model.is_empty() || !s.effort.is_empty() {
            registry.set_model_effort(&s.session_id, &s.model, &s.effort);
        }
        if let Some(account_id) = &s.account_id {
            registry.set_account(&s.session_id, account_id);
        }
        if s.awaiting.is_some() {
            registry.set_awaiting(&s.session_id, s.awaiting.clone());
        }
        if s.jarvis {
            registry.set_jarvis(&s.session_id, true);
        }
        if s.worker_of.is_some() {
            registry.set_worker_of(&s.session_id, s.worker_of.clone());
        }
        if s.frozen {
            registry.set_frozen(&s.session_id, true);
        }
        if s.frozen_needs_continue {
            registry.set_frozen_needs_continue(&s.session_id, true);
        }
        if s.auto_frozen {
            registry.set_auto_frozen(&s.session_id, true);
        }
        // Intentionally never restored - see `closing_flagged`'s doc comment.
        if s.closing_flagged {
            log::info!(
                "persist sessions: session {} restored with closing_flagged=true; clearing to false",
                s.session_id
            );
        }
        // A /close rename written since the last save lives in the transcript,
        // so a fresh override beats everything; then the AI milestone title (so
        // a chat that re-titled itself keeps that name across a restart); then
        // the persisted snapshot name; and only if none exist do we derive from
        // the first prompt. This is what makes a rename survive an app restart.
        let tpath = crate::tokens::transcript_for_session(&s.cwd, &s.session_id);
        let resolved_name = tpath
            .as_deref()
            .and_then(|p| crate::tokens::last_override_title(p, 60))
            .or_else(|| tpath.as_deref().and_then(|p| crate::tokens::ai_milestone_title(p, 60)))
            .or(s.name)
            .or_else(|| tpath.as_deref().and_then(|p| crate::tokens::first_user_prompt(p, 60)));
        if let Some(name) = resolved_name {
            registry.set_name(&s.session_id, name);
        }
        added += 1;
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn save_then_load_roundtrip() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("sess-1", &cwd, "proj-x", "2026-05-13T00:00:00Z");
        registry.set_model_effort("sess-1", "opus", "high");
        registry.set_name("sess-1", "First chat".into());

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "sess-1");
        assert_eq!(loaded[0].model, "opus");
        assert_eq!(loaded[0].effort, "high");
        assert_eq!(loaded[0].name.as_deref(), Some("First chat"));
    }

    #[test]
    fn populate_skips_missing_cwd() {
        let registry = Registry::new();
        let sessions = vec![PersistedInteractive {
            session_id: "ghost".into(),
            cwd: PathBuf::from("/definitely/does/not/exist/abc123"),
            project_id: "p".into(),
            name: None,
            model: String::new(),
            effort: String::new(),
            started_at: "2026-05-13T00:00:00Z".into(),
            account_id: None,
            awaiting: None,
            jarvis: false,
            worker_of: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            closing_flagged: false,
        }];
        let added = populate_registry(&registry, sessions);
        assert_eq!(added, 0);
        assert!(registry.get("ghost").is_none());
    }

    #[test]
    fn account_id_persists_through_snapshot_roundtrip() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("sess-1", &cwd, "proj-x", "2026-07-07T00:00:00Z");
        registry.set_account("sess-1", "acct-work");

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded[0].account_id.as_deref(), Some("acct-work"));

        // Replaying into a fresh registry must restore the attribution.
        let registry2 = Registry::new();
        populate_registry(&registry2, loaded);
        assert_eq!(registry2.get("sess-1").unwrap().account_id.as_deref(), Some("acct-work"));
    }

    /// todo 625: `closing` now round-trips to disk but must still reconcile
    /// to `false` on restart, not resurrect a session as stuck-closing.
    #[test]
    fn closing_flagged_persists_but_reconciles_to_false_on_restart() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("sess-1", &cwd, "proj-x", "2026-08-16T00:00:00Z");
        registry.set_closing("sess-1", true);

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert!(loaded[0].closing_flagged, "closing_flagged must round-trip to disk");

        // Simulate a daemon restart: fresh registry, replay the snapshot.
        let registry2 = Registry::new();
        populate_registry(&registry2, loaded);
        assert!(
            !registry2.get("sess-1").unwrap().closing,
            "a stale mid-close flag must clear to false on restart"
        );
    }

    /// Regression: a daemon restart used to wipe every backgrounded chat's
    /// self-reported status ("question"/"waiting") back to "Done" because the
    /// snapshot never carried `awaiting`.
    #[test]
    fn awaiting_persists_through_snapshot_roundtrip() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("sess-q", &cwd, "proj-x", "2026-07-11T00:00:00Z");
        registry.set_awaiting("sess-q", Some("question".into()));

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded[0].awaiting.as_deref(), Some("question"));

        let registry2 = Registry::new();
        populate_registry(&registry2, loaded);
        assert_eq!(
            registry2.get("sess-q").unwrap().awaiting.as_deref(),
            Some("question"),
            "restored session must keep its Input-needed state across a daemon restart"
        );
    }

    /// Old snapshots (no `awaiting` key) must still load, as None.
    #[test]
    fn snapshot_without_awaiting_field_loads_as_none() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().replace('\\', "\\\\");
        let path = tmp.path().join("snap.json");
        let json = format!(
            r#"[{{"session_id":"old","cwd":"{cwd}","project_id":"p","name":null,"model":"opus","effort":"high","started_at":"2026-07-01T00:00:00Z"}}]"#
        );
        std::fs::write(&path, json).unwrap();
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].awaiting.is_none());
    }

    #[test]
    fn save_excludes_ended_entries() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("live", &cwd, "p", "2026-05-13T00:00:00Z");
        registry.upsert_interactive("dead", &cwd, "p", "2026-05-13T00:00:00Z");
        registry.mark_ended("dead", crate::types::EndReason::Manual, "2026-05-13T01:00:00Z");

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "live");
    }

    /// Regression for the incident where an unexpectedly-empty registry (a
    /// startup race, a bug) overwrote a healthy multi-session snapshot with
    /// `[]`, permanently losing every previously-known chat.
    #[test]
    fn save_refuses_to_wipe_a_populated_snapshot() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("s1", &cwd, "p", "2026-07-10T00:00:00Z");
        registry.upsert_interactive("s2", &cwd, "p", "2026-07-10T00:00:00Z");
        registry.upsert_interactive("s3", &cwd, "p", "2026-07-10T00:00:00Z");
        save_snapshot(&registry, &path);
        assert_eq!(load_snapshot(&path).len(), 3);

        // A second, unrelated, anomalously-empty registry tries to save over it.
        let empty_registry = Registry::new();
        save_snapshot(&empty_registry, &path);

        // The original 3 entries must survive untouched.
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 3, "empty save over a populated file must be refused");
    }

    /// Freeze is orthogonal to `ended_at`, so a frozen session must survive
    /// a save/load roundtrip like any other live Interactive entry.
    #[test]
    fn save_includes_frozen_entries() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("frozen-1", &cwd, "p", "2026-08-05T00:00:00Z");
        registry.set_frozen("frozen-1", true);
        registry.set_frozen_needs_continue("frozen-1", true);

        save_snapshot(&registry, &path);
        let loaded = load_snapshot(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "frozen-1");
        assert!(loaded[0].frozen);
        assert!(loaded[0].frozen_needs_continue);

        // Replaying into a fresh registry must restore both flags.
        let registry2 = Registry::new();
        populate_registry(&registry2, loaded);
        let restored = registry2.get("frozen-1").unwrap();
        assert!(restored.frozen, "frozen must survive a daemon restart");
        assert!(restored.frozen_needs_continue);
        assert!(restored.ended_at.is_none(), "frozen must never imply ended");
    }

    /// The guard must not block the legitimate case: closing the single
    /// remaining chat really does mean the snapshot should go to empty.
    #[test]
    fn save_allows_wiping_down_from_a_single_entry() {
        let registry = Registry::new();
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = tmp.path().join("snap.json");

        registry.upsert_interactive("only", &cwd, "p", "2026-07-10T00:00:00Z");
        save_snapshot(&registry, &path);
        assert_eq!(load_snapshot(&path).len(), 1);

        registry.mark_ended("only", crate::types::EndReason::Manual, "2026-07-10T01:00:00Z");
        save_snapshot(&registry, &path);

        assert_eq!(load_snapshot(&path).len(), 0, "closing the last chat must still persist as empty");
    }
}
