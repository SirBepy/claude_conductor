//! Reads `~/.claude/sessions/<pid>.json` to resolve a session's pid.
//!
//! Claude Code writes this file async after starting, so `resolve_session_meta`
//! polls for it.
//!
//! On app startup we also scan the whole directory to re-hydrate the
//! in-memory instance registry for Claude sessions that started while
//! the app was down (or pre-dated the hook install). The registry is
//! in-memory only, so without this scan a restart of the taskbar app
//! would blank every running session from the UI until each one fired
//! a fresh SessionStart hook (which they don't, because Claude only
//! fires it on session creation).

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Parsed shape of `~/.claude/sessions/<pid>.json`. Only the fields we
/// actually consume are extracted; the file carries a handful of other
/// keys we don't need (version, procStart, peerProtocol, ...).
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedSession {
    pub pid: u32,
    pub session_id: String,
    pub cwd: PathBuf,
    /// Epoch milliseconds as written by Claude CLI. Converted to RFC3339
    /// by the caller since that's the shape the registry stores.
    pub started_at_ms: i64,
}

// multi-account audit: stays valid - every profile dir junctions `sessions/`
// back to this shared `~/.claude/sessions`, so a hook-reported pid file lands
// here regardless of which account's CLAUDE_CONFIG_DIR spawned it.
pub fn session_file_for_pid(pid: u32) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions").join(format!("{pid}.json")))
}

/// Scans `~/.claude/sessions/*.json` once for a file whose `sessionId`
/// matches `session_id`, returning its parsed shape. Used to resolve
/// the pid from a SessionStart hook whose payload only
/// gave us `session_id` (Claude Code v2.x stopped including pid).
pub fn find_by_session_id(session_id: &str) -> Option<ScannedSession> {
    let dir = sessions_dir()?;
    let entries = std::fs::read_dir(&dir).ok()?;
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Some(parsed) = parse_session_file(&path) else { continue };
        if parsed.session_id == session_id {
            return Some(parsed);
        }
    }
    None
}

/// Polls `find_by_session_id` for up to ~15s. Claude writes the
/// session file shortly after the SessionStart hook fires, so the
/// first attempt usually misses.
pub async fn resolve_session_meta(session_id: &str) -> Option<ScannedSession> {
    let owned = session_id.to_string();
    for _ in 0..30 {
        let sid = owned.clone();
        let found = tokio::task::spawn_blocking(move || find_by_session_id(&sid))
            .await
            .ok()
            .flatten();
        if let Some(s) = found { return Some(s); }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

/// Resolves the sessions directory. Returns `None` only if the user has
/// no home directory, which would be a pathologically broken setup.
// multi-account audit: stays valid - same shared junctioned dir as
// `session_file_for_pid` above.
pub fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions"))
}

/// Parses a single session file into our minimal shape. Returns `None`
/// if the file is missing, unreadable, not JSON, or missing a required
/// field; stale entries from dead sessions (e.g. 5072.json lingering
/// after Claude exits without cleanup) are surfaced so the caller can
/// filter by live-pid.
pub fn parse_session_file(path: &Path) -> Option<ScannedSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let pid = v.get("pid").and_then(|x| x.as_u64())? as u32;
    let session_id = v.get("sessionId").and_then(|x| x.as_str())?.to_string();
    let cwd = v.get("cwd").and_then(|x| x.as_str())?;
    let started_at_ms = v.get("startedAt").and_then(|x| x.as_i64()).unwrap_or(0);
    Some(ScannedSession {
        pid,
        session_id,
        cwd: PathBuf::from(cwd),
        started_at_ms,
    })
}

/// Scans `~/.claude/sessions/*.json` and returns only entries whose
/// pid refers to the same process that originally wrote the file.
///
/// Windows recycles pids aggressively, so a session file lingering
/// from a long-dead Claude run will appear "live" whenever its old
/// pid gets reused by some unrelated process. We defend against that
/// by matching each pid's current process start time against the
/// `startedAt` in the session file, within `tolerance_secs` (60s is
/// wide enough to absorb clock skew but narrow enough to never
/// collide with a reused pid running for more than a minute).
///
/// `live_processes` is a caller-supplied map from pid to process
/// start time in unix-epoch seconds, so tests can inject synthetic
/// data without touching sysinfo.
pub fn scan_live_sessions(
    live_processes: &std::collections::HashMap<u32, u64>,
) -> Vec<ScannedSession> {
    scan_live_sessions_with_tolerance(live_processes, 60)
}

pub fn scan_live_sessions_with_tolerance(
    live_processes: &std::collections::HashMap<u32, u64>,
    tolerance_secs: u64,
) -> Vec<ScannedSession> {
    let Some(dir) = sessions_dir() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Some(parsed) = parse_session_file(&path) else { continue };
        let Some(proc_start_secs) = live_processes.get(&parsed.pid).copied() else { continue };
        let file_start_secs = (parsed.started_at_ms / 1000) as u64;
        let diff = proc_start_secs.abs_diff(file_start_secs);
        if diff > tolerance_secs { continue; }
        out.push(parsed);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_session(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn parse_session_file_extracts_required_fields() {
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "1234.json",
            r#"{"pid":1234,"sessionId":"abc","cwd":"C:\\x","startedAt":1776868109727,"version":"2.1.117"}"#,
        );
        let got = parse_session_file(&dir.path().join("1234.json")).unwrap();
        assert_eq!(got.pid, 1234);
        assert_eq!(got.session_id, "abc");
        assert_eq!(got.cwd, PathBuf::from("C:\\x"));
        assert_eq!(got.started_at_ms, 1776868109727);
    }

    #[test]
    fn parse_session_file_ignores_a_bridge_session_id_key() {
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "1.json",
            r#"{"pid":1,"sessionId":"s","cwd":"C:\\x","bridgeSessionId":"bridge-uuid"}"#,
        );
        let got = parse_session_file(&dir.path().join("1.json")).unwrap();
        assert_eq!(got.pid, 1);
        assert_eq!(got.session_id, "s");
    }

    #[test]
    fn parse_session_file_returns_none_for_malformed_or_missing_fields() {
        let dir = tempdir().unwrap();
        write_session(dir.path(), "bad.json", "not json");
        assert!(parse_session_file(&dir.path().join("bad.json")).is_none());

        write_session(dir.path(), "nopid.json", r#"{"sessionId":"s","cwd":"x"}"#);
        assert!(parse_session_file(&dir.path().join("nopid.json")).is_none());

        assert!(parse_session_file(&dir.path().join("missing.json")).is_none());
    }

    #[test]
    fn scan_filters_out_stale_pid_whose_start_time_diverges() {
        // Simulates the Windows pid-recycling case: session file says
        // pid 5072 started at t=1000s, but the live pid 5072 is actually
        // a different process that started at t=9999s.
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "100.json",
            r#"{"pid":100,"sessionId":"fresh","cwd":"C:\\a","startedAt":1000000}"#,
        );
        write_session(
            dir.path(),
            "5072.json",
            r#"{"pid":5072,"sessionId":"stale","cwd":"C:\\b","startedAt":2000000}"#,
        );
        let mut live = std::collections::HashMap::new();
        live.insert(100u32, 1000u64);   // matches (1_000_000ms -> 1000s)
        live.insert(5072u32, 9999u64);  // mismatches (2_000_000ms -> 2000s, diff >> 60)
        let survivors: Vec<ScannedSession> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter_map(|e| parse_session_file(&e.path()))
            .filter(|s| match live.get(&s.pid) {
                Some(&proc_start) => {
                    let file_start = (s.started_at_ms / 1000) as u64;
                    proc_start.abs_diff(file_start) <= 60
                }
                None => false,
            })
            .collect();
        assert_eq!(survivors.len(), 1);
        assert_eq!(survivors[0].session_id, "fresh");
    }
}
