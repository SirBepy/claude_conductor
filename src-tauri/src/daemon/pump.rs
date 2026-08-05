//! The stdout-pump task for a session's long-lived `claude` subprocess:
//! parses stdout, coalesces streamed text deltas, updates registry/notifier
//! state as turns complete, and runs pump-exit cleanup once stdout hits EOF.
//! Split out of `daemon/lifecycle.rs` (ai_todo 294) - `spawn_session` still
//! owns spawning the child and handing this task the stdout/child handles
//! for the rest of the session's natural lifetime.

use crate::chat::parser::ParserContext;
use crate::daemon::broadcast;
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Flush the pump's held delta buffer (ai_todo 186): fold it into the
/// session's shared `StreamingText` accumulator (which assigns the emit
/// `seq` and lets attach paths resync a mid-turn client), and broadcast the
/// O(delta) wire event carrying only the new characters. No-op when
/// nothing is pending.
fn flush_pending_delta(
    session: &Session,
    pending: &mut Option<(u64, String, i64)>,
) {
    let Some((block, chunk, ts)) = pending.take() else { return };
    let seq = {
        let mut s = session.streaming.lock().unwrap();
        s.apply_chunk(block, &chunk)
    };
    broadcast::publish(session, ChatEvent::AssistantDelta {
        text: chunk,
        block,
        seq,
        snapshot: false,
        timestamp: ts,
    });
}

/// True when the turn currently running was opened by the user typing `/close`.
/// Drives the daemon-authoritative `closing` row state (no text marker). The
/// actual teardown still waits for the explicit `close_session` MCP tool, so a
/// `/close --dont-close` shows "Closing" mid-run then stands back down.
fn turn_is_close(session: &Session) -> bool {
    session
        .last_prompt
        .lock()
        .ok()
        .map(|p| p.trim_start().starts_with("/close"))
        .unwrap_or(false)
}

/// Registry `awaiting` value for a `/close` turn that ended without ever
/// confirming via the `close_session` tool (todo 436): the model deviated
/// mid-chain (e.g. ran a terminal-kill script instead) rather than the tool
/// call erroring. Reuses `awaiting` (the single status source) instead of a
/// second flag.
const CLOSE_FAILED_AWAITING: &str = "close_failed";

/// True when a `/close` turn's stand-down (closing flagged, tool never
/// confirmed) is a genuine failure rather than an intentional `--dont-close`
/// dry run. Pure so it's unit-testable without a live `Session`/`ChildStdin`
/// (mirrors `hook_session_end_should_close` in `hooks_server::lifecycle`).
fn close_stand_down_is_failure(last_prompt: &str, close_confirmed: bool) -> bool {
    !close_confirmed && !last_prompt.contains("--dont-close")
}

/// EOF counterpart of `close_stand_down_is_failure`: skips the `--dont-close`
/// exemption, since a process dying mid-turn is always a failure regardless of prompt.
fn close_stand_down_is_failure_at_eof(close_confirmed_at_eof: bool) -> bool {
    !close_confirmed_at_eof
}

/// Daemon-authoritative `/close` teardown: mark the session ended and force the
/// `claude` process tree down. Fired when the `close_session` MCP tool's
/// `close_requested` flag is observed at turn end. Idempotent - `mark_ended`
/// no-ops after the first call and `kill_tree` on an already-dead pid is
/// harmless - so the result-line and EOF handlers can both call it safely.
fn finalize_close(state: &Arc<DaemonState>, session: &Session) {
    let now = chrono::Utc::now().to_rfc3339();
    if state.registry.mark_ended(&session.session_id, crate::types::EndReason::Manual, &now) {
        log::info!(
            "daemon: session {} /close confirmed via close_session tool; marked ended, killing process tree",
            session.session_id
        );
    }
    crate::channels::kill::kill_tree(session.pid);
}

/// The stdout-pump task for one session's `claude` subprocess: reads and
/// parses stdout line by line, coalesces streamed text deltas (see the
/// `pending_delta`/`flush_deadline` comment below) into the broadcast
/// channel, updates registry/notifier state as turns complete, and - once
/// stdout hits EOF or a read error - runs pump-exit cleanup (mark the
/// session ended or leave it Interactive-and-idle, expire orphaned prompts,
/// remove the per-session mcp/hook temp files, and reap the child).
/// Extracted out of `spawn_session` (ai_todo 197): `child` and `stdout` are
/// the two handles `spawn_session` pulled off the spawned process before
/// handing this task ownership of the rest of the session's natural
/// lifetime.
pub(crate) async fn run_stdout_pump(
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    pump_session: Arc<Session>,
    map_for_pump: SessionMap,
    state_for_pump: Arc<DaemonState>,
) {
    let mut ctx = ParserContext::new_live();
    let mut buf_reader = BufReader::new(stdout);
    let mut line_buf = Vec::new();
    // True once the current turn has emitted at least one `stream_event` line,
    // meaning it is a live turn (not a replayed history result line from
    // `--resume`, which never carries that envelope). Reset to false after
    // each TurnUsage so each turn is evaluated independently. Without this
    // guard, resumed sessions fire one sound per prior completed turn.
    let mut saw_stream_turn = false;
    // Generation counter captured at the start of each live turn (todo 475:
    // on the turn's first `stream_event` line, not the first text delta, so a
    // tool-only/textless turn still captures it). At turn-end we only call
    // set_busy(false) if the registry's turn_gen still matches, preventing
    // a stale result line from an interrupted turn from clearing the
    // busy=true that a new send_message set in the meantime.
    let mut pump_turn_gen: u64 = 0;
    // True while the daemon-authoritative `closing` registry flag is set for
    // the current turn: armed at the turn's first live output when the user
    // opened it with `/close` (no text marker involved), cleared at turn end
    // unless the close actually confirmed (then the row is `ended`, not just
    // `closing`). Teardown itself is driven by the `close_requested` flag the
    // `close_session` MCP tool sets - see the result-line/EOF handlers below.
    let mut closing_flagged = false;
    // Delta coalescing (ai_todo 186, evolving the earlier O(n^2) frequency
    // fix): the parser now emits O(delta) `AssistantDelta` chunks instead of
    // full-text snapshots, so per-chunk cost is flat end-to-end (the old
    // shape re-cloned and re-serialized the WHOLE accumulated text across
    // daemon->app IPC, app->webview emit, AND the remote websocket per emit).
    // At most one chunk buffer is held here; newer chunks for the same block
    // are CONCATENATED into it (deltas compose, unlike the old idempotent
    // snapshots which replaced each other). It flushes on whichever comes
    // first: the ~100ms timer below, the next non-delta event (flushed
    // BEFORE that event so relative order is exact), or the stream ending.
    // (block ordinal, buffered chunk text, timestamp)
    let mut pending_delta: Option<(u64, String, i64)> = None;
    let mut flush_deadline: Option<tokio::time::Instant> = None;
    const SNAPSHOT_FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_millis(100);
    loop {
        tokio::select! {
            result = buf_reader.read_until(b'\n', &mut line_buf) => {
                match result {
                    Ok(0) => {
                        flush_pending_delta(&pump_session, &mut pending_delta);
                        break;
                    }
                    Ok(_) => {
                        // claude -p shows an interactive workspace-trust prompt when
                        // the cwd hasn't been trusted before. With stdin piped the
                        // process blocks indefinitely waiting for keyboard input.
                        // Detect the prompt and auto-accept by selecting option 1.
                        if !line_buf.starts_with(b"{") {
                            if let Ok(s) = std::str::from_utf8(&line_buf) {
                                if s.contains("Enter to confirm") {
                                    let mut stdin_guard = pump_session.stdin.lock().await;
                                    let _ = stdin_guard.write_all(b"1\n").await;
                                    let _ = stdin_guard.flush().await;
                                }
                            }
                        }
                        let feed_events = ctx.feed(&line_buf);
                        // `--resume` history replay never emits `stream_event` lines, so this
                        // is the earliest live-exclusive signal, firing even for tool-only turns.
                        if !saw_stream_turn && ctx.take_stream_event_seen() {
                            saw_stream_turn = true;
                            pump_turn_gen = state_for_pump
                                .registry
                                .current_turn_gen(&pump_session.session_id);
                            // Mark the row "Closing" now (daemon-authoritative, no text marker)
                            // so every window's sidebar shows it; close_requested drives teardown.
                            if turn_is_close(&pump_session) {
                                closing_flagged = true;
                                if state_for_pump.registry.set_closing(&pump_session.session_id, true) {
                                    state_for_pump.notifier.publish(
                                        "instances_changed",
                                        serde_json::json!({"instances": state_for_pump.registry.list()}),
                                    );
                                }
                            }
                        }
                        for ev in feed_events {
                            // Suppress SessionStarted: claude re-emits a system/init
                            // line at the start of EVERY turn. The app shows the
                            // session via its own synthetic SessionStarted handoff,
                            // so forwarding these spams "Session started" each turn.
                            if matches!(ev, ChatEvent::SessionStarted { .. }) {
                                continue;
                            }
                            let ev = match ev {
                                ChatEvent::AssistantDelta { text, block, timestamp, .. } => {
                                    match pending_delta {
                                        Some((pb, ref mut buf, _)) if pb == block => buf.push_str(&text),
                                        _ => {
                                            // A different block is still buffered:
                                            // flush it first so order stays exact.
                                            flush_pending_delta(&pump_session, &mut pending_delta);
                                            pending_delta = Some((block, text, timestamp));
                                        }
                                    }
                                    if flush_deadline.is_none() {
                                        flush_deadline = Some(tokio::time::Instant::now() + SNAPSHOT_FLUSH_WINDOW);
                                    }
                                    continue;
                                }
                                other => other,
                            };
                            // Any other event type (tool_use, tool_result, finalized
                            // AssistantMessage, TurnUsage, Notification, ...): flush a
                            // held delta FIRST so subscribers see it before this
                            // one, preserving the parser's original event order exactly.
                            if pending_delta.is_some() {
                                flush_deadline = None;
                                flush_pending_delta(&pump_session, &mut pending_delta);
                            }
                            // A `result` line parses to TurnUsage and marks the turn
                            // complete: update awaiting status, clear busy, and
                            // broadcast the registry change.
                            let (turn_done_awaiting, turn_autopilot_changed) =
                                if let ChatEvent::TurnUsage { ref awaiting, ref autopilot_changed, .. } = ev {
                                    (Some(awaiting.clone()), *autopilot_changed)
                                } else {
                                    (None, None)
                                };
                            // The account ran out of quota mid-turn. Mark it
                            // blocked and queue the resume before the event
                            // is published, so the webview's first sight of
                            // the rejection already has the state behind it.
                            if let ChatEvent::Notification { ref kind, ref body } = ev {
                                if kind == "rate_limit" {
                                    crate::daemon::rate_limit::handle_rate_limit_rejection(
                                        &state_for_pump,
                                        &pump_session,
                                        body,
                                        saw_stream_turn,
                                    );
                                }
                            }
                            if log::log_enabled!(log::Level::Debug) {
                                let variant = serde_json::to_value(&ev)
                                    .ok()
                                    .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
                                    .unwrap_or_else(|| "?".into());
                                log::debug!("daemon publish: {variant} for {}", pump_session.session_id);
                            }
                            broadcast::publish(&pump_session, ev);
                            if let Some(awaiting) = turn_done_awaiting {
                                // Turn over: drop the shared stream accumulator so a
                                // client attaching between turns doesn't get a stale
                                // resync snapshot of the finished turn's text.
                                pump_session.streaming.lock().unwrap().clear();
                                // Character "work finished" / "asking" sound. The in-app chat's
                                // turn completion is NOT covered by the global Stop/Notification
                                // hooks (those only drive skill-usage + external sessions), so
                                // fire the sound here off the same `result` line that sets
                                // awaiting. The app maps this to `notifications::fire`, which
                                // resolves the session character + slot + mute/meeting gating.
                                // Guard on saw_stream_turn so replayed history result lines
                                // (emitted by claude on --resume before the live turn starts)
                                // don't each trigger their own sound.
                                if saw_stream_turn && matches!(awaiting.as_deref(), Some("done") | Some("question")) {
                                    state_for_pump.notifier.publish(
                                        "turn_sound",
                                        serde_json::json!({
                                            "session_id": pump_session.session_id,
                                            "cwd": pump_session.cwd.to_string_lossy(),
                                            "awaiting": awaiting.as_deref(),
                                        }),
                                    );
                                }
                                // A turn ran to completion on this account, so
                                // whatever window we had recorded is over.
                                // Hygiene only: every consumer already treats
                                // a past `resets_at` as unblocked.
                                if saw_stream_turn {
                                    state_for_pump
                                        .registry
                                        .clear_rate_limit_for_account(&pump_session.account_id);
                                }
                                let live_turn = saw_stream_turn;
                                saw_stream_turn = false;
                                // Only a LIVE turn's result may update the self-reported
                                // status, and only if no newer turn started meanwhile
                                // (gen guard, mirroring set_busy_false_if_gen). Without
                                // both gates, a replayed history result line on --resume
                                // or a cancelled turn's late result stamps a stale
                                // "question"/"waiting" over the current turn's state -
                                // the "Input needed while busy" bug.
                                if live_turn {
                                    // Ground truth beats self-report: the Stop hook that fired
                                    // just before this result line recorded how many background
                                    // tasks the CLI still had live. A marker claiming "done" (or
                                    // a missing one) while tasks run is the misjudgment class -
                                    // show "working". Self-correcting: the finishing task
                                    // re-invokes the session, and that turn's Stop refreshes the
                                    // count to zero.
                                    let awaiting = if matches!(awaiting.as_deref(), None | Some("done"))
                                        && state_for_pump.registry.background_tasks(&pump_session.session_id) > 0
                                    {
                                        Some("working".to_string())
                                    } else {
                                        awaiting
                                    };
                                    state_for_pump.registry.set_awaiting_if_gen(
                                        &pump_session.session_id,
                                        awaiting.clone(),
                                        pump_turn_gen,
                                    );
                                    // Jarvis wake (todo 272 chunk 3): a worker of Jarvis's
                                    // fleet just hit a terminal state - tell Jarvis so it can
                                    // check in instead of polling `fleet_status`. The decision
                                    // (worker? wake-worthy state?) and line formatting live in
                                    // `jarvis_wake::worker_terminal_wake` so they're unit-
                                    // testable without a live ChildStdin.
                                    if let Some(inst) = state_for_pump.registry.get(&pump_session.session_id) {
                                        let display_name = inst.name.clone().unwrap_or_else(|| pump_session.session_id.clone());
                                        if let Some((jarvis_id, line)) = crate::daemon::jarvis_wake::worker_terminal_wake(
                                            inst.worker_of.as_deref(),
                                            &pump_session.session_id,
                                            &display_name,
                                            awaiting.as_deref(),
                                        ) {
                                            crate::daemon::jarvis_wake::enqueue(&state_for_pump, &jarvis_id, line);
                                            // Dispatched detached (not awaited): this task
                                            // itself lives inside `spawn_session`'s spawn of
                                            // `run_stdout_pump`, and `drain` can loop back into
                                            // `spawn_session` on a respawn - see
                                            // `jarvis_wake::spawn_drain`'s doc for the Send-
                                            // cycle this avoids.
                                            crate::daemon::jarvis_wake::spawn_drain(&state_for_pump, &jarvis_id);
                                        }
                                    }
                                }
                                state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen);
                                // Drain-on-jarvis-idle (todo 272 chunk 3): this session IS
                                // Jarvis and it just went idle - flush anything that queued
                                // up while it was mid-turn. No-op (via the busy/ended guards
                                // inside `drain`) for every non-Jarvis session and for a
                                // stale/replayed result line that didn't actually clear busy.
                                if state_for_pump.registry.get(&pump_session.session_id).map(|i| i.jarvis).unwrap_or(false) {
                                    crate::daemon::jarvis_wake::spawn_drain(&state_for_pump, &pump_session.session_id);
                                }
                                // Drain-on-idle for the repo coordination channel: ANY
                                // session (not just Jarvis) can be woken by a peer's
                                // `post_message`, so every session that just went idle
                                // gets its queue flushed too - a no-op via `drain`'s own
                                // busy/ended/empty-queue guards when there's nothing to
                                // deliver.
                                crate::daemon::repo_channel_wake::spawn_drain(&state_for_pump, &pump_session.session_id);
                                if let Some(active) = turn_autopilot_changed {
                                    state_for_pump.registry.set_autopilot(&pump_session.session_id, active);
                                }
                                // /close teardown, daemon-authoritative: the `/close`
                                // skill's Phase 6 fires the `close_session` MCP tool,
                                // which sets `close_requested` on the registry before
                                // this result line. That explicit signal - not a parsed
                                // `<cc-close:done>` text marker - confirms the close, so
                                // tear the session down here (mark_ended + kill). Ordering
                                // is safe: the tool call is a tool_use the model awaits, so
                                // it always lands before the turn's final result line.
                                let close_confirmed =
                                    state_for_pump.registry.take_close_requested(&pump_session.session_id);
                                if close_confirmed {
                                    finalize_close(&state_for_pump, &pump_session);
                                }
                                // Stand-down/hygiene: the turn ended, so the closing
                                // segment either resolved into `ended` (finalize_close
                                // above) or the close stood down (--dont-close / a failed
                                // chain never fires the tool) - clear the flag BEFORE the
                                // snapshot below so it never persists `closing: true`.
                                if closing_flagged {
                                    closing_flagged = false;
                                    let prompt = pump_session.last_prompt.lock().ok()
                                        .map(|p| p.clone()).unwrap_or_default();
                                    if close_stand_down_is_failure(&prompt, close_confirmed) {
                                        log::warn!(
                                            "daemon: session {} /close armed but never confirmed via close_session tool; chat still open",
                                            pump_session.session_id
                                        );
                                        state_for_pump.registry.set_awaiting(
                                            &pump_session.session_id,
                                            Some(CLOSE_FAILED_AWAITING.to_string()),
                                        );
                                    }
                                    state_for_pump.registry.set_closing(&pump_session.session_id, false);
                                }
                                // Persist at turn end so a daemon restart keeps each
                                // backgrounded chat's last status instead of wiping it
                                // to "Done" (and so a marker-confirmed close sticks).
                                if live_turn || close_confirmed {
                                    crate::sessions::persistence::save_snapshot_default(&state_for_pump.registry);
                                }
                                state_for_pump.notifier.publish(
                                    "instances_changed",
                                    serde_json::json!({"instances": state_for_pump.registry.list()}),
                                );
                            }
                        }
                        line_buf.clear();
                    }
                    Err(e) => {
                        flush_pending_delta(&pump_session, &mut pending_delta);
                        log::warn!(
                            "daemon: session {} stdout read failed: {}",
                            pump_session.session_id,
                            e
                        );
                        break;
                    }
                }
            }
            // NOTE: in `tokio::select!` a disabled branch (guard = false) still
            // has its future EXPRESSION evaluated (only the polling is skipped),
            // so `flush_deadline.unwrap()` here would panic on every iteration
            // where `flush_deadline` is None (the common case) and, with
            // `panic = "abort"`, take the whole daemon down. Fall back to a
            // throwaway `now` when None; the guard still prevents this branch
            // from ever firing unless a real deadline is set.
            _ = tokio::time::sleep_until(flush_deadline.unwrap_or_else(tokio::time::Instant::now)), if flush_deadline.is_some() => {
                flush_pending_delta(&pump_session, &mut pending_delta);
                flush_deadline = None;
            }
        }
    }
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
        state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen);
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
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact todo 436 bug: a real `/close` turn ends without the
    /// `close_session` tool ever firing (model deviated, e.g. ran a
    /// terminal-kill script instead) - must be flagged as a failure.
    #[test]
    fn close_stand_down_is_failure_when_never_confirmed() {
        assert!(close_stand_down_is_failure("/close", false));
    }

    #[test]
    fn close_stand_down_not_failure_when_confirmed() {
        assert!(!close_stand_down_is_failure("/close", true));
    }

    /// `--dont-close` is an intentional dry run; standing down unconfirmed
    /// is expected there, not a failure.
    #[test]
    fn close_stand_down_not_failure_on_dont_close_flag() {
        assert!(!close_stand_down_is_failure("/close --dont-close", false));
    }

    /// A tool-only turn never emits `AssistantDelta`; without capturing `pump_turn_gen`
    /// on the first `stream_event` line instead, busy would latch on forever.
    #[test]
    fn tool_only_turn_captures_gen_and_clears_busy_at_turn_end() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        registry.set_busy("s", true);

        let mut ctx = ParserContext::new_live();
        let mut saw_stream_turn = false;
        let mut pump_turn_gen: u64 = 0;
        for line in [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"Bash","input":{}}}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ] {
            ctx.feed(format!("{line}\n").as_bytes());
            if !saw_stream_turn && ctx.take_stream_event_seen() {
                saw_stream_turn = true;
                pump_turn_gen = registry.current_turn_gen("s");
            }
        }
        assert!(saw_stream_turn, "tool-only turn must still be recognised as live");
        assert!(registry.set_busy_false_if_gen("s", pump_turn_gen), "busy must clear at turn end");
        assert!(!registry.get("s").unwrap().busy);
    }

    /// The EOF branch's own logic (todo 467 blind spot 1), previously
    /// untested: a process death mid-`/close` is always a failure.
    #[test]
    fn close_stand_down_is_failure_at_eof_when_never_confirmed() {
        assert!(close_stand_down_is_failure_at_eof(false));
        assert!(!close_stand_down_is_failure_at_eof(true));
    }

    /// Unlike the result-line path, EOF grants no `--dont-close` exemption - that
    /// flag always completes normally, so reaching EOF still-closing is a genuine crash.
    #[test]
    fn eof_path_diverges_from_result_line_path_on_dont_close() {
        assert!(!close_stand_down_is_failure("/close --dont-close", false));
        assert!(close_stand_down_is_failure_at_eof(false));
    }

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
