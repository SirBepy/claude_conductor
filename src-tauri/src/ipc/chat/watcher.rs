//! Real-time file watcher for external (read-only) session transcripts.
//!
//! When the Sessions view opens an External session, `watch_session_transcript`
//! tails its JSONL file from EOF and emits `chat-watch:<id>` Tauri events for
//! every new complete line. The frontend event store listens on `chat-watch:<id>`
//! via `ensureWatchListener` and forwards events to the renderer.
//!
//! If the JSONL doesn't exist yet (session just opened, user hasn't typed
//! anything), we watch the expected project directory for the file to appear.
//!
//! `unwatch_session_transcript` drops the watcher and aborts the tail task.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

struct WatchHandle {
    _watcher: RecommendedWatcher,
    task: tokio::task::JoinHandle<()>,
}

fn watchers() -> &'static Mutex<HashMap<String, WatchHandle>> {
    static W: OnceLock<Mutex<HashMap<String, WatchHandle>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Guards the race where a rapid switch-away unwatches a session before its
/// still-in-flight `watch_session_transcript` call has registered - without
/// this, that call would insert its `WatchHandle` anyway once it finishes,
/// leaking a live FS watcher + tail task forever (no TTL on this side).
fn generations() -> &'static Mutex<HashMap<String, u64>> {
    static G: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bump_generation(session_id: &str) -> u64 {
    let mut g = generations().lock().unwrap();
    let next = g.get(session_id).copied().unwrap_or(0) + 1;
    g.insert(session_id.to_string(), next);
    next
}

fn current_generation(session_id: &str) -> u64 {
    generations().lock().unwrap().get(session_id).copied().unwrap_or(0)
}

/// Start tailing `session_id`'s JSONL transcript, emitting
/// `chat-watch:<session_id>` Tauri events for each new complete line.
///
/// If the transcript doesn't exist yet (session just opened), watches the
/// expected project directory and picks up the file when it appears.
///
/// Idempotent: calling again replaces any existing watcher for the session.
#[tauri::command]
pub async fn watch_session_transcript(
    app: AppHandle,
    session_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    super::attachments::validate_session_id(&session_id)?;

    // Replace any existing watcher for this session.
    stop_watcher(&session_id);
    let my_gen = bump_generation(&session_id);

    let sid = session_id.clone();
    let c = cwd.clone();

    // Locate transcript. If not found, derive the expected parent directory
    // from cwd so we can watch for the file to appear when it's first written.
    let (watch_dir, found_path) = tauri::async_runtime::spawn_blocking(move || {
        match crate::chat::history::locate_transcript(&sid, c.as_deref()) {
            Ok(p) => {
                let parent = p.parent().map(|d| d.to_path_buf());
                (parent, Some(p))
            }
            Err(_) => {
                // File not created yet. Derive expected parent from cwd.
                let parent = c.as_deref().and_then(|cwd_str| {
                    let projects = crate::tokens::claude_projects_dir()?;
                    let encoded = crate::tokens::encode_cwd_as_project_dir(
                        std::path::Path::new(cwd_str),
                    );
                    Some(projects.join(encoded))
                });
                (parent, None)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let watch_dir = watch_dir.ok_or_else(|| {
        format!("transcript not found for session {session_id} and no cwd to derive watch dir")
    })?;

    // Ensure the directory exists (Claude creates it on first write; creating
    // it early lets the FS watcher attach before any events fire).
    let _ = std::fs::create_dir_all(&watch_dir);

    let initial_offset = found_path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(16);

    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // Fire on any write/create in the watched directory.
                // Filtering by exact path is skipped to avoid case-sensitivity
                // mismatches on Windows where notify may return different
                // path casing than locate_transcript.
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    let _ = tx.blocking_send(());
                }
            }
        })
        .map_err(|e| format!("notify watcher: {e}"))?;

    watcher
        .watch(&watch_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch: {e}"))?;

    let sid = session_id.clone();
    let expected_file = watch_dir.join(format!("{session_id}.jsonl"));
    let task = tokio::spawn(async move {
        let mut resolved_path = found_path;
        let mut offset = initial_offset;

        while rx.recv().await.is_some() {
            // Drain burst: multiple FS events may fire for one logical write.
            while rx.try_recv().is_ok() {}

            // If we haven't located the file yet, check whether it appeared.
            if resolved_path.is_none() {
                if expected_file.exists() {
                    resolved_path = Some(expected_file.clone());
                    offset = 0; // read from beginning of newly-created file
                } else {
                    continue;
                }
            }

            let path = resolved_path.as_ref().unwrap().clone();
            let (new_events, new_offset) = tauri::async_runtime::spawn_blocking({
                let p = path.clone();
                let cur = offset;
                move || -> (Vec<crate::types::chat::ChatEvent>, u64) {
                    let mut f = match File::open(&p) {
                        Ok(f) => f,
                        Err(_) => return (vec![], cur),
                    };
                    if f.seek(SeekFrom::Start(cur)).is_err() {
                        return (vec![], cur);
                    }
                    let mut reader = BufReader::new(f);
                    let mut evs = Vec::new();
                    let mut new_off = cur;
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(n) => {
                                if line.ends_with('\n') {
                                    new_off += n as u64;
                                    let trimmed =
                                        line.trim_end_matches(|c| c == '\r' || c == '\n');
                                    if !trimmed.trim().is_empty() {
                                        evs.extend(crate::chat::parser::parse_line(trimmed));
                                    }
                                } else {
                                    // Partial line — wait for the next notification.
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    (evs, new_off)
                }
            })
            .await
            .unwrap_or((vec![], offset));

            offset = new_offset;
            for ev in new_events {
                let _ = app.emit(&format!("chat-watch:{sid}"), ev);
            }
        }
    });

    // A rapid switch-away (unwatch, or a fresh watch call for the same id) may
    // have superseded this call while the setup above was in flight. Only
    // register if we're still the latest request for this session; otherwise
    // tear down what we just built instead of leaking it.
    if current_generation(&session_id) != my_gen {
        task.abort();
        return Ok(());
    }

    watchers()
        .lock()
        .unwrap()
        .insert(session_id, WatchHandle { _watcher: watcher, task });

    Ok(())
}

/// Stop the file watcher for `session_id`. No-op if not currently watching.
#[tauri::command]
pub fn unwatch_session_transcript(session_id: String) {
    bump_generation(&session_id);
    stop_watcher(&session_id);
}

fn stop_watcher(session_id: &str) {
    if let Some(handle) = watchers().lock().unwrap().remove(session_id) {
        handle.task.abort();
        // _watcher is dropped here, stopping the FS subscription.
    }
}
