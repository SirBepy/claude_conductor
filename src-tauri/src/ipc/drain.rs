//! IPC layer for the token-drain feature. Wraps `tokens::drain` + `tokens::capacity`:
//! `chat_drain` is the per-chat popover (raw tokens + per-message breakdown + the
//! chat's size as a % of a 5h/weekly window), `chat_drains` is the leaderboard
//! (many chats, no per-message detail).
//!
//! A chat's size is a STABLE yardstick, not a live share: `lifetime cost-weighted
//! drain ÷ the estimated capacity of one window`. It never changes based on what
//! else is running, and can exceed 100% for a chat that spanned several windows.
//! The capacity is estimated by division from the live utilization snapshot
//! (`visible drain since the window reset ÷ utilization`), calibrated only from
//! high-utilization readings and persisted so the size is stable across restarts.
//! No dollar figure is ever produced or surfaced (the user is subscription-based).

use crate::settings::paths;
use crate::state::AppState;
use crate::tokens::{self, capacity, drain as drain_engine, ChatDrain, MessageDrain};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::State;

const FIVE_HOURS: Duration = Duration::from_secs(5 * 60 * 60);
const SEVEN_DAYS: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Don't re-run the expensive all-chats windowed-drain sum more often than this;
/// capacity barely moves window to window, so a slightly stale ruler is fine.
const RECALIBRATE_AFTER: Duration = Duration::from_secs(60);

/// Given one already-matched instance's cwd + registered transcript path,
/// resolve the real transcript file to use: the registered path if it still
/// exists, else a fresh lookup by session id or the cwd's latest transcript.
/// Shared by the desktop `resolve_session` (below, reading
/// `AppState.cached_instances`) and the daemon RPC (reading `state.registry`
/// - see `daemon/methods/drain.rs`), which resolve the SAME live-instance
/// case against two different instance sources.
pub(crate) fn resolve_instance_transcript(
    cwd: &Path,
    session_id: &str,
    transcript_path: Option<&Path>,
) -> Option<PathBuf> {
    match transcript_path {
        Some(p) if p.exists() => Some(p.to_path_buf()),
        _ => tokens::transcript_for_session(cwd, session_id)
            .or_else(|| tokens::latest_transcript_for_cwd(cwd)),
    }
}

/// History-only fallback: scan every project dir for `<session_id>.jsonl` and
/// decode the dir name back to the real cwd. Shared by the desktop
/// `resolve_session` and the daemon RPC (`daemon/methods/drain.rs`) - neither
/// has a way to resolve a session that isn't live, so both fall back to the
/// same on-disk scan.
pub(crate) fn resolve_session_from_history(session_id: &str) -> Option<(PathBuf, PathBuf)> {
    let projects = tokens::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            let cwd = dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|name| PathBuf::from(tokens::decode_cwd(name)))
                .unwrap_or_else(|| dir.clone());
            return Some((cwd, candidate));
        }
    }
    None
}

/// Resolves `(cwd, main_transcript)` for a session id the way
/// `instance_token_stats` / `context_status` do: the live instance cache first,
/// then a scan of `~/.claude/projects/*/<id>.jsonl` for history-only sessions.
fn resolve_session(session_id: &str, state: &AppState) -> Option<(PathBuf, PathBuf)> {
    // 1. Live instance cache.
    if let Some(inst) = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()
    {
        if let Some(t) = resolve_instance_transcript(&inst.cwd, session_id, inst.transcript_path.as_deref()) {
            return Some((inst.cwd.clone(), t));
        }
    }

    // 2. History-only fallback.
    resolve_session_from_history(session_id)
}

/// One window's live state from the usage snapshot: utilization percent and the
/// start of the current rolling window (`resets_at - window length`). Either
/// field is `None` when there's no snapshot or `resets_at` won't parse.
/// `pub(crate)`: named in `drain_board`'s signature below, which the daemon
/// RPC (`daemon/methods/drain.rs`) also calls.
#[derive(Clone, Copy)]
pub(crate) struct WindowCtx {
    util: Option<f64>,
    start: Option<SystemTime>,
}

/// The 5h and weekly window contexts from a usage snapshot, or the "unknown"
/// pair when there is none. Pure (no `AppState`) so both the desktop
/// `windows_from_state` below and the daemon RPC (which reads the DB-backed
/// snapshot instead of `AppState.current_usage`) share the exact same
/// resets_at -> window-start math.
pub(crate) fn windows_from_snapshot(snap: Option<&crate::types::UsageSnapshot>) -> (WindowCtx, WindowCtx) {
    match snap {
        Some(s) => (
            WindowCtx {
                util: Some(s.five_hour.utilization),
                start: drain_engine::rfc3339_to_system_time(&s.five_hour.resets_at).and_then(|r| r.checked_sub(FIVE_HOURS)),
            },
            WindowCtx {
                util: Some(s.seven_day.utilization),
                start: drain_engine::rfc3339_to_system_time(&s.seven_day.resets_at).and_then(|r| r.checked_sub(SEVEN_DAYS)),
            },
        ),
        None => (
            WindowCtx { util: None, start: None },
            WindowCtx { util: None, start: None },
        ),
    }
}

/// The 5h and weekly window contexts from the latest usage snapshot.
fn windows_from_state(state: &AppState) -> (WindowCtx, WindowCtx) {
    let snap = state.current_usage.lock().unwrap();
    windows_from_snapshot(snap.as_ref())
}

/// Resolves the capacity-estimate file for one account dimension:
/// `Some(id)` = that account's own keyed file
/// (`session-capacity-<id>.json`), `None` = the legacy/default file
/// (`session-capacity.json`), preserving pre-multi-account behavior.
fn capacity_file_for(account_id: Option<&str>) -> anyhow::Result<PathBuf> {
    match account_id {
        Some(id) => paths::account_session_capacity_file(id),
        None => paths::session_capacity_file(),
    }
}

/// Loads the persisted capacity estimate and, unless it was refreshed within the
/// last minute, recalibrates each window from the visible chats' drain since that
/// window's reset (only when utilization clears the floor). Returns the
/// capacities to use as denominators: `None` when still unknown (no high-util
/// sample seen yet), so the UI shows "—%" rather than a bogus number.
///
/// `account_id` selects which account's capacity file (and therefore whose
/// window reset times the estimate is calibrated against) is used; `None` is
/// the legacy/default dimension. Current chat-UI callers pass `None` until
/// milestones 05/06 thread a real account selection through.
fn compute_capacities(
    resolved: &[(String, PathBuf, PathBuf)],
    five: &WindowCtx,
    weekly: &WindowCtx,
    account_id: Option<&str>,
) -> (Option<f64>, Option<f64>) {
    let Ok(path) = capacity_file_for(account_id) else {
        return (None, None);
    };
    let mut est = capacity::load(&path);

    let now = SystemTime::now();
    let stale = drain_engine::rfc3339_to_system_time(&est.updated_at)
        .and_then(|t| now.duration_since(t).ok())
        .map(|age| age >= RECALIBRATE_AFTER)
        .unwrap_or(true);

    if stale {
        let mut changed = false;
        let mut recalc = |ctx: &WindowCtx, prev: f64| -> f64 {
            match (ctx.util, ctx.start) {
                (Some(u), Some(start)) if u >= capacity::UTIL_FLOOR_PCT => {
                    let visible: f64 = resolved
                        .iter()
                        .map(|(id, cwd, _)| drain_engine::drain_units_for_session(cwd, id, Some(start)))
                        .sum();
                    let next = capacity::calibrate_window(prev, visible, u);
                    if next != prev {
                        changed = true;
                    }
                    next
                }
                _ => prev,
            }
        };
        est.capacity_5h_units = recalc(five, est.capacity_5h_units);
        est.capacity_weekly_units = recalc(weekly, est.capacity_weekly_units);

        if changed {
            est.samples = est.samples.saturating_add(1);
            est.updated_at = chrono::DateTime::<chrono::Utc>::from(now).to_rfc3339();
            let _ = capacity::save(&path, &est);
        }
    }

    let cap = |v: f64| if v > 0.0 { Some(v) } else { None };
    (cap(est.capacity_5h_units), cap(est.capacity_weekly_units))
}

/// A chat's size as a percent of one window: `lifetime drain ÷ capacity`. `None`
/// when capacity is unknown (no usable utilization sample yet).
fn size_pct(lifetime_units: f64, capacity: Option<f64>) -> Option<f64> {
    match capacity {
        Some(c) if c > 0.0 => Some(lifetime_units / c * 100.0),
        _ => None,
    }
}

/// Builds a `ChatDrain`: raw token total + window-size percents + per-message
/// breakdown (empty for the leaderboard, full for the popover).
fn build_chat_drain(
    session_id: &str,
    main_transcript: &Path,
    five_hour_pct: Option<f64>,
    weekly_pct: Option<f64>,
    messages: Vec<MessageDrain>,
) -> ChatDrain {
    let totals = tokens::parse_transcript(main_transcript);
    let tokens_sum = totals.input_tokens
        + totals.output_tokens
        + totals.cache_read_tokens
        + totals.cache_creation_tokens;
    ChatDrain {
        session_id: session_id.to_string(),
        tokens: tokens_sum,
        five_hour_pct,
        weekly_pct,
        messages,
    }
}

/// Full rundown for ONE chat (the popover): raw tokens + per-message breakdown +
/// the chat's size as a % of a 5h/weekly window. Resolves the visible set itself
/// so the capacity estimate is available without the sidebar's drain sort having
/// run.
#[tauri::command]
pub async fn chat_drain(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChatDrain>, String> {
    let Some((target_cwd, main_transcript)) = resolve_session(&session_id, &state) else {
        return Ok(None);
    };

    // Visible set = every live instance, plus the target itself (it may be a
    // history-only session not in the cache). Collect ids first so the cache lock
    // isn't held across the per-id resolve.
    let mut ids: Vec<String> = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .map(|i| i.session_id.clone())
        .collect();
    if !ids.iter().any(|i| i == &session_id) {
        ids.push(session_id.clone());
    }
    let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for id in &ids {
        if let Some((cwd, transcript)) = resolve_session(id, &state) {
            resolved.push((id.clone(), cwd, transcript));
        }
    }

    let (five, weekly) = windows_from_state(&state);
    let target = session_id.clone();

    // Heavy file parsing off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        let (cap_5h, cap_weekly) = compute_capacities(&resolved, &five, &weekly, None);
        let lifetime = drain_engine::drain_units_for_session(&target_cwd, &target, None);
        let messages = drain_engine::message_drains(&main_transcript);
        build_chat_drain(
            &target,
            &main_transcript,
            size_pct(lifetime, cap_5h),
            size_pct(lifetime, cap_weekly),
            messages,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(result))
}

/// Leaderboard payload: per-session window-size percents, messages omitted.
#[derive(serde::Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrainBoard {
    pub chats: HashMap<String, ChatDrain>, // per session: tokens + size %, messages EMPTY
}

/// Leaderboard math for MANY chats (messages omitted): capacity estimate +
/// per-session window-size percents. Pure and blocking-safe (file parsing),
/// shared by the desktop `chat_drains` Tauri command below and the daemon RPC
/// (`daemon/methods/drain.rs`) - the `account_id: None` capacity dimension
/// (legacy/default file) matches desktop's behaviour exactly, since neither
/// caller threads a real account selection through yet (see
/// `compute_capacities`'s doc comment).
pub(crate) fn drain_board(
    resolved: &[(String, PathBuf, PathBuf)],
    five: &WindowCtx,
    weekly: &WindowCtx,
) -> DrainBoard {
    let (cap_5h, cap_weekly) = compute_capacities(resolved, five, weekly, None);
    let mut chats = HashMap::new();
    for (id, cwd, transcript) in resolved {
        let lifetime = drain_engine::drain_units_for_session(cwd, id, None);
        let cd = build_chat_drain(
            id,
            transcript,
            size_pct(lifetime, cap_5h),
            size_pct(lifetime, cap_weekly),
            Vec::new(),
        );
        chats.insert(id.clone(), cd);
    }
    DrainBoard { chats }
}

/// Leaderboard payload for MANY chats. messages omitted (empty) for the cheap path.
#[tauri::command]
pub async fn chat_drains(
    session_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<DrainBoard, String> {
    // Resolve everything against the instance cache up front (the cache lock is
    // sync + must not be held across `.await`), then hand the resolved paths to
    // the blocking parse stage.
    let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for id in &session_ids {
        if let Some((cwd, transcript)) = resolve_session(id, &state) {
            resolved.push((id.clone(), cwd, transcript));
        }
    }

    let (five, weekly) = windows_from_state(&state);

    let board = tokio::task::spawn_blocking(move || drain_board(&resolved, &five, &weekly))
        .await
        .map_err(|e| e.to_string())?;

    Ok(board)
}
