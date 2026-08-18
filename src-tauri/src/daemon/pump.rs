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
use crate::sessions::registry_turn::TurnActivity;
use crate::types::chat::ChatEvent;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

mod close;
mod turn_boundary;
use close::{close_stand_down_is_failure, close_stand_down_is_failure_at_eof, finalize_close, turn_is_close, CLOSE_FAILED_AWAITING};
use turn_boundary::{TurnAction, TurnBoundary};

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
/// `resumed` = spawned with `--resume`, so claude replays transcript lines
/// before the live turn starts. See `turn_boundary::TurnBoundary::new`.
pub(crate) async fn run_stdout_pump(
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    pump_session: Arc<Session>,
    map_for_pump: SessionMap,
    state_for_pump: Arc<DaemonState>,
    resumed: bool,
) {
    let mut ctx = ParserContext::new_live();
    let mut buf_reader = BufReader::new(stdout);
    let mut line_buf = Vec::new();
    // Owns the turn-sound gate and, since chat 20176, the `busy` flag.
    let mut turn = TurnBoundary::new(resumed);
    // Generation counter captured on the turn's first stdout line of ANY
    // kind (todo 525 root cause 2: not gated on the first `stream_event`,
    // so an eventless turn still captures the CURRENT gen instead of a
    // prior turn's stale one). Guards the turn-end set_busy(false) below.
    let mut pump_turn_gen: u64 = 0;
    let mut pump_turn_gen_captured = false;
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
    // Raw concatenation of every AssistantDelta this turn (todo 291), scanned
    // for a `<cc-preview:..>` sentinel at turn end and cleared there; unlike
    // `pending_delta`/`StreamingText` this spans ALL text blocks in the turn.
    let mut turn_text = String::new();
    loop {
        tokio::select! {
            result = buf_reader.read_until(b'\n', &mut line_buf) => {
                match result {
                    Ok(0) => {
                        flush_pending_delta(&pump_session, &mut pending_delta);
                        break;
                    }
                    Ok(_) => {
                        // Watchdog signal: any stdout line at all counts as activity.
                        state_for_pump.registry.touch_activity(&pump_session.session_id);
                        if !pump_turn_gen_captured {
                            pump_turn_gen_captured = true;
                            pump_turn_gen = state_for_pump
                                .registry
                                .current_turn_gen(&pump_session.session_id);
                            log::info!(
                                "daemon: session {} pump_turn_gen captured = {pump_turn_gen}",
                                pump_session.session_id
                            );
                        }
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
                        if !turn.is_live() && ctx.take_stream_event_seen()
                            && turn.on_stream_event() == TurnAction::TurnStarted
                        {
                            let mut dirty = state_for_pump.registry.mark_turn_live(&pump_session.session_id);
                            crate::sessions::chat_state::set_busy(&pump_session.session_id, true);
                            // Mark the row "Closing" now (daemon-authoritative, no text marker)
                            // so every window's sidebar shows it; close_requested drives teardown.
                            if turn_is_close(&pump_session) {
                                closing_flagged = true;
                                dirty |= state_for_pump.registry.set_closing(&pump_session.session_id, true);
                            }
                            if dirty {
                                state_for_pump.notifier.publish(
                                    "instances_changed",
                                    serde_json::json!({"instances": state_for_pump.registry.list()}),
                                );
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
                                    turn_text.push_str(&text);
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
                                        turn.is_live(),
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
                                // Preview-push sentinel (todo 291): re-emitting the
                                // same slug iterates the panel entry in place.
                                if let Some((slug, html)) = crate::chat::parser::extract_cc_preview_push(&turn_text) {
                                    let title = crate::chat::parser::preview_title_from_slug(&slug);
                                    if let Err(e) = crate::daemon::preview::push_and_notify(
                                        &state_for_pump,
                                        title,
                                        Some(slug),
                                        html,
                                        "chat".to_string(),
                                        Some(pump_session.session_id.clone()),
                                    ) {
                                        log::warn!(
                                            "daemon: session {} chat preview push rejected: {e}",
                                            pump_session.session_id
                                        );
                                    }
                                }
                                turn_text.clear();
                                let live_turn = turn.on_result_line() == TurnAction::TurnEnded;
                                pump_turn_gen_captured = false;
                                // report_turn_status (todo 435) is authoritative for a live
                                // turn; a replayed history line keeps the legacy marker scan.
                                let awaiting = if live_turn {
                                    state_for_pump
                                        .registry
                                        .take_reported_status_if_gen(&pump_session.session_id, pump_turn_gen)
                                        .map(|r| r.status)
                                        .or(awaiting)
                                } else {
                                    awaiting
                                };
                                // Character "work finished" / "asking" sound. The in-app chat's
                                // turn completion is NOT covered by the global Stop/Notification
                                // hooks (those only drive skill-usage + external sessions), so
                                // fire the sound here off the same `result` line that sets
                                // awaiting. The app maps this to `notifications::fire`, which
                                // resolves the session character + slot + mute/meeting gating.
                                // Guard on live_turn so replayed history result lines
                                // (emitted by claude on --resume before the live turn starts)
                                // don't each trigger their own sound. should_notify_turn_sound
                                // (todo 564) also dedupes repeated `question` in a row.
                                if live_turn && state_for_pump.registry.should_notify_turn_sound(
                                    &pump_session.session_id,
                                    awaiting.as_deref(),
                                ) {
                                    state_for_pump.notifier.publish(
                                        "turn_sound",
                                        serde_json::json!({
                                            "session_id": pump_session.session_id,
                                            "cwd": pump_session.cwd.to_string_lossy(),
                                            "awaiting": awaiting.as_deref(),
                                            "fired_at_ms": chrono::Utc::now().timestamp_millis(),
                                        }),
                                    );
                                }
                                // A turn ran to completion on this account, so
                                // whatever window we had recorded is over.
                                // Hygiene only: every consumer already treats
                                // a past `resets_at` as unblocked.
                                if live_turn {
                                    state_for_pump
                                        .registry
                                        .clear_rate_limit_for_account(&pump_session.account_id);
                                }
                                // Only a LIVE turn's result may update the self-reported
                                // status, and only if no newer turn started meanwhile
                                // (gen guard, mirroring set_busy_false_if_gen). Without
                                // both gates, a replayed history result line on --resume
                                // or a cancelled turn's late result stamps a stale
                                // "question"/"waiting" over the current turn's state -
                                // the "Input needed while busy" bug.
                                if live_turn {
                                    // The Stop hook fired just before this line, so the verdict
                                    // is fresh. Self-correcting: the finishing task re-invokes
                                    // the session and its own Stop refreshes it.
                                    let awaiting = state_for_pump
                                        .registry
                                        .turn_activity(&pump_session.session_id)
                                        .correct(awaiting);
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
                                log::info!(
                                    "daemon: session {} turn end: pump_turn_gen={pump_turn_gen} registry_turn_gen={}",
                                    pump_session.session_id,
                                    state_for_pump.registry.current_turn_gen(&pump_session.session_id)
                                );
                                // A replay's result line shares the live turn's gen, so the gen
                                // guard alone cannot reject it. Latches for the watchdog if a
                                // turn ever dies without a result line.
                                if live_turn
                                    && state_for_pump.registry.set_busy_false_if_gen(&pump_session.session_id, pump_turn_gen)
                                {
                                    crate::sessions::chat_state::set_busy(&pump_session.session_id, false);
                                }
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
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// todo 525 root cause 2: a turn that errors out before ever emitting a
    /// `stream_event` (an immediate CLI-side rejection) must still capture
    /// the CURRENT gen, not silently keep whatever the PRIOR turn left
    /// behind, or its own result line can never clear busy.
    #[test]
    fn eventless_turn_captures_current_gen_and_clears_busy_at_turn_end() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-13T00:00:00Z");
        registry.set_busy("s", true); // handler's pre-write bump -> turn_gen 1

        let mut ctx = ParserContext::new_live();
        let mut saw_stream_turn = false;
        let mut pump_turn_gen: u64 = 0;
        // Mirrors pump.rs: capture on the first line of ANY kind, gated by
        // this flag - NOT gated on take_stream_event_seen().
        let mut pump_turn_gen_captured = false;
        // No stream_event at all - straight to a rejection result line.
        let line = r#"{"type":"result","subtype":"success","is_error":true,"result":"error","timestamp":1}"#;
        ctx.feed(format!("{line}\n").as_bytes());
        if !pump_turn_gen_captured {
            pump_turn_gen_captured = true;
            pump_turn_gen = registry.current_turn_gen("s");
        }
        if !saw_stream_turn && ctx.take_stream_event_seen() {
            saw_stream_turn = true;
        }
        assert!(pump_turn_gen_captured, "gen must be captured on the turn's first line");
        assert!(!saw_stream_turn, "this turn never emitted a stream_event");
        assert!(
            registry.set_busy_false_if_gen("s", pump_turn_gen),
            "the fix: gen captured on the turn's first line, not its first stream_event"
        );
        assert!(!registry.get("s").unwrap().busy);
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
