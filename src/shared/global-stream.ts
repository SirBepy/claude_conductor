// Global live-state stream (singleton), split out of http-transport.ts (ai_todo
// 298) so that file stays scoped to the `HttpTransport` class itself.
//
// One shared WebSocket to `/api/global/stream`, fanning daemon-wide
// notifier events out to every `listen()` caller instead of each call opening
// its own poll. This is the remote (browser) equivalent of the desktop's
// internal `subscribe_global` pipe link (see `daemon_link.rs`): the daemon's
// notifier emits snake_case JSON-RPC-shaped frames (`{jsonrpc, method,
// params}`); this table is the same snake_case -> kebab-case translation
// `daemon_link.rs` does app-side, restricted to the daemon events that have
// an actual remote frontend consumer today (found by grepping `listen(` /
// `.on(` call sites across src/).

import type { Transport } from "./transport";
import { remoteToken } from "./http-transport";
import { visibleInterval } from "./visible-interval";
import { markLiveDown, markLiveUp } from "./connection-state";

type GlobalCallback = (payload: unknown) => void;

const GLOBAL_EVENT_MAP: Record<string, string> = {
  instances_changed: "instances-changed",
  scheduled_items_changed: "scheduled-items-changed",
  scheduled_item_fired: "scheduled-item-fired",
  turn_sound: "turn-sound",
  held_messages_delivered: "held-messages-delivered",
  session_characters_changed: "session-characters-changed",
  characters_changed: "characters-changed",
  message_drafts_changed: "message-drafts-changed",
  user_todos_changed: "user-todos-changed",
  hidden_chats_changed: "hidden-chats-changed",
  // Same snake/kebab spelling, so this one is easy to mistake for already
  // wired up. Found by todo 946's own check (`tests/
  // notifier-event-registration-contract.test.mjs`): `preview-panel.ts` already
  // called `getTransport().listen("preview", ...)`, which reached the desktop
  // fine via `daemon_link/mod.rs`'s existing arm, but had no map entry, so the
  // phone's `HttpTransport.listen` silently no-op'd and the live push never
  // arrived there.
  preview: "preview",
};
export const GLOBAL_KEBAB_EVENTS = new Set(Object.values(GLOBAL_EVENT_MAP));

/** How stale (ms since the last inbound frame, heartbeat or otherwise) the
 *  global stream must be before the watchdog treats it as a zombie socket.
 *  Browsers never surface native WS ping/pong to JS, so `onclose` does not
 *  fire when the connection silently dies (e.g. after the phone's screen was
 *  off long enough for the OS to freeze it) - only a missed app-level
 *  heartbeat can detect that. */
const GLOBAL_STALE_MS = 10_000;
const GLOBAL_WATCHDOG_INTERVAL_MS = 5_000;
/** Degrade-path poll cadence, matching the interval the old per-listener poll
 *  used before this singleton existed. */
const GLOBAL_DEGRADE_POLL_MS = 3_500;

let globalWs: WebSocket | null = null;
let globalWsStopped = true;
let globalRetryDelay = 1000;
let globalLastFrameAt = 0;
const globalListeners = new Map<string, Set<GlobalCallback>>();
let globalWatchdogTimer: (() => void) | undefined;
let globalDegradePollTimer: (() => void) | undefined;
let globalDegradePollInFlight = false;
let globalReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let globalResumeUnwire: (() => void) | undefined;
/** The Transport instance that registered the currently-active global
 *  listeners. Only its `call()` can be used for the degrade-path poll (it
 *  updates `HttpTransport`'s `nonStreamable` bookkeeping) - one instance lives
 *  for the whole app lifetime in practice (`getTransport()` caches it), so
 *  this is set once on the first `ensureGlobalStream()` call and reused. */
let globalStreamOwner: Transport | null = null;

function fireGlobal(kebabEvent: string, payload: unknown): void {
  const cbs = globalListeners.get(kebabEvent);
  if (!cbs) return;
  for (const cb of cbs) cb(payload);
}

/** True once every registered global listener set has been fully unsubscribed
 *  from; the caller uses this to decide when to tear the singleton down. */
export function allGlobalListenersEmpty(): boolean {
  for (const set of globalListeners.values()) {
    if (set.size > 0) return false;
  }
  return true;
}

/** Register a callback for a global kebab-case event (must be one of
 *  {@link GLOBAL_KEBAB_EVENTS}). */
export function addGlobalListener(event: string, cb: GlobalCallback): void {
  const cbs = globalListeners.get(event) ?? new Set<GlobalCallback>();
  cbs.add(cb);
  globalListeners.set(event, cbs);
}

/** Unregister a previously-registered global listener. */
export function removeGlobalListener(event: string, cb: GlobalCallback): void {
  globalListeners.get(event)?.delete(cb);
}

/** Stops the degrade-path poll; called as soon as a fresh WS frame arrives
 *  (WS is the fast path, poll is only the fallback while it's down/stale). */
function stopGlobalDegradePoll(): void {
  if (globalDegradePollTimer) {
    globalDegradePollTimer();
    globalDegradePollTimer = undefined;
  }
}

/** Degrade path while the global WS is down or stale: re-poll `list_instances`
 *  at the pre-WS cadence and fan it out to the "instances-changed" listeners
 *  only - that is the one event with a documented safe poll substitute
 *  (the others have no equivalent single-RPC resync and simply go stale
 *  until the WS reconnects). */
// KEEP-RUNNING (todo 1008): this is the degrade path for the same global
// event stream that drives the taskbar/tray unread indicators and
// session-completion signals - those must keep working while the window is
// hidden, which is the whole point of a taskbar icon.
const DEGRADE_POLL_REASON =
  "feeds the taskbar/tray unread indicator and session-completion signals via instances-changed, which must keep working while the window is hidden";

function startGlobalDegradePoll(): void {
  if (globalDegradePollTimer) return;
  globalDegradePollTimer = visibleInterval(() => {
    if (globalDegradePollInFlight || !globalStreamOwner) return;
    const cbs = globalListeners.get("instances-changed");
    if (!cbs || cbs.size === 0) return;
    globalDegradePollInFlight = true;
    globalStreamOwner
      .call<unknown>("list_instances")
      .then(() => { fireGlobal("instances-changed", undefined); })
      .catch(() => { /* network blip - skip this tick */ })
      .finally(() => { globalDegradePollInFlight = false; });
  }, GLOBAL_DEGRADE_POLL_MS, { whileHidden: true, reason: DEGRADE_POLL_REASON });
}

// KEEP-RUNNING (todo 1008): same reasoning as its degrade-poll companion - a
// stuck detector while hidden means the tray/badge silently goes stale with
// no self-heal until the window is refocused.
const WATCHDOG_REASON =
  "detects a zombie global WebSocket so the degrade poll above (tray/badge unread + session-completion signals) can self-heal while the window is hidden";

function ensureGlobalWatchdog(): void {
  if (globalWatchdogTimer) return;
  globalWatchdogTimer = visibleInterval(() => {
    if (globalWsStopped) return;
    if (Date.now() - globalLastFrameAt > GLOBAL_STALE_MS) {
      // Stale: assume the socket is a zombie (half-open, no clean close).
      // Start degrading immediately and force-close so the existing
      // reconnect/backoff in onclose kicks in.
      markLiveDown();
      startGlobalDegradePoll();
      if (globalWs) {
        try { globalWs.close(); } catch { /* ignore */ }
      }
    }
  }, GLOBAL_WATCHDOG_INTERVAL_MS, { whileHidden: true, reason: WATCHDOG_REASON });
}

function connectGlobalStream(): void {
  if (globalWsStopped) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url =
    `${proto}://${location.host}/api/global/stream?token=${encodeURIComponent(remoteToken())}`;
  const ws = new WebSocket(url);
  globalWs = ws;
  ws.onmessage = (e: MessageEvent) => {
    globalLastFrameAt = Date.now();
    markLiveUp();
    stopGlobalDegradePoll();
    let frame: { method?: string; params?: unknown };
    try {
      frame = JSON.parse(e.data as string);
    } catch {
      return; // ignore non-JSON frames
    }
    if (!frame.method || frame.method === "heartbeat") return; // heartbeat: freshness signal only
    const kebab = GLOBAL_EVENT_MAP[frame.method];
    if (kebab) fireGlobal(kebab, frame.params);
  };
  ws.onopen = () => {
    globalRetryDelay = 1000;
    globalLastFrameAt = Date.now();
    markLiveUp();
    stopGlobalDegradePoll();
  };
  ws.onclose = () => {
    if (globalWs === ws) globalWs = null;
    if (globalWsStopped) return;
    // No live channel until the reconnect completes - degrade immediately
    // rather than waiting for the watchdog's next tick.
    markLiveDown();
    startGlobalDegradePoll();
    globalReconnectTimer = setTimeout(() => {
      globalReconnectTimer = undefined;
      connectGlobalStream();
    }, globalRetryDelay);
    globalRetryDelay = Math.min(globalRetryDelay * 2, 30_000);
  };
}

/** On resume (or the network coming back), a socket that has been silent past
 *  the stale window is dead even if `onclose` never fired, and a pending
 *  backoff retry may be up to 30s away. Both wait for nothing: reconnect now. */
export function reconnectGlobalStreamIfStale(): void {
  if (globalWsStopped) return;
  if (globalWs && Date.now() - globalLastFrameAt <= GLOBAL_STALE_MS) return;
  markLiveDown();
  startGlobalDegradePoll();
  globalRetryDelay = 1000;
  if (globalReconnectTimer) {
    clearTimeout(globalReconnectTimer);
    globalReconnectTimer = undefined;
  }
  const dead = globalWs;
  if (dead) {
    // Detach first: this socket's own onclose would schedule a second,
    // backed-off reconnect next to the immediate one below.
    dead.onclose = null;
    dead.onmessage = null;
    try { dead.close(); } catch { /* ignore */ }
  }
  globalWs = null;
  // Counts the fresh socket as live until the watchdog says otherwise, so a
  // visibilitychange and an `online` landing in the same tick dial once.
  globalLastFrameAt = Date.now();
  connectGlobalStream();
}

function wireResumeReconnect(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") reconnectGlobalStreamIfStale();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", reconnectGlobalStreamIfStale);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", reconnectGlobalStreamIfStale);
  };
}

/** Opens the singleton global WS (no-op if already open/connecting) and
 *  starts its watchdog. Safe to call on every `listen()` for a global event.
 *  `owner` is the calling `HttpTransport` instance, kept for the degrade
 *  poll's `call("list_instances")`. */
export function ensureGlobalStream(owner: Transport): void {
  globalStreamOwner = owner;
  if (typeof WebSocket === "undefined" || typeof location === "undefined") return; // node tests
  if (!globalWsStopped && globalWs) return; // already connecting/open
  globalWsStopped = false;
  globalLastFrameAt = Date.now();
  connectGlobalStream();
  ensureGlobalWatchdog();
  globalResumeUnwire ??= wireResumeReconnect();
}

/** Tears the singleton down when the last global listener unsubscribes,
 *  matching the per-session WS's cleanup semantics (its `unlisten` also
 *  closes the socket). */
export function teardownGlobalStream(): void {
  globalWsStopped = true;
  if (globalWatchdogTimer) { globalWatchdogTimer(); globalWatchdogTimer = undefined; }
  if (globalResumeUnwire) { globalResumeUnwire(); globalResumeUnwire = undefined; }
  if (globalReconnectTimer) { clearTimeout(globalReconnectTimer); globalReconnectTimer = undefined; }
  stopGlobalDegradePoll();
  if (globalWs) {
    try { globalWs.close(); } catch { /* ignore */ }
    globalWs = null;
  }
}
