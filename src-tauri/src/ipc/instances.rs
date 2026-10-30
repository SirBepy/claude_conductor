//! Instance listing and per-session transcript-stats IPC commands, split out
//! of `ipc/projects.rs` (todo 941) along that file's own `// --- Instances
//! ---` section seam, matching the precedent set by `ipc/token_source.rs`
//! (todo 630).

use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_instances(state: State<'_, AppState>) -> Result<Vec<crate::types::Instance>, String> {
    Ok(state.cached_instances.lock().unwrap().clone())
}

#[tauri::command]
pub async fn is_daemon_connected(state: State<'_, AppState>) -> Result<bool, ()> {
    Ok(state.client().await.is_some())
}

#[tauri::command]
pub async fn list_instances_for_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::types::Instance>, String> {
    Ok(state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .filter(|i| i.project_id == project_id)
        .cloned()
        .collect())
}

/// The only transcript a session-keyed stats call may read: the recorded path,
/// else the file named after this session id. Never the newest file in the
/// shared project dir - that belongs to a neighbouring session (todo 660: a
/// 1-message chat rendered a peer's `14 msgs / 448 turns` until its own existed).
pub(crate) fn stats_transcript_path(
    recorded: Option<&std::path::Path>,
    project_dir: &std::path::Path,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    if let Some(p) = recorded.filter(|p| p.exists()) {
        return Some(p.to_path_buf());
    }
    let own = project_dir.join(format!("{session_id}.jsonl"));
    if own.exists() { Some(own) } else { None }
}

/// Token/turn/prompt totals for one session's transcript, or the all-zero
/// answer when no transcript resolves. Blocking (walks the whole JSONL file):
/// shared by the desktop `instance_token_stats` command and the daemon RPC of
/// the same name, which answers it for a chat mirrored from a paired machine.
pub(crate) fn token_stats_for_session(
    cwd: &std::path::Path,
    recorded: Option<&std::path::Path>,
    session_id: &str,
) -> serde_json::Value {
    let empty = serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 });
    // The recorded path alone is enough when it still exists, so a machine with
    // no projects dir at all still answers for a chat whose transcript it recorded.
    let path = recorded.filter(|p| p.exists()).map(std::path::Path::to_path_buf).or_else(|| {
        let projects = crate::tokens::claude_projects_dir()?;
        let project_dir = projects.join(crate::tokens::encode_cwd_as_project_dir(cwd));
        stats_transcript_path(None, &project_dir, session_id)
    });
    let Some(path) = path else { return empty };
    let t = crate::tokens::parse_transcript(&path);
    let total = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens;
    serde_json::json!({
        "tokens": total,
        "turns": t.turns,
        "prompts": t.user_prompts,
    })
}

/// Token/turn/prompt totals for one session's transcript.
///
/// `async` is load-bearing, not stylistic: a sync `#[tauri::command]` runs on
/// the main thread, and `parse_transcript` walks the whole JSONL file. On a
/// tens-of-megabytes transcript that froze the window outright, and the
/// statusbar re-fires this on mount and after every completed turn.
#[tauri::command]
pub async fn instance_token_stats(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // A chat mirrored from a paired machine has its transcript on that
    // machine's disk; the daemon forwards the read there by session id.
    if let Some(stats) =
        token_stats_forwarded(&session_id, &state.cached_instances, state.client().await).await
    {
        return Ok(stats);
    }
    let inst = {
        let instances = state.cached_instances.lock().unwrap();
        instances.iter().find(|i| i.session_id == session_id).cloned()
    };
    let Some(inst) = inst else {
        return Ok(serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 }));
    };

    tauri::async_runtime::spawn_blocking(move || {
        token_stats_for_session(&inst.cwd, inst.transcript_path.as_deref(), &inst.session_id)
    })
    .await
    .map_err(|e| format!("instance_token_stats join error: {e}"))
}

/// The mirrored branch of `instance_token_stats`: `Some` with the host's totals
/// (zeroes when that read fails) for a chat mirrored from a paired machine,
/// `None` when the chat is local. Split out with its two `AppState` inputs
/// passed in so a test can drive it with a fake client.
async fn token_stats_forwarded<C: crate::ipc::mirror::MirrorReads>(
    session_id: &str,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Option<serde_json::Value> {
    let client = crate::ipc::mirror::route_mirrored(instances, Some(session_id), client)?;
    Some(client.instance_token_stats(session_id).await.unwrap_or_else(|e| {
        log::warn!("instance_token_stats: mirrored session {session_id} read failed: {e}");
        serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 })
    }))
}

#[cfg(test)]
mod mirrored_branch_tests {
    use super::*;
    use crate::ipc::mirror::fake::{instance_cache, FakeMirror, PEER_TOKENS};

    #[tokio::test]
    async fn a_mirrored_row_reads_the_stats_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let stats = token_stats_forwarded("mirror-1", &cache, Some(fake.clone())).await.expect("a mirrored row forwards");

        assert_eq!(stats["tokens"], PEER_TOKENS);
        assert_eq!(fake.calls(), [("instance_token_stats".into(), "mirror-1".into(), "".into())]);
    }

    #[tokio::test]
    async fn a_client_error_reads_as_zero_stats() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let stats = token_stats_forwarded("mirror-1", &cache, Some(fake.clone())).await.expect("a mirrored row forwards");

        assert_eq!(stats, serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 }));
        assert_eq!(fake.calls().len(), 1, "the failed read must have been attempted, not skipped");
    }

    #[tokio::test]
    async fn a_local_session_never_touches_the_client() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        assert!(token_stats_forwarded("local-1", &cache, Some(fake.clone())).await.is_none());
        assert!(fake.calls().is_empty());
    }
}

#[cfg(test)]
mod stats_transcript_tests {
    use super::stats_transcript_path;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn write_session(dir: &Path, id: &str, prompts: usize, turns: usize) -> PathBuf {
        let path = dir.join(format!("{id}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        for _ in 0..prompts {
            writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"hi"}}}}"#).unwrap();
        }
        for _ in 0..turns {
            writeln!(f, r#"{{"type":"assistant","message":{{"usage":{{"output_tokens":1}}}}}}"#).unwrap();
        }
        path
    }

    #[test]
    fn never_serves_a_neighbouring_sessions_counts() {
        let dir = tempfile::tempdir().unwrap();
        let small = write_session(dir.path(), "small-session", 1, 2);
        // Written last, so it is the newest .jsonl in the shared project dir -
        // exactly what the old latest_transcript_for_cwd fallback returned.
        let big = write_session(dir.path(), "big-session", 14, 448);

        let b = crate::tokens::parse_transcript(&big);
        assert_eq!((b.user_prompts, b.turns), (14, 448));

        let resolved = stats_transcript_path(None, dir.path(), "small-session").unwrap();
        assert_eq!(resolved, small);
        let s = crate::tokens::parse_transcript(&resolved);
        assert_eq!((s.user_prompts, s.turns), (1, 2));

        // A brand-new chat has no transcript yet: nothing, never the neighbour.
        assert_eq!(stats_transcript_path(None, dir.path(), "fresh-session"), None);
    }

    #[test]
    fn prefers_the_recorded_path_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let recorded = write_session(dir.path(), "recorded", 3, 4);
        write_session(dir.path(), "sid", 9, 9);
        let resolved = stats_transcript_path(Some(&recorded), dir.path(), "sid").unwrap();
        assert_eq!(resolved, recorded);
        assert_eq!(stats_transcript_path(Some(Path::new("nope.jsonl")), dir.path(), "sid"),
            Some(dir.path().join("sid.jsonl")));
    }
}
