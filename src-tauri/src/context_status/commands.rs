//! Tauri-command layer for context-window status: resolves transcripts from
//! the app's mirrored instance cache (never the daemon registry directly) and
//! runs them through the shared scorer in `context_status.rs`.

use super::{compute_context_status, ContextStatus};

/// Resolves a session's transcript path from the app's mirrored instance
/// cache. The daemon registry isn't directly reachable here; `cached_instances`
/// is the app-side mirror refreshed via `instances_changed`.
fn resolve_session_transcript(
    state: &crate::state::AppState,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let instances = state.cached_instances.lock().unwrap();
    instances
        .iter()
        .find(|i| i.session_id == session_id)
        .and_then(|inst| {
            inst.transcript_path
                .as_ref()
                .filter(|p| p.exists())
                .cloned()
                .or_else(|| walker::transcript_for_session(&inst.cwd, session_id))
        })
}

/// Fallback for when the mirrored instance cache doesn't resolve a transcript:
/// scans `~/.claude/projects/*/<session_id>.jsonl` directly. Blocking - call
/// from within `spawn_blocking`. `pub(super)`: also used by the daemon-side
/// `resolve_transcript` in the parent module.
pub(super) fn scan_projects_for_session(session_id: &str) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let projects = walker::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Daemon-aligned context-window status for a session. The transcript lives on
/// local disk, so the app resolves it itself (cwd from the mirrored instance
/// cache, else a project-dir scan) and runs the same core scorer the daemon's
/// `/context` endpoint uses. Returns None when unresolved or no usage lines.
#[tauri::command]
pub async fn context_status(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<ContextStatus>, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let status = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = resolved {
            return compute_context_status(&path);
        }
        // Fallback: scan ~/.claude/projects/*/<session_id>.jsonl directly.
        let candidate = scan_projects_for_session(&session_id)?;
        compute_context_status(&candidate)
    })
    .await
    .map_err(|e| format!("context_status join error: {e}"))?;

    Ok(status)
}

/// Scans a transcript for the most recent line carrying a non-empty `cwd`.
/// Claude Code writes the CLI's working directory on every `user`/`assistant`
/// line (`last-prompt`/`mode` rows omit it); this differs from the
/// daemon-recorded spawn dir once inside a worktree.
fn last_transcript_cwd(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Returns the session's *live* working directory - the last `cwd` recorded in
/// its transcript - so git chips can follow the AI into a worktree instead of
/// pinning to the spawn dir. Resolves the transcript the same way
/// `context_status` does (mirrored instance cache, else a project-dir scan).
#[tauri::command]
pub async fn session_live_cwd(
    session_id: String,
    fallback: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let cwd = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        let path = resolved.or_else(|| scan_projects_for_session(&session_id))?;
        last_transcript_cwd(&path)
    })
    .await
    .map_err(|e| format!("session_live_cwd join error: {e}"))?;

    Ok(cwd.unwrap_or(fallback))
}

#[cfg(test)]
mod live_cwd_tests {
    use super::last_transcript_cwd;
    use std::io::Write;

    fn write_tmp(name: &str, body: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("cc_livecwd_{name}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn returns_last_line_cwd() {
        let path = write_tmp(
            "last",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\
             {\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn skips_trailing_lines_without_cwd() {
        // `last-prompt`/`mode` rows carry no cwd; the scan must fall back to the
        // most recent line that does.
        let path = write_tmp(
            "skip",
            "{\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n\
             {\"type\":\"last-prompt\"}\n\
             {\"type\":\"mode\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn none_when_no_cwd_anywhere() {
        let path = write_tmp("nocwd", "{\"type\":\"mode\"}\n{\"type\":\"summary\"}\n");
        assert_eq!(last_transcript_cwd(&path), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ignores_empty_cwd_and_blank_lines() {
        let path = write_tmp(
            "empty",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\n{\"type\":\"assistant\",\"cwd\":\"\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo"));
        std::fs::remove_file(&path).ok();
    }
}
