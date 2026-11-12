//! Pump-exit cleanup: everything `run_stdout_pump` does once stdout hits EOF
//! or a read error. Split out of `pump.rs` (todo 685); shares no state with
//! the read loop beyond the two values the loop latched (`pump_turn_gen`,
//! `closing_flagged`).

use super::close::{close_in_flight, close_stand_down_is_failure_at_eof, ended_already, finalize_close, CLOSE_FAILED_AWAITING};
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Mark the session ended or leave it Interactive-and-idle, expire orphaned
/// prompts, honor a close the process death raced past, remove the
/// per-session mcp/hook temp files, and reap the child.
pub(crate) async fn run_pump_exit(
    mut child: tokio::process::Child,
    pump_session: Arc<Session>,
    map_for_pump: SessionMap,
    state_for_pump: Arc<DaemonState>,
    pump_turn_gen: u64,
    closing_flagged: bool,
) {
    map_for_pump.remove(&pump_session.session_id);
    // A compaction this child was running is over, and messages Joe typed
    // meanwhile move to the held queue instead of dying with it.
    crate::daemon::subchats::compaction::on_child_exit(&state_for_pump, &pump_session.session_id, pump_session.pid);
    // Interactive sessions: the child lives across turns, so reaching here
    // means it died (crash, kill, freeze, daemon shutdown). Keep the registry
    // entry live so the sidebar keeps showing the session. The next
    // send_message will find the session missing from the SessionMap, get
    // -32004 NotFound, and auto-respawn with --resume.
    // For non-Interactive kinds (External / Automated) a process exit really
    // does mean the session is gone, so mark it ended as before.
    let is_interactive = state_for_pump.registry
        .get(&pump_session.session_id)
        .map(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
        .unwrap_or(false);
    // Read before the clear below: a sub that died mid-turn is told apart from one
    // that died idle by this.
    let was_busy = state_for_pump.registry.get(&pump_session.session_id).is_some_and(|i| i.busy);
    if is_interactive {
        // Clear busy in case the process exited mid-turn without a result line.
        // The registry flag always clears, since this run has no child for it.
        // The persisted one stays when the machine or the daemon is going down:
        // that turn was cut off, and the next boot's `resume_interrupted` reads
        // it to continue the turn. An idle child was not busy, so it is never
        // resumed either way.
        let shutdown = crate::daemon::subchats::turn_end::is_shutdown_exit(peek_exit_code(&mut child).await);
        if state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen) && !shutdown {
            crate::sessions::chat_state::set_busy(&pump_session.session_id, false);
        }
        // Ghost prompts: an open AskUserQuestion/permission prompt can only
        // exist mid-turn, so any prompt still recorded when the process
        // exits is orphaned - its hook curl died with the process, axum
        // dropped the blocked handler, and the post-await cleanup never
        // ran. Left alone, the record keeps resurrecting the card via the
        // list_pending_prompts poll and pins awaiting=="question" forever.
        let expired = state_for_pump
            .expire_prompts_for_session(&pump_session.session_id)
            .await;
        if expired > 0 {
            // Gated on no OTHER open question for this session (todo 897):
            // `expire_prompts_for_session` only ever expires non-durable
            // (permission) prompts - a durable AskUserQuestion card for this
            // same session survives on purpose - so a blind clear here used
            // to hide that still-open card behind a falsely-settled row.
            let _ = state_for_pump
                .clear_question_awaiting_if_no_others_pending(&pump_session.session_id)
                .await;
            log::info!(
                "daemon: session {} expired {} orphaned prompt(s) on EOF",
                pump_session.session_id, expired
            );
        }
        // A `write_plan` step comment (todo 898) still unclaimed when the
        // turn's process exits belongs to a plan that is over - its step-text
        // key is only meaningful within the turn that declared it, so leaving
        // it would risk a stale cross-turn delivery if a FUTURE turn happens
        // to reuse the same step text. The checklist row is where an
        // undelivered comment stays visibly parked; this just stops the
        // backend store from leaking it into an unrelated later turn.
        state_for_pump.clear_step_comments(&pump_session.session_id).await;
        // A process that died mid-commit never reaches its PostToolUse release.
        state_for_pump.release_commit_locks_held_by(&pump_session.session_id);
        // /close's Phase 6 script also kills the `claude -p` child, which can
        // take the process down BEFORE its result line flushes - so a close the
        // `close_session` MCP tool confirmed must also be honored on EOF, not
        // just at TurnUsage. Idempotent with the result-line path: whichever
        // consumes `close_requested` first tears down; the other is a no-op.
        let close_confirmed_at_eof =
            state_for_pump.registry.take_close_requested(&pump_session.session_id);
        // The turn is over either way - drop the broadcast closing flag
        // before any snapshot below can persist `closing: true`. (No
        // reassignment: the pump loop is done, the flag is never read again.)
        if close_in_flight(&state_for_pump.registry, &pump_session.session_id, closing_flagged) {
            if close_stand_down_is_failure_at_eof(close_confirmed_at_eof || ended_already(&state_for_pump.registry, &pump_session.session_id)) {
                log::warn!(
                    "daemon: session {} process exited mid-/close without close_session confirmation; chat still open",
                    pump_session.session_id
                );
                state_for_pump.registry.set_awaiting(
                    &pump_session.session_id,
                    Some(CLOSE_FAILED_AWAITING.to_string()),
                );
                // So a daemon restart doesn't wipe the failure back to
                // whatever awaiting was before this turn.
                crate::sessions::persistence::save_snapshot_default(&state_for_pump.registry);
            }
            state_for_pump.registry.set_closing(&pump_session.session_id, false);
        }
        if close_confirmed_at_eof {
            finalize_close(&state_for_pump, &pump_session);
            crate::sessions::persistence::save_snapshot_default(&state_for_pump.registry);
        }
        // Same race for a sub's `finish_subchat`: the process died before its
        // result line flushed, and the finish it accepted still stands.
        crate::daemon::subchats::turn_end::on_process_exit(&state_for_pump, &pump_session);
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        state_for_pump.registry.mark_ended(&pump_session.session_id, crate::types::EndReason::ProcessGone, &now);
    }
    crate::daemon::machines::publish_instances_changed(&state_for_pump);
    log::info!(
        "daemon: session {} pump task exited",
        pump_session.session_id
    );
    if let Some(ref p) = pump_session.mcp_config_path {
        let _ = std::fs::remove_file(p);
    }
    if let Some(ref p) = pump_session.hook_settings_path {
        let _ = std::fs::remove_file(p);
    }
    let exit = report_nonzero_exit(&pump_session, child.wait().await.ok()).await;
    // A hidden sub has no row and no reader, so a death that nothing else
    // surfaces gets a card. After the wait so the card can quote the last error.
    if is_interactive {
        crate::daemon::subchats::turn_end::on_process_died(&state_for_pump, &pump_session, was_busy, exit);
    }
}

/// The child's exit code if it has exited by now. Stdout's EOF is normally the
/// process ending, so this returns at once; bounded so a child that closed
/// stdout and lingers does not hold the cleanup. The status is cached, so the
/// later `wait` returns the same one.
async fn peek_exit_code(child: &mut tokio::process::Child) -> Option<i32> {
    match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => None,
    }
}

/// A `claude -p` turn exits 0. Anything else means the CLI died on us, and its
/// stdout carried no result line, so without this the chat shows nothing at all.
/// Replay the stderr tail as a notification so the failure names itself (expired
/// login, MCP init failure, a panic) instead of reading as a frozen chat.
/// Returns what it learned, for a hidden sub's card.
async fn report_nonzero_exit(
    session: &Arc<Session>,
    status: Option<std::process::ExitStatus>,
) -> Option<crate::daemon::subchats::turn_end::ExitInfo> {
    let code = match status {
        Some(s) if s.success() => return None,
        Some(s) => s.code(),
        None => return None,
    };
    // A kill we asked for is not a crash worth reporting.
    if session.expected_exit.load(std::sync::atomic::Ordering::SeqCst) {
        return None;
    }
    // The fatal line is the LAST thing the child writes, so the tail is only
    // trustworthy once the drain task has seen EOF. Bounded: a child that never
    // closes stderr must not hold teardown open.
    if let Some(handle) = session.stderr_drain.lock().await.take() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), handle).await;
    }
    let tail = session
        .stderr_tail
        .lock()
        .ok()
        .map(|t| t.join("
"))
        .unwrap_or_default();
    let code_label = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
    log::error!(
        "daemon: session {} claude exited {code_label}; stderr tail:
{tail}",
        session.session_id
    );
    let body = if tail.trim().is_empty() {
        format!("The `claude` process exited with code {code_label} and wrote nothing to stderr.")
    } else {
        format!("The `claude` process exited with code {code_label}:

{tail}")
    };
    crate::daemon::broadcast::publish(
        session,
        crate::types::chat::ChatEvent::Notification { kind: "process_error".into(), body },
    );
    Some(crate::daemon::subchats::turn_end::ExitInfo { code, stderr_tail: tail })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::parser::ParserContext;
    use crate::daemon::pump::close::prompt_is_close_now;

    /// A `/close` turn whose first content is tool_use (no preceding text) must
    /// still be flagged on death, since closing_flagged arms on stream_event, not AssistantDelta.
    #[test]
    fn text_free_tool_call_first_close_still_flagged_on_eof() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");

        // Mirrors turn_is_close's check without needing a live Session/ChildStdin.
        let last_prompt = "/close --now";
        let mut ctx = ParserContext::new_live();
        let mut saw_stream_turn = false;
        let mut closing_flagged = false;
        for line in [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}}"#,
        ] {
            ctx.feed(format!("{line}\n").as_bytes());
            if !saw_stream_turn && ctx.take_stream_event_seen() {
                saw_stream_turn = true;
                if prompt_is_close_now(last_prompt) {
                    closing_flagged = true;
                }
            }
        }
        assert!(closing_flagged, "text-free tool-call-first /close must still arm closing_flagged");

        // The process now dies mid-turn (EOF) before any close_session confirmation.
        let close_confirmed_at_eof = false;
        if closing_flagged && close_stand_down_is_failure_at_eof(close_confirmed_at_eof) {
            registry.set_awaiting("s", Some(CLOSE_FAILED_AWAITING.to_string()));
        }
        assert_eq!(registry.get("s").unwrap().awaiting.as_deref(), Some(CLOSE_FAILED_AWAITING));
    }

    /// Runs the real exit handler on a child that exits with `code`, for a sub
    /// whose turn was open. Returns the persisted busy flag the next boot reads
    /// and the cards raised.
    #[cfg(windows)]
    async fn exit_mid_turn(tag: &str, code: i64) -> (bool, Vec<serde_json::Value>) {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        st.registry.set_busy(&sub, true);
        crate::sessions::chat_state::set_busy(&sub, true);
        let gen = st.registry.current_turn_gen(&sub);
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "exit", &code.to_string()])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let pid = child.id().unwrap_or(0);
        let session = Session::new(sub.clone(), std::env::temp_dir(), "m".into(), "high".into(), pid, stdin, None, None, "acct".into());
        run_pump_exit(child, session, st.sessions.clone(), st.clone(), gen, false).await;
        // The death card is raised on a detached task.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let busy = crate::sessions::chat_state::get(&sub).is_some_and(|c| c.busy);
        (busy, st.list_prompts().await)
    }

    /// An OS shutdown closes the child's console first (exit 0xC000013A). The
    /// turn was cut off, not lost: the persisted busy flag must survive so the
    /// next boot's `resume_interrupted` continues it, and no death card is raised.
    #[cfg(windows)]
    #[tokio::test]
    async fn an_os_shutdown_exit_keeps_the_turn_for_the_next_boot_and_raises_no_card() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (busy, cards) = exit_mid_turn("exit-shutdown", -1073741510).await;
        assert!(busy, "the next boot must see the turn as cut off");
        assert!(cards.is_empty(), "no death card for a shutdown: {cards:?}");
        // Any other mid-turn exit is a death, as before.
        let (busy, cards) = exit_mid_turn("exit-crash", 1).await;
        assert!(!busy);
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0]["payload"]["card_kind"], "subchat_unfinished");
    }
}
