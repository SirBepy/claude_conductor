//! Append-only record of the relay calls the daemon turned down, at
//! `<data_dir>/rejected-sends.jsonl`: `send_message` / `update_message`
//! validation failures, a request body that failed to decode on any route
//! using `ValidatedJson`, and the `ok:false` reply of every other relay route
//! that goes through `reply` (a handler error: bad arguments, an unknown
//! session). Refusals that are expected control flow (a disabled browser, a
//! sub's close refusal, a secret prompt that timed out) answer `ok:false`
//! directly and are not recorded. The chat used to show a
//! "Failed to send" pill per rejection; a caller that retries until it passes
//! stacked six of them, so the chat stays quiet and this file is where a
//! pattern (the same field wrong again and again) gets read, by
//! `scripts/release-report.ps1` at release time.

use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
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
    // Debug, not warn: the jsonl is the record, and a warn would show up a second
    // time in the release report's app-log section.
    log::debug!("relay call rejected ({route}, session {session_id}): {error}");
    let Some(root) = log_root() else { return };
    if let Err(e) = append_in(&root, route, session_id, kind, &clip(error)) {
        log::warn!("rejected-sends: could not write the record: {e}");
    }
}

/// Records one handler error and returns the `{"ok": false, "error": ...}` reply
/// the route sent before it was recorded, byte for byte.
pub(super) fn reply(route: &str, session_id: &str, error: impl Into<String>) -> (StatusCode, Json<Value>) {
    let error = error.into();
    record(route, session_id, None, &error);
    (StatusCode::OK, Json(json!({"ok": false, "error": error})))
}

#[cfg(not(test))]
fn log_root() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok()
}

// The route tests reject on purpose; they must not write into the real data
// dir, so a test writes only after `capture_in` named a temp dir for its thread
// (a current-thread tokio test runs its handler on that same thread).
#[cfg(test)]
thread_local! {
    static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn log_root() -> Option<PathBuf> {
    TEST_ROOT.with(|r| r.borrow().clone())
}

/// Test-only: sends this thread's records to `root` until the guard drops.
#[cfg(test)]
pub(super) struct Capture;

#[cfg(test)]
pub(super) fn capture_in(root: &Path) -> Capture {
    TEST_ROOT.with(|r| *r.borrow_mut() = Some(root.to_path_buf()));
    Capture
}

#[cfg(test)]
impl Drop for Capture {
    fn drop(&mut self) {
        TEST_ROOT.with(|r| *r.borrow_mut() = None);
    }
}

/// Test-only: the records written under `root`, oldest first.
#[cfg(test)]
pub(super) fn read_records(root: &Path) -> Vec<Value> {
    let raw = std::fs::read_to_string(path_in(root)).unwrap_or_default();
    raw.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// A serde decode error embeds the offending value, so a long malformed field
/// would be copied whole into the log.
fn clip(error: &str) -> String {
    const MAX: usize = 500;
    if error.chars().count() <= MAX {
        return error.to_string();
    }
    let head: String = error.chars().take(MAX).collect();
    format!("{head}...")
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
    fn a_long_error_is_clipped_and_a_short_one_is_left_alone() {
        assert_eq!(clip("short"), "short");
        let clipped = clip(&"x".repeat(2000));
        assert_eq!(clipped.chars().count(), 503);
        assert!(clipped.ends_with("..."));
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
