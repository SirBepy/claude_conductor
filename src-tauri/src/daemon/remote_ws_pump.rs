//! WebSocket event-pump group split out of `remote_handlers.rs` (ai_todo 554):
//! the global and per-session live-event forwarders, plus the respawn-wait
//! helper they share. `remote_handlers.rs` still owns route wiring
//! (`stream_ws` / `global_stream_ws`) and calls into `pump_events` /
//! `pump_global_events` here.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use tokio::sync::broadcast::error::RecvError;

use crate::daemon::machines::registry::PeerMachine;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;

use super::remote_handlers::{strip_hidden_instances, strip_hidden_instances_json};

/// How often `pump_global_events` sends an app-level heartbeat text frame.
/// Browsers never surface native WS ping/pong to JS (`onclose` does not fire
/// on a half-open/zombie socket - e.g. after the phone's screen was off long
/// enough for the OS to freeze the connection without a clean FIN), so
/// http-transport.ts's watchdog needs a text frame it can time against to
/// detect a silently-dead connection instead.
const GLOBAL_HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// The one heartbeat frame, shared by the global stream and by every per-chat
/// stream that asked for beats (`hb=1`).
fn heartbeat_frame() -> String {
    serde_json::json!({"jsonrpc": "2.0", "method": "heartbeat", "params": {}}).to_string()
}

/// Heartbeat period for a per-chat stream. Only an explicit `hb=1` opts in:
/// a paired machine's relay and attach code forward every text frame as a chat
/// event, so an unasked beat would reach them as one.
pub(super) fn chat_heartbeat_period(hb: Option<&str>) -> Option<std::time::Duration> {
    (hb == Some("1")).then_some(GLOBAL_HEARTBEAT_INTERVAL)
}

/// Heartbeat period of the global stream, which always beats.
pub(super) fn global_heartbeat_period() -> Option<std::time::Duration> {
    Some(GLOBAL_HEARTBEAT_INTERVAL)
}

/// Who opened a stream and whether it beats; the pumps log with it and read
/// the period from it.
#[derive(Clone)]
pub(super) struct StreamOpts {
    /// Registry id of the authenticated device (an identifier, never a token).
    pub dev: String,
    /// `phone` or `peer`.
    pub kind: &'static str,
    pub heartbeat: Option<std::time::Duration>,
}

/// A repeating heartbeat timer that never fires when the stream did not ask
/// for beats, so a pump selects on it unconditionally. The first beat comes
/// one period after creation. `Delay` keeps a stalled pump from bursting
/// several beats back to back once it runs again.
struct Beat(Option<tokio::time::Interval>);

impl Beat {
    fn new(period: Option<std::time::Duration>) -> Self {
        Beat(period.map(|p| {
            let mut i = tokio::time::interval_at(tokio::time::Instant::now() + p, p);
            i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            i
        }))
    }

    /// Cancel-safe, so it can sit in a `select!` arm.
    async fn tick(&mut self) {
        match self.0.as_mut() {
            Some(i) => {
                i.tick().await;
            }
            None => std::future::pending::<()>().await,
        }
    }
}

/// Why a stream ended, as it reads in the `[remote-ws]` close line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseCause {
    ClientClosed,
    SendFailed,
    NotifierClosed,
    SessionEnded,
}

impl CloseCause {
    fn as_str(self) -> &'static str {
        match self {
            CloseCause::ClientClosed => "client closed",
            CloseCause::SendFailed => "send failed",
            CloseCause::NotifierClosed => "notifier closed",
            CloseCause::SessionEnded => "session ended",
        }
    }
}

/// `chat` is the session id for a per-chat stream (shortened to 8 chars), `None`
/// for the global stream. Carries the device id only: never the token or the
/// query string.
fn open_line(dev: &str, kind: &str, chat: Option<&str>, heartbeat: bool) -> String {
    match chat {
        None => format!("[remote-ws] dev={dev} kind={kind} global open"),
        Some(id) => format!("[remote-ws] dev={dev} kind={kind} chat {} open hb={heartbeat}", short_id(id)),
    }
}

fn close_line(dev: &str, kind: &str, chat: Option<&str>, age: std::time::Duration, cause: CloseCause) -> String {
    let scope = match chat {
        None => "global".to_string(),
        Some(id) => format!("chat {}", short_id(id)),
    };
    format!("[remote-ws] dev={dev} kind={kind} {scope} closed after {}s: {}", age.as_secs(), cause.as_str())
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Logs the open line now and the close line when `finish` is called.
struct StreamLog {
    opts: StreamOpts,
    chat: Option<String>,
    opened: std::time::Instant,
}

impl StreamLog {
    fn open(opts: &StreamOpts, chat: Option<&str>) -> Self {
        log::info!("{}", open_line(&opts.dev, opts.kind, chat, opts.heartbeat.is_some()));
        Self { opts: opts.clone(), chat: chat.map(str::to_string), opened: std::time::Instant::now() }
    }

    fn finish(self, cause: CloseCause) {
        log::info!("{}", close_line(&self.opts.dev, self.opts.kind, self.chat.as_deref(), self.opened.elapsed(), cause));
    }
}

/// Frames buffered while the host was asleep and older than this are dropped
/// rather than forwarded - see the `turn_sound` staleness check below.
const TURN_SOUND_STALE_MS: i64 = 15_000;

/// Builds the same `instances_changed` frame shape the notifier publishes on
/// every registry mutation (see e.g. `daemon::methods::registry`), so a
/// freshly (re)connected client gets an immediate full resync instead of
/// waiting for the next mutation.
fn instances_changed_frame(state: &DaemonState, keep_jarvis: bool) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "instances_changed",
        "params": {"instances": strip_hidden_instances(crate::daemon::machines::all_instances(state), keep_jarvis)},
    })
    .to_string()
}

/// Forwards every daemon-wide notifier event to a global (not
/// session-scoped) WebSocket client verbatim - no per-event filtering -
/// because every notifier event (`instances_changed`,
/// `project_created`, `scheduled_items_changed`, `scheduled_item_fired`,
/// `permission_request`, `question_request`, `question_expired`,
/// `turn_sound`, `refresh_requested`, `usage_poll_requested`, `quit_requested`,
/// `skill_usage_changed`, `api_credit_status_changed`, `session_character_assigned`,
/// `token_history_updated` - see the `notifier.publish` call sites across
/// `daemon/`) mirrors data already exposed by an allowlisted `/api/rpc`
/// method (`list_instances`, `list_pending_prompts`, `get_token_history`,
/// `list_session_characters`, ...), so nothing here is more sensitive than
/// what a paired remote client can already read over REST.
/// A widget host announcing whether it is currently rendering our widget
/// itself. Returns `None` for every other client frame, all of which stay
/// ignored - this is the only inbound method this socket understands.
fn parse_host_overlay(txt: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("method").and_then(serde_json::Value::as_str)? != "host_overlay" {
        return None;
    }
    v.pointer("/params/hosted").and_then(serde_json::Value::as_bool)
}

/// A client liveness probe on the global stream. Answered with a heartbeat
/// frame so the page can tell a dead socket from a quiet one without waiting
/// out the heartbeat period.
fn is_ping(txt: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(txt)
        .ok()
        .and_then(|v| v.get("method").and_then(serde_json::Value::as_str).map(|m| m == "ping"))
        .unwrap_or(false)
}

/// What the global pump does with one notifier receive.
#[derive(Debug, PartialEq)]
enum GlobalStep {
    Send(String),
    Skip,
    Stop,
}

fn global_step(state: &DaemonState, keep_jarvis: bool, recv: Result<serde_json::Value, RecvError>) -> GlobalStep {
    let mut frame = match recv {
        Ok(f) => f,
        // The slow socket missed frames (`instances_changed`, prompts, ...)
        // and nothing else tells the client, so hand it the same snapshot a
        // fresh connect gets.
        Err(RecvError::Lagged(n)) => {
            log::info!("[remote-ws] global stream lagged: dropped {n} frames, resending the instances snapshot");
            return GlobalStep::Send(instances_changed_frame(state, keep_jarvis));
        }
        Err(RecvError::Closed) => return GlobalStep::Stop, // notifier sender dropped (daemon shutting down)
    };
    // The notifier fans out every daemon-wide event verbatim (see the doc
    // above `parse_host_overlay`), but `instances_changed` specifically must
    // never carry worker sessions (nor Jarvis, for a peer machine) to a remote
    // client - the initial resync frame already strips them; do the same for
    // every live one, or a later unrelated registry mutation anywhere in the
    // daemon would re-leak the full unfiltered list within seconds.
    if frame.get("method").and_then(serde_json::Value::as_str) == Some("instances_changed") {
        if let Some(arr) = frame.pointer_mut("/params/instances").and_then(serde_json::Value::as_array_mut) {
            strip_hidden_instances_json(arr, keep_jarvis);
        }
    }
    // `keep_jarvis` is false exactly for a paired machine. A peer reads
    // previews per chat (`list_previews`/`get_preview` scope it), so the
    // stream must not hand it every snapshot's title and slug either.
    if !keep_jarvis && !peer_may_see_preview(&frame, |sid| crate::daemon::machines::is_local_session(state, sid)) {
        return GlobalStep::Skip;
    }
    // A suspended host doesn't cleanly close this socket, so `turn_sound`
    // frames pile up in the broadcast buffer and blast out all at once on
    // wake. Dropping ones older than the cutoff is intentional (user wants
    // "missed while asleep" to mean missed), not a bug - every other event
    // type still forwards unconditionally.
    if frame.get("method").and_then(serde_json::Value::as_str) == Some("turn_sound") {
        let fired_at_ms = frame.pointer("/params/fired_at_ms").and_then(serde_json::Value::as_i64);
        let age_ms = fired_at_ms.map(|t| chrono::Utc::now().timestamp_millis() - t);
        if age_ms.is_some_and(|age| age > TURN_SOUND_STALE_MS) {
            return GlobalStep::Skip;
        }
    }
    match serde_json::to_string(&frame) {
        Ok(t) => GlobalStep::Send(t),
        Err(_) => GlobalStep::Skip,
    }
}

pub(super) async fn pump_global_events(socket: WebSocket, state: Arc<DaemonState>, keep_jarvis: bool, opts: StreamOpts) {
    let log = StreamLog::open(&opts, None);
    let cause = global_loop(socket, &state, keep_jarvis, &opts).await;
    log.finish(cause);
}

async fn global_loop(mut socket: WebSocket, state: &Arc<DaemonState>, keep_jarvis: bool, opts: &StreamOpts) -> CloseCause {
    // Heal a client that just (re)connected: send a full snapshot before any
    // future mutation, mirroring `fetch_and_reseed_instances` on the
    // desktop app-side link.
    if socket
        .send(Message::Text(instances_changed_frame(state, keep_jarvis)))
        .await
        .is_err()
    {
        return CloseCause::SendFailed;
    }

    let mut rx = state.notifier.subscribe();
    // First beat one period after the snapshot.
    let mut beat = Beat::new(opts.heartbeat);
    // Per connection, so an unrelated client closing clears nothing.
    let mut hosting = false;

    let cause = loop {
        tokio::select! {
            recv = rx.recv() => match global_step(state, keep_jarvis, recv) {
                GlobalStep::Send(txt) => {
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break CloseCause::SendFailed;
                    }
                }
                GlobalStep::Skip => {}
                GlobalStep::Stop => break CloseCause::NotifierClosed,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Some(h) = parse_host_overlay(&t) {
                        hosting = h;
                        state.notifier.publish("widget_host_changed", serde_json::json!({"hosted": h}));
                    } else if is_ping(&t) {
                        // Answered at once; the periodic beat keeps its own
                        // schedule, since a probe says nothing about when the
                        // next unprompted frame is due.
                        if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                            break CloseCause::SendFailed;
                        }
                    }
                }
                Some(Ok(_)) => {} // ignore every other client->server frame
                _ => break CloseCause::ClientClosed, // client closed or errored
            },
            _ = beat.tick() => {
                if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                    break CloseCause::SendFailed;
                }
            }
        }
    };
    // Covers the host quitting, crashing and being killed alike, so a hosting
    // claim can never outlive the socket that made it.
    if hosting {
        state.notifier.publish("widget_host_changed", serde_json::json!({"hosted": false}));
    }
    cause
}

/// Whether a paired machine may receive this global frame. `preview` frames
/// are filtered: one for a chat hosted here passes (the peer mirrors that chat
/// and can already read its previews), a session-less one or one for any other
/// chat never does. `preview_state` never passes: it names no chat, and a peer
/// does not follow or write another machine's view state. `answers_thread_delta`
/// never passes either: it streams an Ask reply's text, and the answers RPCs are
/// desktop-pipe only, so that text has no business on another machine. Every
/// other method passes.
fn peer_may_see_preview(frame: &serde_json::Value, is_local: impl Fn(&str) -> bool) -> bool {
    match frame.get("method").and_then(serde_json::Value::as_str) {
        Some("preview_state" | "answers_thread_delta") => return false,
        Some("preview") => {}
        _ => return true,
    }
    frame.pointer("/params/snapshot/session_id").and_then(serde_json::Value::as_str).is_some_and(is_local)
}

/// How long `pump_events` keeps polling the SessionMap for a respawn after its
/// broadcast channel closes, before giving up and closing the socket (falling
/// back to the client's own reconnect-with-backoff in http-transport.ts).
/// Bounded so a browser tab left open on a session that has genuinely ended
/// doesn't poll the daemon forever.
const RESPAWN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
const RESPAWN_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Forward a session's live ChatEvent broadcast to the WebSocket client until
/// either side closes. Mirrors what the desktop Tauri event stream delivers, so
/// a phone client sees the same turns stream in real time.
///
/// The per-turn `claude -p` process exits at the end of every turn (see
/// `daemon::lifecycle::spawn_session`'s pump-exit handling), which drops this
/// session's broadcast sender and closes `rx`. A naive close-on-`Closed` here
/// would strand this window on the client's 1s-30s exponential WS reconnect
/// backoff - exactly the window in which a sibling window's message can
/// respawn the session and get silently missed here (the bug this whole
/// change fixes). Instead, poll the SessionMap for the respawn and resubscribe
/// to the NEW session's channel on the SAME socket.
pub(super) async fn pump_events(socket: WebSocket, state: Arc<DaemonState>, session_id: String, session: Arc<Session>, opts: StreamOpts) {
    let log = StreamLog::open(&opts, Some(&session_id));
    let cause = events_loop(socket, state, session_id, session, opts.heartbeat).await;
    log.finish(cause);
}

async fn events_loop(
    mut socket: WebSocket,
    state: Arc<DaemonState>,
    session_id: String,
    session: Arc<Session>,
    heartbeat: Option<std::time::Duration>,
) -> CloseCause {
    let mut rx = crate::daemon::broadcast::subscribe(&session);
    let mut beat = Beat::new(heartbeat);
    // Mid-turn attach resync (ai_todo 186): the stream now carries O(delta)
    // `assistant_delta` chunks, so a client joining mid-turn has no way to
    // recover the text already streamed. Send the accumulated block as one
    // `snapshot: true` frame first; any deltas already queued in `rx` carry a
    // `seq` at or below the snapshot's and are dropped client-side. (The PWA
    // client is served by this same daemon, so it always speaks the delta
    // protocol - no legacy conversion needed here, unlike `attach_session`.)
    // (Bound separately: an `if let` scrutinee would hold the MutexGuard
    // across the `.await`, making the future non-Send.)
    let resync = session.streaming.lock().unwrap().snapshot_event();
    if let Some(snap) = resync {
        if let Ok(txt) = serde_json::to_string(&snap) {
            if socket.send(Message::Text(txt)).await.is_err() {
                return CloseCause::SendFailed;
            }
        }
    }
    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(ev) => {
                    let txt = match serde_json::to_string(&ev) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        return CloseCause::SendFailed;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Dropped frames under load. Deltas don't compose across a
                    // gap, so resync the streamed text with a snapshot frame
                    // before continuing (a delta client drops anything its
                    // accumulator already covers).
                    log::warn!("remote stream lagged for {session_id}: dropped {n} chat events");
                    // Non-delta events (finalized messages, tool calls,
                    // notifications) are gone for good - tell the client to
                    // force a transcript re-read.
                    let lagged = crate::types::chat::ChatEvent::EventsLagged {
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    if let Ok(txt) = serde_json::to_string(&lagged) {
                        if socket.send(Message::Text(txt)).await.is_err() {
                            return CloseCause::SendFailed;
                        }
                    }
                    // Look the session up fresh: after a respawn+resubscribe
                    // (`wait_for_respawn` below) the captured `session` is the
                    // OLD object and its accumulator would be stale.
                    let snap = state
                        .sessions
                        .get(&session_id)
                        .map(|s| s.clone())
                        .and_then(|s| s.streaming.lock().unwrap().snapshot_event());
                    if let Some(snap) = snap {
                        if let Ok(txt) = serde_json::to_string(&snap) {
                            if socket.send(Message::Text(txt)).await.is_err() {
                                return CloseCause::SendFailed;
                            }
                        }
                    }
                    continue;
                }
                Err(RecvError::Closed) => {
                    match wait_for_respawn(&state, &session_id, &mut socket, &mut beat).await {
                        Ok(new_rx) => rx = new_rx,
                        Err(cause) => return cause, // client gone, or no respawn within RESPAWN_MAX_WAIT
                    }
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames for now
                _ => return CloseCause::ClientClosed,
            },
            _ = beat.tick() => {
                if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                    return CloseCause::SendFailed;
                }
            }
        }
    }
}

/// Forwards a MIRRORED session's live events to a phone/browser WS client:
/// `machines::relay::relay_session_frames` reads the owning peer's own
/// `pump_events` stream (same raw `ChatEvent` JSON this fn's `Ok(ev)` arm
/// serializes above), so every frame is forwarded verbatim - no reshaping,
/// unlike `attach_session`'s desktop-pipe relay which wraps each frame in the
/// `chat_event` notification envelope for that transport instead.
pub(super) async fn pump_relayed_session_events(
    socket: WebSocket,
    state: Arc<DaemonState>,
    peer: PeerMachine,
    session_id: String,
    opts: StreamOpts,
) {
    let log = StreamLog::open(&opts, Some(&session_id));
    let cause = relayed_loop(socket, state, peer, session_id, opts.heartbeat).await;
    log.finish(cause);
}

async fn relayed_loop(
    mut socket: WebSocket,
    state: Arc<DaemonState>,
    peer: PeerMachine,
    session_id: String,
    heartbeat: Option<std::time::Duration>,
) -> CloseCause {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let _producer_guard = crate::daemon::machines::relay::AbortOnDrop(tokio::spawn(
        crate::daemon::machines::relay::relay_session_frames(state, peer, session_id, tx),
    ));
    // This pump makes its own beats: the relay connects to the peer without
    // `hb`, so the peer sends none and nothing from it is forwarded as one.
    let mut beat = Beat::new(heartbeat);
    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Some(txt) => {
                    if socket.send(Message::Text(txt)).await.is_err() {
                        return CloseCause::SendFailed;
                    }
                }
                None => return CloseCause::SessionEnded, // relay gave up (peer unpaired, or unreachable for good)
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames
                _ => return CloseCause::ClientClosed,
            },
            _ = beat.tick() => {
                if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                    return CloseCause::SendFailed;
                }
            }
        }
    }
}

/// Poll interval for `pump_external_session_events`'s transcript tail.
/// Shorter than `relay::RELAY_RETRY` (a network reconnect backoff) since
/// this is a plain local file read: the goal is "feels live", not
/// battery-friendly background polling.
const EXTERNAL_TAIL_POLL: std::time::Duration = std::time::Duration::from_millis(400);

/// Serves the live stream for an EXTERNAL (terminal) session THIS daemon's
/// own registry knows about - one with no daemon child/pump, so
/// `pump_events`'s subscribe-to-a-broadcast-channel path doesn't apply (see
/// `stream_ws`'s call site). Tails `transcript_path` from its current EOF
/// (history already covers everything written before this socket opened)
/// using the same offset-based, partial-line-safe reader the desktop's
/// `watch_session_transcript` command uses
/// (`crate::chat::history::tail_new_events`), and emits each new parsed
/// `ChatEvent` as the same raw-JSON frame shape `pump_events` sends for a
/// daemon-hosted chat - so neither consumer (`attach_session`'s relay, which
/// re-wraps every frame, or the phone's verbatim forward) needs to know
/// which kind of session it's reading from.
pub(super) async fn pump_external_session_events(
    socket: WebSocket,
    transcript_path: std::path::PathBuf,
    session_id: String,
    opts: StreamOpts,
) {
    let log = StreamLog::open(&opts, Some(&session_id));
    let cause = external_loop(socket, transcript_path, opts.heartbeat, EXTERNAL_TAIL_POLL).await;
    log.finish(cause);
}

async fn external_loop(
    mut socket: WebSocket,
    transcript_path: std::path::PathBuf,
    heartbeat: Option<std::time::Duration>,
    poll_every: std::time::Duration,
) -> CloseCause {
    let mut offset = tokio::task::spawn_blocking({
        let p = transcript_path.clone();
        move || std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
    })
    .await
    .unwrap_or(0);

    let mut poll = tokio::time::interval(poll_every);
    let mut beat = Beat::new(heartbeat);
    loop {
        tokio::select! {
            _ = poll.tick() => {
                let (events, new_offset) = tokio::task::spawn_blocking({
                    let p = transcript_path.clone();
                    let cur = offset;
                    move || crate::chat::history::tail_new_events(&p, cur)
                })
                .await
                .unwrap_or((Vec::new(), offset));
                offset = new_offset;
                for ev in events {
                    let txt = match serde_json::to_string(&ev) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        return CloseCause::SendFailed;
                    }
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames
                _ => return CloseCause::ClientClosed,
            },
            _ = beat.tick() => {
                if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                    return CloseCause::SendFailed;
                }
            }
        }
    }
}

/// Poll the SessionMap for `session_id` to come back live, up to
/// `RESPAWN_MAX_WAIT`, while still watching `socket` so a client-initiated
/// close is honored immediately instead of waiting out the poll.
///
/// Keeps beating (when `beat` is live) while it waits: a healthy chat idles
/// here between turns for up to the whole wait, and a silent socket would read
/// as dead to a client that watches for heartbeats.
async fn wait_for_respawn(
    state: &Arc<DaemonState>,
    session_id: &str,
    socket: &mut WebSocket,
    beat: &mut Beat,
) -> Result<tokio::sync::broadcast::Receiver<crate::types::chat::ChatEvent>, CloseCause> {
    let deadline = tokio::time::Instant::now() + RESPAWN_MAX_WAIT;
    loop {
        if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
            return Ok(crate::daemon::broadcast::subscribe(&session));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CloseCause::SessionEnded);
        }
        tokio::select! {
            _ = tokio::time::sleep(RESPAWN_POLL_INTERVAL) => continue,
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => continue, // ignore client frames while waiting
                _ => return Err(CloseCause::ClientClosed),
            },
            _ = beat.tick() => {
                if socket.send(Message::Text(heartbeat_frame())).await.is_err() {
                    return Err(CloseCause::SendFailed);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    #[test]
    fn a_peer_gets_preview_frames_only_for_chats_hosted_here() {
        let frame = |sid: serde_json::Value| {
            serde_json::json!({"jsonrpc": "2.0", "method": "preview", "params": {"snapshot": {"id": "p", "title": "t", "session_id": sid}}})
        };
        let is_local = |sid: &str| sid == "local";
        assert!(peer_may_see_preview(&frame(serde_json::json!("local")), is_local));
        assert!(!peer_may_see_preview(&frame(serde_json::Value::Null), is_local), "session-less snapshot");
        assert!(!peer_may_see_preview(&frame(serde_json::json!("elsewhere")), is_local));
        let other = serde_json::json!({"jsonrpc": "2.0", "method": "instances_changed", "params": {}});
        assert!(peer_may_see_preview(&other, is_local), "other methods pass");
        let state = serde_json::json!({"jsonrpc": "2.0", "method": "preview_state", "params": {"id": "p", "key": "page", "value": 5}});
        assert!(!peer_may_see_preview(&state, is_local), "view state is not a peer's to follow");
        let delta = serde_json::json!({"jsonrpc": "2.0", "method": "answers_thread_delta", "params": {"session_id": "local", "stream_id": "s", "text": "reply so far"}});
        assert!(!peer_may_see_preview(&delta, is_local), "an Ask reply stream stays on this machine");
    }

    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message as TgMsg;

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    const HB: &str = r#"{"jsonrpc":"2.0","method":"heartbeat","params":{}}"#;
    /// Short period so a socket test sees several beats in well under a second.
    const FAST: Duration = Duration::from_millis(60);

    async fn serve(app: axum::Router) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    async fn connect(port: u16, path: &str) -> Client {
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}{path}")).await.unwrap().0
    }

    /// Next text frame, or `None` if nothing arrives within `within`.
    async fn next_text(ws: &mut Client, within: Duration) -> Option<String> {
        loop {
            match tokio::time::timeout(within, ws.next()).await {
                Ok(Some(Ok(TgMsg::Text(t)))) => return Some(t),
                Ok(Some(Ok(_))) => continue,
                _ => return None,
            }
        }
    }

    fn upgrade_route<F>(make: F) -> axum::Router
    where
        F: Fn(WebSocket) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Clone + Send + Sync + 'static,
    {
        axum::Router::new().route(
            "/s",
            axum::routing::get(move |ws: axum::extract::ws::WebSocketUpgrade| {
                let make = make.clone();
                async move { ws.on_upgrade(move |s| make(s)) }
            }),
        )
    }

    fn external_route(hb: Option<Duration>, transcript: std::path::PathBuf) -> axum::Router {
        upgrade_route(move |s| {
            let p = transcript.clone();
            Box::pin(async move {
                let _ = external_loop(s, p, hb, Duration::from_millis(20)).await;
            })
        })
    }

    #[tokio::test]
    async fn an_opted_in_chat_stream_gets_a_heartbeat_after_one_period() {
        let dir = tempfile::tempdir().unwrap();
        let port = serve(external_route(Some(FAST), dir.path().join("t.jsonl"))).await;
        let mut ws = connect(port, "/s").await;
        let started = std::time::Instant::now();
        let first = next_text(&mut ws, Duration::from_secs(2)).await;
        assert_eq!(first.as_deref(), Some(HB));
        assert!(started.elapsed() >= FAST - Duration::from_millis(15), "first beat is one period in, not at once");
        assert_eq!(next_text(&mut ws, Duration::from_secs(2)).await.as_deref(), Some(HB), "beats repeat");
    }

    #[tokio::test]
    async fn a_chat_stream_that_did_not_ask_gets_no_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let port = serve(external_route(None, dir.path().join("t.jsonl"))).await;
        let mut ws = connect(port, "/s").await;
        // Seven periods of FAST: every beat an opted-in stream would have got.
        let got = next_text(&mut ws, FAST * 7).await;
        assert_eq!(got, None, "no heartbeat without hb=1");
    }

    #[tokio::test]
    async fn heartbeats_continue_while_a_chat_waits_for_a_respawn() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let app = upgrade_route(move |s| {
            let state = state.clone();
            Box::pin(async move {
                let mut s = s;
                let mut beat = Beat::new(Some(FAST));
                // No session ever appears, so this waits out the whole poll.
                let _ = wait_for_respawn(&state, "gone", &mut s, &mut beat).await;
            })
        });
        let port = serve(app).await;
        let mut ws = connect(port, "/s").await;
        assert_eq!(next_text(&mut ws, Duration::from_secs(2)).await.as_deref(), Some(HB));
        assert_eq!(next_text(&mut ws, Duration::from_secs(2)).await.as_deref(), Some(HB));
    }

    #[tokio::test]
    async fn a_respawn_wait_without_hb_stays_silent() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let app = upgrade_route(move |s| {
            let state = state.clone();
            Box::pin(async move {
                let mut s = s;
                let mut beat = Beat::new(None);
                let _ = wait_for_respawn(&state, "gone", &mut s, &mut beat).await;
            })
        });
        let port = serve(app).await;
        let mut ws = connect(port, "/s").await;
        assert_eq!(next_text(&mut ws, FAST * 7).await, None);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_live_chat_pump_beats_only_when_asked() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let _child = crate::daemon::session_test_support::spawn_fake_session(&state.sessions, "sess-live").await;
        let session = state.sessions.get("sess-live").map(|s| s.clone()).unwrap();
        let mk = |hb: Option<Duration>| {
            let state = state.clone();
            let session = session.clone();
            upgrade_route(move |s| {
                let (state, session) = (state.clone(), session.clone());
                Box::pin(async move {
                    let _ = events_loop(s, state, "sess-live".into(), session, hb).await;
                })
            })
        };
        let mut on = connect(serve(mk(Some(FAST))).await, "/s").await;
        assert_eq!(next_text(&mut on, Duration::from_secs(2)).await.as_deref(), Some(HB));
        let mut off = connect(serve(mk(None)).await, "/s").await;
        assert_eq!(next_text(&mut off, FAST * 7).await, None);
    }

    #[tokio::test]
    async fn a_relayed_chat_stream_makes_its_own_heartbeats() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        // Paired but with no address, so the relay keeps retrying and sends the
        // pump nothing: any frame the client sees is the pump's own.
        let peer = PeerMachine {
            machine_id: "m-peer".into(),
            label: "Peer".into(),
            os: String::new(),
            iroh_id: None,
            direct_url: None,
            token: "t".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        };
        state.machines.get().unwrap().upsert_peer(peer.clone());
        let mk = |hb: Option<Duration>| {
            let state = state.clone();
            let peer = peer.clone();
            upgrade_route(move |s| {
                let (state, peer) = (state.clone(), peer.clone());
                Box::pin(async move {
                    let _ = relayed_loop(s, state, peer, "sess-rel".into(), hb).await;
                })
            })
        };
        let mut on = connect(serve(mk(Some(FAST))).await, "/s").await;
        assert_eq!(next_text(&mut on, Duration::from_secs(2)).await.as_deref(), Some(HB));
        let mut off = connect(serve(mk(None)).await, "/s").await;
        assert_eq!(next_text(&mut off, FAST * 7).await, None);
    }

    #[tokio::test]
    async fn a_ping_on_the_global_stream_is_answered_at_once() {
        use crate::daemon::device_registry::DeviceRegistry;
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_stt, port, handle) =
            crate::daemon::remote_server::spawn_on(state, dir.path().to_path_buf(), crate::daemon::rpc::Router::new(), 0);
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let mut ws = connect(port, &format!("/api/global/stream?token={token}")).await;
        let snapshot = next_text(&mut ws, Duration::from_secs(5)).await.expect("connect snapshot");
        assert!(snapshot.contains("instances_changed"), "{snapshot}");
        ws.send(TgMsg::Text(r#"{"jsonrpc":"2.0","method":"ping"}"#.into())).await.unwrap();
        // The periodic beat is 15s away, so a frame inside 3s answers the ping.
        let got = next_text(&mut ws, Duration::from_secs(3)).await;
        assert_eq!(got.as_deref(), Some(HB));
        handle.kill();
    }

    #[test]
    fn only_an_explicit_hb_one_turns_chat_heartbeats_on() {
        assert_eq!(chat_heartbeat_period(Some("1")), Some(GLOBAL_HEARTBEAT_INTERVAL));
        for off in [None, Some(""), Some("0"), Some("true"), Some("11")] {
            assert_eq!(chat_heartbeat_period(off), None, "{off:?}");
        }
    }

    #[test]
    fn the_stream_query_reads_hb_and_defaults_it_off() {
        use crate::daemon::remote_handlers::StreamQuery;
        let parse = |q: &str| {
            axum::extract::Query::<StreamQuery>::try_from_uri(&format!("/x?{q}").parse().unwrap()).unwrap().0
        };
        assert_eq!(parse("token=t&hb=1").hb.as_deref(), Some("1"));
        assert_eq!(parse("token=t").hb, None);
        assert_eq!(parse("token=t&hb=1").token, "t");
    }

    #[test]
    fn ping_is_recognised_and_nothing_else_is() {
        assert!(is_ping(r#"{"jsonrpc":"2.0","method":"ping"}"#));
        assert!(is_ping(r#"{"method":"ping","params":{}}"#));
        assert!(!is_ping(r#"{"jsonrpc":"2.0","method":"host_overlay","params":{"hosted":true}}"#));
        assert!(!is_ping(r#"{"method":"heartbeat"}"#));
        assert!(!is_ping("ping"));
        assert!(!is_ping("not json {"));
        assert!(!is_ping(r#"{"method":42}"#));
        // The two inbound methods never read as each other.
        assert_eq!(parse_host_overlay(r#"{"jsonrpc":"2.0","method":"ping"}"#), None);
        assert_eq!(parse_host_overlay(r#"{"method":"host_overlay","params":{"hosted":true}}"#), Some(true));
    }

    #[test]
    fn a_lagged_global_receive_resends_the_instances_snapshot() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (tx, mut rx) = tokio::sync::broadcast::channel::<serde_json::Value>(2);
        for i in 0..5 {
            tx.send(serde_json::json!({"method": "question_request", "params": {"n": i}})).unwrap();
        }
        let recv = rx.try_recv();
        assert!(matches!(recv, Err(tokio::sync::broadcast::error::TryRecvError::Lagged(3))), "{recv:?}");
        let step = global_step(&state, true, Err(RecvError::Lagged(3)));
        let GlobalStep::Send(txt) = step else { panic!("a lag must resync, got {step:?}") };
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        assert_eq!(v["method"], "instances_changed");
        assert!(v["params"]["instances"].is_array());
        assert_eq!(txt, instances_changed_frame(&state, true), "the same snapshot a fresh connect gets");
    }

    #[test]
    fn global_step_still_forwards_stops_and_skips_as_before() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ok = serde_json::json!({"jsonrpc": "2.0", "method": "refresh_requested", "params": {}});
        assert_eq!(global_step(&state, true, Ok(ok.clone())), GlobalStep::Send(ok.to_string()));
        assert_eq!(global_step(&state, true, Err(RecvError::Closed)), GlobalStep::Stop);
        let stale = serde_json::json!({"method": "turn_sound", "params": {"fired_at_ms": 1}});
        assert_eq!(global_step(&state, true, Ok(stale)), GlobalStep::Skip);
        let preview_state = serde_json::json!({"method": "preview_state", "params": {}});
        assert_eq!(global_step(&state, false, Ok(preview_state)), GlobalStep::Skip, "a peer never sees view state");
    }

    #[test]
    fn the_remote_ws_log_lines_read_exactly() {
        assert_eq!(open_line("dev-1", "phone", None, true), "[remote-ws] dev=dev-1 kind=phone global open");
        assert_eq!(
            open_line("dev-1", "peer", Some("1a2b3c4d-9999"), true),
            "[remote-ws] dev=dev-1 kind=peer chat 1a2b3c4d open hb=true"
        );
        assert_eq!(
            open_line("dev-1", "phone", Some("1a2b3c4d"), false),
            "[remote-ws] dev=dev-1 kind=phone chat 1a2b3c4d open hb=false"
        );
        let s = Duration::from_secs;
        assert_eq!(
            close_line("dev-1", "phone", None, s(123), CloseCause::ClientClosed),
            "[remote-ws] dev=dev-1 kind=phone global closed after 123s: client closed"
        );
        assert_eq!(
            close_line("dev-1", "phone", Some("1a2b3c4d-9999"), s(45), CloseCause::SendFailed),
            "[remote-ws] dev=dev-1 kind=phone chat 1a2b3c4d closed after 45s: send failed"
        );
        assert!(close_line("d", "phone", None, Duration::from_millis(900), CloseCause::NotifierClosed).contains("after 0s: notifier closed"));
        assert!(close_line("d", "phone", Some("abc"), s(1), CloseCause::SessionEnded).contains("chat abc closed after 1s: session ended"));
    }

    #[test]
    fn instances_changed_frame_matches_notifier_shape() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let frame = instances_changed_frame(&state, true);
        let v: serde_json::Value = serde_json::from_str(&frame).expect("valid json frame");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "instances_changed");
        assert!(v["params"]["instances"].is_array(), "params.instances should be an array: {v}");
        assert_eq!(v["params"]["instances"].as_array().unwrap().len(), 0);
    }
}
