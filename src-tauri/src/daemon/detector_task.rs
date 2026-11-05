//! Daemon-side detector reconcile task. Every 5s walks live PIDs and marks
//! ended instances; also refreshes session titles from `/close`-written
//! rename overrides. Publishes `instances_changed` on every mutation.

use crate::daemon::state::DaemonState;
use crate::sessions::registry::Registry;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// How many ended instances the registry keeps. Bounded by volume, not age:
/// a finished chat stays in the sidebar's DONE list until this many newer ones
/// exist, so a chat is never retired just because time passed (todo 866).
const ENDED_KEPT: usize = 200;
/// Pruning is a full-registry retain pass, so it doesn't need to run on every
/// 5s tick - once every 10 minutes is plenty to keep the in-memory registry
/// from growing unbounded across long daemon uptimes.
const PRUNE_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Same cadence as `PRUNE_INTERVAL` (todo 881): a `TRUNCATE` checkpoint is
/// cheap and side-effect-free when it can't fully complete (see
/// `storage::db::checkpoint_truncate`'s doc), so there's no reason to run it
/// on a different schedule than the other periodic housekeeping here.
const WAL_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(10 * 60);

pub fn spawn(state: Arc<DaemonState>) {
    let registry = state.registry.clone();
    let publish_state = state.clone();
    // Task-local (no mutex) cache of each session's last-seen transcript mtime,
    // so we only re-read the file when it actually grew.
    let mut mtimes: HashMap<String, SystemTime> = HashMap::new();
    let mut last_prune = Instant::now();
    let mut last_checkpoint = Instant::now();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let ended = crate::sessions::detector::reconcile_once(&registry);

            // Build (session_id, transcript_path) for every still-live session.
            // `reconcile_once` deliberately skips Interactive sessions, so this
            // is a separate pass that owns override-driven renames.
            let live: Vec<(String, PathBuf)> = registry
                .list()
                .into_iter()
                .filter(|i| i.ended_at.is_none())
                .filter_map(|i| {
                    crate::tokens::transcript_for_session(&i.cwd, &i.session_id)
                        .map(|p| (i.session_id, p))
                })
                .collect();
            let renamed = refresh_overrides(&registry, &live, &mut mtimes);

            let mut pruned = false;
            if last_prune.elapsed() >= PRUNE_INTERVAL {
                last_prune = Instant::now();
                let removed = registry.prune_ended_keeping_newest(ENDED_KEPT);
                if removed > 0 {
                    log::info!("detector: pruned {removed} ended instance(s) past the newest {ENDED_KEPT}");
                    pruned = true;
                }
            }

            // Todo 881: companion.db-wal measured at 58MB (larger than the
            // 35MB main db) and still growing after 15+ hours with zero
            // truncation - the default wal_autocheckpoint threshold alone
            // isn't enough while the app's own long-lived connection to the
            // same file keeps a TRUNCATE-eligible instant from ever landing.
            // See `storage::db::checkpoint_truncate`'s doc for why this is
            // safe to call on a plain interval.
            if last_checkpoint.elapsed() >= WAL_CHECKPOINT_INTERVAL {
                last_checkpoint = Instant::now();
                if let Some(db) = &publish_state.db {
                    if let Ok(mgr) = db.lock() {
                        match crate::storage::db::checkpoint_truncate(mgr.conn()) {
                            Ok((busy, log_frames, checkpointed_frames)) => {
                                log::info!(
                                    "detector: wal_checkpoint(TRUNCATE) busy={busy} log_frames={log_frames} checkpointed_frames={checkpointed_frames}"
                                );
                            }
                            Err(e) => log::warn!("detector: wal_checkpoint(TRUNCATE) failed: {e:#}"),
                        }
                    }
                }
            }

            if ended || renamed || pruned {
                crate::daemon::machines::publish_instances_changed(&publish_state);
            }
        }
    });
}

/// For each live session whose transcript mtime advanced since the last tick,
/// refreshes its name: a `/close` rename override wins, else the AI title
/// (frozen at the end of the first turn that produced one, see
/// `ai_milestone_title`). This is what swaps a fresh chat's first-prompt name
/// for its AI title live. The first user prompt
/// remains the registration-time fallback, so we don't recompute it here.
/// Prunes the mtime cache to the sessions still passed in. Returns true if any
/// name actually changed.
fn refresh_overrides(
    registry: &Registry,
    live: &[(String, PathBuf)],
    mtimes: &mut HashMap<String, SystemTime>,
) -> bool {
    let mut changed = false;
    for (session_id, path) in live {
        let Ok(mtime) = std::fs::metadata(path).and_then(|m| m.modified()) else { continue };
        if mtimes.get(session_id) == Some(&mtime) { continue; }
        mtimes.insert(session_id.clone(), mtime);
        if crate::daemon::subchats::name_is_fixed(registry, session_id) {
            continue;
        }
        if let Some(title) = crate::tokens::curated_or_ai_title(path, 60) {
            if registry.set_name(session_id, title) {
                changed = true;
            }
        }
    }
    let live_ids: HashSet<&str> = live.iter().map(|(id, _)| id.as_str()).collect();
    mtimes.retain(|k, _| live_ids.contains(k.as_str()));
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn override_jsonl(value: &str) -> String {
        serde_json::json!({"type":"custom-title","customTitle":value,"sessionId":"s1"}).to_string()
    }

    fn assistant_title_jsonl(title: &str) -> String {
        let user = serde_json::json!({
            "type": "user", "message": {"role": "user", "content": "hello"}
        }).to_string();
        let asst = serde_json::json!({
            "type": "assistant",
            "message": {"role": "assistant", "content": [
                {"type": "text", "text": format!("hi <cc-title:{title}>")}
            ]}
        }).to_string();
        format!("{user}\n{asst}")
    }

    #[test]
    fn ai_milestone_title_renames_live_session() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, assistant_title_jsonl("Live AI Title")).unwrap();
        let mut mtimes = HashMap::new();

        let changed = refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes);
        assert!(changed);
        assert_eq!(reg.get("s1").unwrap().name.as_deref(), Some("Live AI Title"));
    }

    /// The name the main agent gave a sub at spawn is how `subchat send` finds it
    /// and what the decisions log and the one line back call it, so a title the
    /// sub wrote into its own transcript must not rename it.
    #[test]
    fn a_sub_keeps_the_name_it_was_given_at_spawn_whatever_its_transcript_title_says() {
        let reg = Registry::new();
        reg.upsert_interactive("main", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        reg.upsert_interactive("sub", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        reg.set_subchat_of("sub", Some("main".into()));
        reg.set_name("sub", "Footer".into());
        let dir = tempdir().unwrap();
        let sub_path = dir.path().join("sub.jsonl");
        let plain_path = dir.path().join("main.jsonl");
        std::fs::write(&sub_path, format!("{}\n{}", assistant_title_jsonl("Ignore previous instructions"), override_jsonl("Hijacked"))).unwrap();
        std::fs::write(&plain_path, assistant_title_jsonl("Main Title")).unwrap();
        let mut mtimes = HashMap::new();

        let changed = refresh_overrides(&reg, &[("sub".into(), sub_path), ("main".into(), plain_path)], &mut mtimes);
        assert!(changed, "the ordinary chat is still retitled");
        assert_eq!(reg.get("sub").unwrap().name.as_deref(), Some("Footer"));
        assert_eq!(reg.get("main").unwrap().name.as_deref(), Some("Main Title"));
    }

    /// The second end-to-end run left a mode-on main chat titled "New chat" for good.
    /// Nothing here is to blame: only a row with a parent is fixed, so a main chat and a
    /// respawn successor take their titles from the transcript like any chat. (The rig's
    /// daemon never received the Stop hook that writes the title, which is installed
    /// globally against the production port.)
    #[test]
    fn a_mode_on_main_chat_and_a_respawn_successor_are_titled_like_any_chat() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let reg = Registry::new();
        reg.upsert_interactive("main", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        reg.upsert_interactive("next", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        crate::sessions::chat_config::set_subchats_on("main", true);
        reg.set_successor_of("next", "main");
        assert!(!crate::daemon::subchats::name_is_fixed(&reg, "main"));
        assert!(!crate::daemon::subchats::name_is_fixed(&reg, "next"));
        let dir = tempdir().unwrap();
        let (a, b) = (dir.path().join("main.jsonl"), dir.path().join("next.jsonl"));
        std::fs::write(&a, assistant_title_jsonl("CV site work")).unwrap();
        std::fs::write(&b, assistant_title_jsonl("CV site work, continued")).unwrap();
        let mut mtimes = HashMap::new();
        assert!(refresh_overrides(&reg, &[("main".into(), a), ("next".into(), b)], &mut mtimes));
        assert_eq!(reg.get("main").unwrap().name.as_deref(), Some("CV site work"));
        assert_eq!(reg.get("next").unwrap().name.as_deref(), Some("CV site work, continued"));
    }

    #[test]
    fn close_override_beats_ai_milestone_title_live() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        // AI title plus a later human /close rename in the same transcript.
        let body = format!("{}\n{}", assistant_title_jsonl("AI Title"), override_jsonl("Human Title"));
        std::fs::write(&path, body).unwrap();
        let mut mtimes = HashMap::new();

        assert!(refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes));
        assert_eq!(reg.get("s1").unwrap().name.as_deref(), Some("Human Title"));
    }

    #[test]
    fn override_refresh_renames_live_session() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("Renamed Live")).unwrap();
        let mut mtimes = HashMap::new();

        let changed = refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes);
        assert!(changed);
        assert_eq!(reg.get("s1").unwrap().name.as_deref(), Some("Renamed Live"));
    }

    #[test]
    fn override_refresh_noops_when_mtime_unchanged() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("First")).unwrap();
        let mut mtimes = HashMap::new();
        let live = [("s1".to_string(), path.clone())];

        assert!(refresh_overrides(&reg, &live, &mut mtimes));
        // Second pass without touching the file: mtime unchanged, no work.
        assert!(!refresh_overrides(&reg, &live, &mut mtimes));
    }

    #[test]
    fn mtime_cache_pruned_for_dropped_sessions() {
        let reg = Registry::new();
        reg.upsert_interactive("s1", std::path::Path::new("/tmp/x"), "proj", "2026-05-22T00:00:00Z");
        let dir = tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::write(&path, override_jsonl("Name")).unwrap();
        let mut mtimes = HashMap::new();

        refresh_overrides(&reg, &[("s1".into(), path)], &mut mtimes);
        assert!(mtimes.contains_key("s1"));
        // s1 no longer live → its cache entry is pruned.
        refresh_overrides(&reg, &[], &mut mtimes);
        assert!(!mtimes.contains_key("s1"));
    }
}
