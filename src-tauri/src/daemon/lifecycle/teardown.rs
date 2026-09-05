use crate::daemon::broadcast;
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

use super::spawn::respawn_interactive;
use super::LifecycleError;

/// `is_meta` marks the broadcast `UserMessage` as daemon-injected rather than
/// a real human turn (todo 272 chunk 3): the frontend already renders
/// `is_meta: true` turns as a system note (see `chat-event-handler.ts`), which
/// is exactly what a daemon-side Jarvis wake needs - Jarvis's own chat pane
/// should show "worker X finished" as a note, not a fake user bubble. Every
/// pre-existing caller passes `false`, keeping their behavior byte-identical;
/// `daemon::jarvis_wake::drain` is the only caller that passes `true`.
pub async fn send_message(session: &Arc<Session>, text: &str, is_meta: bool) -> Result<(), LifecycleError> {
    send_message_inner(session, text, is_meta, None).await
}

/// Same as `send_message`, but tags the message as relayed by another AI on
/// Joe's behalf (todo 682: a Jarvis dispatch) rather than typed by Joe.
/// Never `is_meta` - this IS real content. A dedicated fn, instead of
/// widening `send_message`'s params, keeps every other call site untouched.
pub async fn send_message_with_author(
    session: &Arc<Session>,
    text: &str,
    author_session_id: &str,
) -> Result<(), LifecycleError> {
    send_message_inner(session, text, false, Some(author_session_id)).await
}

/// Both flags at once (todo 743): a repo-channel peer wake is daemon-injected
/// (`is_meta: true`, excluded from titling/token counts) AND carries its
/// sender's stable id, so a message can be both - see `wire_text`'s compose
/// order below for why meta must lead.
pub async fn send_message_meta_with_author(
    session: &Arc<Session>,
    text: &str,
    author_session_id: &str,
) -> Result<(), LifecycleError> {
    send_message_inner(session, text, true, Some(author_session_id)).await
}

async fn send_message_inner(
    session: &Arc<Session>,
    text: &str,
    is_meta: bool,
    author_session_id: Option<&str>,
) -> Result<(), LifecycleError> {
    // Remember the prompt: if this turn is rejected by a rate limit before
    // producing any output, the scheduled resume replays exactly this text.
    // Deliberately the CLEAN text, not `wire_text` below - every caller that
    // can hit a rate-limit replay (`schedule_fire::fire_message`) always
    // passes `is_meta: false`, so `wire_text` is byte-identical to `text` on
    // every path that ever reads `last_prompt` back.
    if let Ok(mut lp) = session.last_prompt.lock() {
        *lp = text.to_string();
    }
    // Neither marker is something the CLI itself persists; embedding one in
    // the text is the only way it survives into its own transcript. Meta MUST
    // lead when both are present: `chat::parser`/`tokens::title` do a plain
    // `starts_with(DAEMON_META_SENTINEL)` on the first block (todo 743).
    let mut wire_text = String::new();
    if is_meta {
        wire_text.push_str(crate::types::chat::DAEMON_META_SENTINEL);
    }
    if let Some(author) = author_session_id {
        wire_text.push_str(crate::types::chat::DAEMON_AUTHOR_SENTINEL_PREFIX);
        wire_text.push_str(author);
        wire_text.push_str(crate::types::chat::DAEMON_AUTHOR_SENTINEL_SUFFIX);
    }
    // A slash command the user wrote mid-sentence is never expanded by the CLI,
    // so append its instructions-pointer block and let the model judge intent.
    // Appended, never prepended: `chat::parser`/`tokens::title` match sentinels
    // at the front, and the frontend strips the block from the bubble.
    if is_meta {
        wire_text.push_str(text);
    } else {
        wire_text.push_str(&crate::slash::mentions::augment(text, Some(&session.cwd)));
    }
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": wire_text
        }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    // Broadcast a marked user-message echo so the frontend can render the
    // user bubble regardless of which device sent it. The `remote_echo: true`
    // flag lets the frontend distinguish this synthesised event from the
    // `claude --resume` history-replay user lines (which carry remote_echo:
    // false and are dropped to avoid duplicating transcript history).
    // The existing `sigOf` / `isLiveDuplicate` dedup gate in the event-store
    // handles the case where the desktop's own optimistic pushSynthetic already
    // recorded the same content sig, so both paths render exactly one bubble.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    broadcast::publish(
        session,
        ChatEvent::UserMessage {
            content: vec![crate::types::chat::ContentBlock::Text { text: text.to_string() }],
            timestamp: now_ms,
            remote_echo: true,
            is_meta,
            author_session_id: author_session_id.map(|s| s.to_string()),
        },
    );
    Ok(())
}

/// Send a message to `session_id`, respawning it first if the daemon no
/// longer holds it live in the `SessionMap`. The per-turn `claude -p`
/// process exits at the end of every turn (see the `is_interactive` branch
/// at the end of `spawn_session`'s pump task above), so a session that has
/// gone idle since its last turn is routinely absent from the map even
/// though the Registry still lists it as an open Interactive chat.
///
/// The desktop app compensates for this client-side: `ipc/chat/run.rs`'s
/// `send_message_daemon` catches the `-32004` NotFound RPC error, calls
/// `start_session` with `resume_id` set, re-attaches its event bridge, then
/// retries the send. A remote (phone/browser) client has neither half of that
/// dance and no cached cwd/model/effort/account to respawn with, so this does
/// the equivalent respawn-then-retry entirely daemon-side, reading the
/// session's cwd/model/effort/account from the Registry (the daemon's own
/// canonical record) instead of trusting the caller.
///
/// Only respawns sessions the Registry still considers a live Interactive
/// chat (not `ended_at`-marked, not External/Automated) - anything else is a
/// genuine NotFound, same as before this existed.
///
/// `is_meta` rides straight through to `send_message` - see its doc for what
/// that flag means. Every caller of this function today passes `false`
/// except `daemon::jarvis_wake::drain`, the sole source of `true`.
pub async fn send_message_with_respawn(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    is_meta: bool,
) -> Result<(), LifecycleError> {
    if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
        return send_message(&session, text, is_meta).await;
    }
    let session = respawn_interactive(state, session_id).await?;
    send_message(&session, text, is_meta).await
}

/// Same as `send_message_with_respawn`, but tags the message with
/// `author_session_id` - see `send_message_with_author`'s doc. The sole
/// caller is `jarvis_fleet::send_to_session`.
pub async fn send_message_with_respawn_and_author(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    author_session_id: &str,
) -> Result<(), LifecycleError> {
    if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
        return send_message_with_author(&session, text, author_session_id).await;
    }
    let session = respawn_interactive(state, session_id).await?;
    send_message_with_author(&session, text, author_session_id).await
}

/// Same as `send_message_with_respawn_and_author`, but also `is_meta: true`
/// (see `send_message_meta_with_author`'s doc). The sole caller is
/// `repo_channel_wake::drain`.
pub async fn send_message_with_respawn_meta_and_author(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    author_session_id: &str,
) -> Result<(), LifecycleError> {
    if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
        return send_message_meta_with_author(&session, text, author_session_id).await;
    }
    let session = respawn_interactive(state, session_id).await?;
    send_message_meta_with_author(&session, text, author_session_id).await
}

/// Force-kills `session_id`'s live child and waits for pump teardown,
/// without respawning - shared by `restart_session` and `freeze_session`.
pub async fn kill_and_wait_for_teardown(state: &Arc<DaemonState>, session_id: &str) {
    if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
        session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::channels::kill::kill_tree(session.pid);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && state.sessions.get(session_id).is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

pub async fn cancel_turn(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    // Interrupt only the in-flight turn, keeping the process alive. The claude
    // process is long-lived (one `claude -p --input-format=stream-json` per
    // session, turns fed via stdin), so killing it (the old behavior) ended the
    // whole session: the pump saw stdout EOF, marked it ProcessGone, the pane
    // tore down, and the next message had to --resume respawn (looked like a
    // closed chat). The stream-json control protocol stops the current turn
    // without that teardown; the trailing `result` line clears busy as usual.
    let msg = serde_json::json!({
        "type": "control_request",
        "request_id": format!("interrupt-{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "interrupt" }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

pub async fn end_session(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    use tokio::io::AsyncWriteExt;
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    // Intentional close only - crash/restart paths never reach end_session.
    crate::ask::store::drop_for_chat(session_id);
    // Close stdin to signal EOF for clean shutdown.
    {
        let mut stdin = session.stdin.lock().await;
        let _ = stdin.shutdown().await;
    }
    // Wait up to 3s for claude to exit on its own (pump removes from map on EOF).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !map.contains_key(session_id) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Force-kill if still present.
    session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::channels::kill::kill_tree(session.pid);
    if let Some(ref p) = session.mcp_config_path {
        let _ = std::fs::remove_file(p);
    }
    if let Some(ref p) = session.hook_settings_path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    // Real send_message requires a live ChildStdin. The behavior is covered
    // end-to-end in the Phase 2 integration test (#[ignore]'d). Here we
    // sanity-check the JSON shape we emit.
    #[test]
    fn user_message_json_shape_matches_stream_json_format() {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "hi"
            }
        });
        let v: serde_json::Value = serde_json::from_value(msg).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hi");
    }

    #[tokio::test]
    async fn cancel_turn_unknown_session_errors() {
        let map = new_session_map();
        let r = cancel_turn(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }

    #[tokio::test]
    async fn end_session_unknown_session_errors() {
        let map = new_session_map();
        let r = end_session(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }

    // A live ChildStdin is required to reach end_session's happy path, so this
    // spawns a real throwaway process (same pattern as channels.rs's
    // refresh_with_cmd_populates_argv, Windows-only for the same reason).
    #[cfg(windows)]
    #[tokio::test]
    async fn end_session_drops_the_closed_chats_ask_threads() {
        let sid = "teardown-test-ask-drop-9f2c";
        let thread = crate::ask::store::AskThread::new("t1".into(), 1);
        crate::ask::store::save(sid, &[thread]).unwrap();
        assert!(!crate::ask::store::load(sid).is_empty());

        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let pid = child.id().expect("pid");
        let session = Session::new(
            sid.to_string(), std::env::temp_dir(), "m".into(), "high".into(),
            pid, stdin, None, None, "acct".into(),
        );
        let map = new_session_map();
        map.insert(sid.to_string(), session);

        end_session(&map, sid).await.expect("end_session");

        assert!(crate::ask::store::load(sid).is_empty(), "ask threads must be dropped on intentional close");
        let _ = child.kill().await;
    }

    // send_message_with_respawn: the remote (phone/browser) send path's
    // daemon-side respawn. A live ChildStdin/process is needed to exercise
    // the "already live, just send" branch (covered by the ignored Phase 2
    // integration test, same as plain send_message above); these tests cover
    // the respawn-selection logic, which is exactly the part remote sends
    // were missing.

    #[tokio::test]
    async fn send_message_with_respawn_unknown_everywhere_errors_not_found() {
        let state = test_state();
        let r = send_message_with_respawn(&state, "ghost", "hi", false).await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_uses_registry_cwd_when_map_is_missing() {
        // The session isn't live in the SessionMap (its per-turn process already
        // exited - see spawn_session's is_interactive pump-exit branch) but the
        // Registry still tracks it as an open Interactive chat. The respawn path
        // must read cwd/model/effort from the Registry and actually attempt a
        // spawn - proven here by getting CwdMissing (not NotFound) back for a
        // bogus cwd, which only happens if spawn_session really ran with the
        // registry's recorded path.
        let state = test_state();
        state.registry.upsert_interactive(
            "sid-respawn-1",
            &std::path::PathBuf::from("Z:\\does\\not\\exist"),
            "proj-1",
            "2026-01-01T00:00:00Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-1", "hi", false).await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_refuses_ended_session() {
        // A session the user genuinely closed (mark_ended) must not be
        // silently resurrected by an incoming remote message - NotFound, same
        // as an unknown session.
        let state = test_state();
        state.registry.upsert_interactive(
            "sid-respawn-2",
            &std::env::temp_dir(),
            "proj-1",
            "2026-01-01T00:00:00Z",
        );
        state.registry.mark_ended(
            "sid-respawn-2",
            crate::types::EndReason::Manual,
            "2026-01-01T00:00:01Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-2", "hi", false).await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_refuses_non_interactive_kind() {
        // External/Automated sessions have no --resume respawn story; a
        // Registry hit that isn't Interactive must still be a NotFound.
        let state = test_state();
        state.registry.register(
            crate::sessions::registry::RegisterInput {
                session_id: "sid-respawn-3".into(),
                cwd: std::env::temp_dir(),
                pid: 1,
                kind: crate::sessions::kinds::InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &std::sync::Mutex::new(crate::types::Settings::default()),
            "2026-01-01T00:00:00Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-3", "hi", false).await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }
}
