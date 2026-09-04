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
mod exit;
mod turn_boundary;
use close::{close_stand_down_is_failure, finalize_close, turn_is_close, CLOSE_FAILED_AWAITING};
use exit::run_pump_exit;
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
/// stdout hits EOF or a read error - hands off to `exit::run_pump_exit`.
/// Extracted out of `spawn_session` (ai_todo 197): `child` and `stdout` are
/// the two handles `spawn_session` pulled off the spawned process before
/// handing this task ownership of the rest of the session's natural
/// lifetime.
/// `resumed` = spawned with `--resume`, so claude replays transcript lines
/// before the live turn starts. See `turn_boundary::TurnBoundary::new`.
pub(crate) async fn run_stdout_pump(
    child: tokio::process::Child,
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
    // Generation of the turn being watched, HANDED over by whoever opened it
    // (`Registry::set_busy(true)` stamps it, this consumes it once). Inferring
    // it from stdout timing latched `busy` on for a whole session (todo 525).
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
                            // Trailing and spawn-banner lines find nothing pending.
                            if let Some(gen) = state_for_pump
                                .registry
                                .take_pending_turn_gen(&pump_session.session_id)
                            {
                                pump_turn_gen_captured = true;
                                pump_turn_gen = gen;
                                log::info!(
                                    "daemon: session {} pump_turn_gen captured = {pump_turn_gen}",
                                    pump_session.session_id
                                );
                            }
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
                        // Raw stdout, off unless RUST_LOG turns this module to trace:
                        // the only way to see which stream-json lines claude actually
                        // sent when a turn's reply never finalizes (todo 719).
                        if log::log_enabled!(log::Level::Trace) {
                            let raw = String::from_utf8_lossy(&line_buf);
                            let raw = raw.trim_end();
                            // 2000: a `result` line's own `result` text sits past
                            // 600 chars of usage/cost fields, and that field is the
                            // one that decides whether a turn finalizes.
                            let cut = raw.char_indices().nth(2000).map(|(i, _)| i).unwrap_or(raw.len());
                            log::trace!("daemon stdout[{}]: {}", pump_session.session_id, &raw[..cut]);
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
                                // Keeps `pump_turn_gen`: a replayed result line must
                                // not strand the live turn it sits inside without one.
                                pump_turn_gen_captured = false;
                                // report_turn_status (todo 435) is authoritative for a live
                                // turn; a replayed history line keeps the legacy marker scan.
                                let taken_report = if live_turn {
                                    state_for_pump
                                        .registry
                                        .take_reported_status_if_gen(&pump_session.session_id, pump_turn_gen)
                                } else {
                                    None
                                };
                                // todo 675 part 2: wire the registry-carried target out. A
                                // generic Notification, not a new ChatEvent variant
                                // (types/chat.rs is owned elsewhere) - published while
                                // activeTurnChipKey still points at THIS turn.
                                if let Some(target) = taken_report.as_ref().and_then(|r| r.waiting_on.as_ref()) {
                                    log::info!(
                                        "daemon: session {} waiting on: {target}",
                                        pump_session.session_id
                                    );
                                    broadcast::publish(&pump_session, ChatEvent::Notification {
                                        kind: "waiting_on".to_string(),
                                        body: target.to_string(),
                                    });
                                }
                                let awaiting = if live_turn {
                                    taken_report.map(|r| r.status).or(awaiting)
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
                                    let activity = state_for_pump
                                        .registry
                                        .turn_activity(&pump_session.session_id);
                                    let reported = awaiting.clone();
                                    let awaiting = activity.correct(awaiting);
                                    if reported != awaiting {
                                        log::info!(
                                            "daemon: session {} status corrected: reported={:?} activity={activity:?} -> {:?}",
                                            pump_session.session_id,
                                            reported.as_deref(),
                                            awaiting.as_deref(),
                                        );
                                    }
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
    run_pump_exit(
        child,
        pump_session,
        map_for_pump,
        state_for_pump,
        pump_turn_gen,
        closing_flagged,
    )
    .await;
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
            if let Some(gen) = registry.take_pending_turn_gen("s") {
                pump_turn_gen = gen;
            }
            if !saw_stream_turn && ctx.take_stream_event_seen() {
                saw_stream_turn = true;
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
        let mut pump_turn_gen_captured = false;
        // No stream_event at all - straight to a rejection result line.
        let line = r#"{"type":"result","subtype":"success","is_error":true,"result":"error","timestamp":1}"#;
        ctx.feed(format!("{line}\n").as_bytes());
        if !pump_turn_gen_captured {
            if let Some(gen) = registry.take_pending_turn_gen("s") {
                pump_turn_gen_captured = true;
                pump_turn_gen = gen;
            }
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

    /// 4th recurrence of "stuck In progress" (todos 475, 525, 621). A turn's
    /// TRAILING stdout line lands after its result line but before the next
    /// send_message bumps the gen, so capture-on-any-line pinned the ended
    /// turn's gen across the next turn and its clear was rejected as stale.
    #[test]
    fn trailing_line_after_result_does_not_pin_the_ended_turns_gen() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-19T00:00:00Z");

        let mut pump_turn_gen: u64 = 0;
        let mut pump_turn_gen_captured = false;
        fn on_line(registry: &Registry, gen_out: &mut u64, captured: &mut bool) {
            if !*captured {
                if let Some(gen) = registry.take_pending_turn_gen("s") {
                    *captured = true;
                    *gen_out = gen;
                }
            }
        }

        registry.set_busy("s", true); // send_message's pre-write bump -> gen 1
        on_line(&registry, &mut pump_turn_gen, &mut pump_turn_gen_captured);
        assert_eq!(pump_turn_gen, 1, "turn A captures its own gen");

        // Turn A's result line.
        pump_turn_gen_captured = false;
        assert!(registry.set_busy_false_if_gen("s", pump_turn_gen), "turn A clears its own busy");

        // The trailing line. Under the old timing rule this re-captured gen 1.
        on_line(&registry, &mut pump_turn_gen, &mut pump_turn_gen_captured);
        assert!(!pump_turn_gen_captured, "a trailing line of the ended turn must not capture");

        registry.set_busy("s", true); // next send_message -> gen 2
        on_line(&registry, &mut pump_turn_gen, &mut pump_turn_gen_captured);
        assert_eq!(pump_turn_gen, 2, "turn B must capture the NEW gen, not turn A's");

        // Turn B's result line: this is the clear that used to be rejected.
        assert!(
            registry.set_busy_false_if_gen("s", pump_turn_gen),
            "turn B's busy must clear - the latch that left rows stuck In progress"
        );
        assert!(!registry.get("s").unwrap().busy);
    }

    /// A turn started WITHOUT a gen bump (`mark_turn_live`, the wake paths)
    /// stamps nothing, so the pump keeps the gen it holds - which still matches.
    #[test]
    fn turn_started_without_a_gen_bump_still_clears_busy() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-19T00:00:00Z");

        registry.set_busy("s", true); // gen 1
        let mut pump_turn_gen = registry.take_pending_turn_gen("s").expect("turn A hands its gen over");

        registry.mark_turn_live("s");
        if let Some(gen) = registry.take_pending_turn_gen("s") {
            pump_turn_gen = gen;
        }
        assert_eq!(pump_turn_gen, 1, "a no-bump wake hands over nothing, so gen 1 is retained");
        assert!(registry.set_busy_false_if_gen("s", pump_turn_gen), "no-bump turn must still clear");
    }

    /// The observed failure (daemon.log 2026-08-26, session b20747fe): the CLI's
    /// spawn banner reached the pump while `turn_gen` was still 0, so every later
    /// turn captured one generation behind and `busy` never cleared again.
    #[test]
    fn spawn_banner_before_the_first_message_does_not_skew_every_later_turn() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-26T10:34:39Z");

        // 10:34:39 - spawn banner, before any message exists.
        assert!(registry.take_pending_turn_gen("s").is_none(), "the banner must capture nothing");

        registry.set_busy("s", true); // 10:38:46 - first send_message
        let turn_one = registry.take_pending_turn_gen("s").expect("turn 1 hands its gen over");
        assert_eq!(turn_one, 1);
        assert!(registry.set_busy_false_if_gen("s", turn_one), "turn 1 must clear its own busy");

        assert!(registry.take_pending_turn_gen("s").is_none(), "a trailing line must capture nothing");
        registry.set_busy("s", true); // 10:43:09 - second send_message
        let turn_two = registry.take_pending_turn_gen("s").expect("turn 2 hands its gen over");
        assert_eq!(turn_two, 2, "turn 2 must not inherit turn 1's generation");
        assert!(registry.set_busy_false_if_gen("s", turn_two), "turn 2 must clear its own busy");
        assert!(!registry.get("s").unwrap().busy);
    }

    /// todo 873: `cancel_turn` no longer force-clears busy - only the
    /// interrupted turn's own (possibly late) result line does. A stale
    /// gen-3 completion after gen 4 opens must not clear gen 4's busy, and
    /// gen 4's own completion must still clear it (session 0097d169 stuck 20m18s).
    #[test]
    fn stale_cancelled_turn_completion_does_not_strand_the_next_gens_busy() {
        use crate::sessions::registry::Registry;
        use crate::types::Settings;

        let registry = Registry::new();
        let settings = std::sync::Mutex::new(Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-09-03T15:44:43Z");

        // Turn 3 starts and goes live (a permission prompt opens mid-turn).
        registry.set_busy("s", true);
        let mut turn = TurnBoundary::new(false);
        let turn_three = registry.take_pending_turn_gen("s").expect("turn 3 hands its gen over");
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        registry.mark_turn_live("s");

        // Cancel arrives: interrupt is sent, but busy is NOT force-cleared -
        // only turn 3's own result line (below) may clear it.
        assert!(registry.get("s").unwrap().busy, "cancel must not clear busy up front");

        // Turn 3's own (possibly delayed) result line finally lands.
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
        assert!(registry.set_busy_false_if_gen("s", turn_three), "turn 3 clears its own busy");
        assert!(!registry.get("s").unwrap().busy);

        // Only now does the queued send_message open gen 4.
        registry.set_busy("s", true);
        let turn_four = registry.take_pending_turn_gen("s").expect("turn 4 hands its gen over");
        assert_eq!(turn_four, turn_three + 1);
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        registry.mark_turn_live("s");

        // A stale duplicate of turn 3's completion arrives late: rejected by
        // the gen guard, gen 4 stays busy.
        assert!(
            !registry.set_busy_false_if_gen("s", turn_three),
            "a stale gen-3 completion must not clear gen 4's busy"
        );
        assert!(registry.get("s").unwrap().busy, "gen 4 must still read busy after the stale clear is rejected");

        // Turn 4's own completion must still clear it - the exact case that
        // silently never happened for session 0097d169.
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
        assert!(
            registry.set_busy_false_if_gen("s", turn_four),
            "gen 4's own busy must not be left silently uncleared"
        );
        assert!(!registry.get("s").unwrap().busy);
    }

    /// The case the post-`fa56550a` design actually rests on: the interrupt is
    /// cooperative, so a child may simply never emit the result line that ends
    /// the turn. Busy then stays latched (the 20m watchdog is the only bound),
    /// and the next send must refuse rather than bump the gen into a live child.
    #[test]
    fn a_child_that_ignores_the_interrupt_keeps_busy_and_refuses_the_next_send() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-09-03T15:44:43Z");

        state.registry.set_busy("s", true);
        let mut turn = TurnBoundary::new(false);
        let turn_one = state.registry.take_pending_turn_gen("s").expect("turn 1 hands its gen over");
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        state.registry.mark_turn_live("s");

        // cancel_turn wrote its interrupt and cleared nothing; no result line follows.
        assert!(state.registry.get("s").unwrap().busy, "an ignored interrupt must leave the turn live");

        let err = crate::daemon::lifecycle::refuse_if_busy(&state, "s")
            .expect_err("a still-live turn must refuse the next send");
        assert!(err.to_string().starts_with("SESSION_BUSY:"), "frontends re-stage on this prefix: {err}");
        assert_eq!(
            state.registry.current_turn_gen("s"),
            turn_one,
            "a refused send must leave the gen alone - bumping it is what stranded the result line"
        );

        // Whenever the child does come back, its own result line still ends the turn.
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
        assert!(state.registry.set_busy_false_if_gen("s", turn_one), "the late result line must still clear busy");
        assert!(!state.registry.get("s").unwrap().busy);
    }
}
