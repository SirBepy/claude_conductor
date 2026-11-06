//! Append-only record of every MCP relay call the daemon turned down
//! (`ok:false`), at `<data_dir>/rejected-sends.jsonl`. The chat used to show a
//! "Failed to send" pill per rejection; a caller that retries until it passes
//! stacked six of them, so the chat stays quiet and this file is where a
//! pattern (the same field wrong again and again) gets read, by
//! `scripts/release-report.ps1` at release time.

use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Past this size the file moves to `.old` (replacing the last one), so the
/// log never grows without bound and a report still sees recent history.
const ROTATE_BYTES: u64 = 512 * 1024;

/// Serializes the size check, rotation and append within the process.
static LOCK: Mutex<()> = Mutex::new(());

fn path_in(root: &Path) -> PathBuf {
    root.join("rejected-sends.jsonl")
}

/// Records one rejection. Never fails the caller: a log that cannot be written
/// only costs the record.
pub(super) fn record(route: &str, session_id: &str, kind: Option<&str>, error: &str) {
    log::warn!("relay call rejected ({route}, session {session_id}): {error}");
    // The route tests reject on purpose; they must not write into the real data dir.
    if cfg!(test) {
        return;
    }
    let Ok(root) = crate::settings::paths::data_dir() else { return };
    if let Err(e) = append_in(&root, route, session_id, kind, error) {
        log::warn!("rejected-sends: could not write the record: {e}");
    }
}

fn append_in(root: &Path, route: &str, session_id: &str, kind: Option<&str>, error: &str) -> std::io::Result<()> {
    use std::io::Write;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = path_in(root);
    std::fs::create_dir_all(root)?;
    if std::fs::metadata(&path).map(|m| m.len() > ROTATE_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("jsonl.old"));
    }
    let line = json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "route": route,
        "session_id": session_id,
        "kind": kind,
        "error": error,
    });
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{line}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejection_is_one_json_line_with_its_route_and_reason() {
        let dir = tempfile::tempdir().unwrap();
        append_in(dir.path(), "/messages/send", "s1", Some("report"), "text is 250 chars, over report's 200").unwrap();
        append_in(dir.path(), "/messages/send", "s1", None, "verdict is required").unwrap();
        let raw = std::fs::read_to_string(path_in(dir.path())).unwrap();
        let lines: Vec<serde_json::Value> = raw.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["kind"], "report");
        assert_eq!(lines[0]["route"], "/messages/send");
        assert!(lines[0]["error"].as_str().unwrap().contains("over report's 200"));
        assert!(lines[1]["kind"].is_null());
    }

    #[test]
    fn an_oversized_log_rotates_to_old_and_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path_in(dir.path()), vec![b'x'; (ROTATE_BYTES + 1) as usize]).unwrap();
        append_in(dir.path(), "/messages/send", "s", None, "e").unwrap();
        assert!(path_in(dir.path()).with_extension("jsonl.old").exists());
        let fresh = std::fs::read_to_string(path_in(dir.path())).unwrap();
        assert_eq!(fresh.lines().count(), 1);
    }
}
