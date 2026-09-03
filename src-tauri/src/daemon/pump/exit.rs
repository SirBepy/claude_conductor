//! Pump-exit cleanup: everything `run_stdout_pump` does once stdout hits EOF
//! or a read error. Split out of `pump.rs` (todo 685); shares no state with
//! the read loop beyond the two values the loop latched (`pump_turn_gen`,
//! `closing_flagged`).

use super::close::{close_stand_down_is_failure_at_eof, finalize_close, CLOSE_FAILED_AWAITING};
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
    // Interactive sessions: `claude -p --input-format=stream-json` exits after
    // completing each turn. Keep the registry entry live so the sidebar keeps
    // showing the session. The next send_message will find the session missing
    // from the SessionMap, get -32004 NotFound, and auto-respawn with --resume.
    // For non-Interactive kinds (External / Automated) a process exit really
    // does mean the session is gone, so mark it ended as before.
    let is_interactive = state_for_pump.registry
        .get(&pump_session.session_id)
        .map(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
        .unwrap_or(false);
    if is_interactive {
        // Clear busy in case the process exited mid-turn without a result line.
        if state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen) {
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
            let _ = state_for_pump
                .registry
                .clear_awaiting_if_question(&pump_session.session_id);
            log::info!(
                "daemon: session {} expired {} orphaned prompt(s) on EOF",
                pump_session.session_id, expired
            );
        }
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
        if closing_flagged {
            if close_stand_down_is_failure_at_eof(close_confirmed_at_eof) {
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
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        state_for_pump.registry.mark_ended(&pump_session.session_id, crate::types::EndReason::ProcessGone, &now);
    }
    state_for_pump.notifier.publish(
        "instances_changed",
        serde_json::json!({"instances": state_for_pump.registry.list()}),
    );
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
    report_nonzero_exit(&pump_session, child.wait().await.ok()).await;
}

/// A `claude -p` turn exits 0. Anything else means the CLI died on us, and its
/// stdout carried no result line, so without this the chat shows nothing at all.
/// Replay the stderr tail as a notification so the failure names itself (expired
/// login, MCP init failure, a panic) instead of reading as a frozen chat.
async fn report_nonzero_exit(session: &Arc<Session>, status: Option<std::process::ExitStatus>) {
    let code = match status {
        Some(s) if s.success() => return,
        Some(s) => s.code(),
        None => return,
    };
    // A kill we asked for is not a crash worth reporting.
    if session.expected_exit.load(std::sync::atomic::Ordering::SeqCst) {
        return;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::parser::ParserContext;

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
        let last_prompt = "/close";
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
                if last_prompt.trim_start().starts_with("/close") {
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
}
