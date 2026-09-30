// View-level "sleep/shutdown-when-done" protocol UI glue.
//
// The protocol is GLOBAL (one armed action across all sessions), owned by the
// daemon. This module is the thin frontend layer:
//   - hydrate the latest ProtocolState on view mount (get_when_done_state),
//   - keep it fresh via the `when-done-state` Tauri event (also ticks 1/s
//     while counting down),
//   - run a local 1s decrement between events for smooth countdowns, always
//     reconciling to each event's authoritative value,
//   - arm / cancel via IPC,
//   - render the menu items + status/countdown markup the overflow menu shows.
//
// State lives on the central sessions singleton (state.whenDone). Consumers
// register a callback via subscribeWhenDone to re-render when it changes.

import { invoke } from "../../shared/ipc";
import type { ProtocolState, TerminalAction } from "../../types/ipc.generated";
import { state } from "./state";
import { visibleInterval } from "../../shared/visible-interval";

type Listener = (s: ProtocolState | null) => void;

const listeners = new Set<Listener>();
let unlistenEvent: (() => void) | null = null;
let smoothTimer: (() => void) | null = null;

function emit(): void {
  for (const l of listeners) {
    try { l(state.whenDone); } catch (err) { console.warn("[when-done] listener threw", err); }
  }
}

function isArmed(s: ProtocolState | null): boolean {
  return !!s && s.phase !== "disarmed";
}

function isCounting(s: ProtocolState | null): boolean {
  return !!s && s.phase === "countingDown";
}

/** Apply a fresh authoritative ProtocolState, restart the smoothing timer as
 *  needed, and notify subscribers. */
function apply(next: ProtocolState | null): void {
  state.whenDone = next;
  if (isCounting(next)) {
    startSmoothing();
  } else {
    stopSmoothing();
  }
  emit();
}

/** Between server ticks, decrement the local countdown once per second so the
 *  chip reads down smoothly. Each real `when-done-state` event reconciles the
 *  value back to the server's truth via apply(). */
function startSmoothing(): void {
  if (smoothTimer !== null) return;
  smoothTimer = visibleInterval(() => {
    const s = state.whenDone;
    if (!isCounting(s) || s == null || s.countdown_remaining_secs == null) {
      stopSmoothing();
      return;
    }
    const nextSecs = Math.max(0, s.countdown_remaining_secs - 1);
    state.whenDone = { ...s, countdown_remaining_secs: nextSecs };
    emit();
  }, 1000);
}

function stopSmoothing(): void {
  if (smoothTimer !== null) {
    smoothTimer();
    smoothTimer = null;
  }
}

/** Subscribe to protocol-state changes. Returns an unsubscribe fn. */
export function subscribeWhenDone(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current armed action, or null. */
export function whenDoneAction(): TerminalAction | null {
  return state.whenDone?.action ?? null;
}

/** True when any protocol is armed (watching / closing / countingDown / firing). */
export function whenDoneArmed(): boolean {
  return isArmed(state.whenDone);
}

const ACTION_LABEL: Record<TerminalAction, string> = {
  sleep: "Sleep",
  shutdown: "Shutdown",
};

/**
 * Hydrate from the daemon and subscribe to live updates. Safe to call on every
 * mount: re-subscribes the event listener (the previous one is dropped first).
 * Returns a teardown fn that unsubscribes the event + stops the smoothing timer.
 */
export async function initWhenDone(): Promise<() => void> {
  // Drop any prior event listener (e.g. previous mount) before re-subscribing.
  if (unlistenEvent) { try { unlistenEvent(); } catch { /* ignore */ } unlistenEvent = null; }

  try {
    const s = await invoke<ProtocolState>("get_when_done_state");
    apply(s);
  } catch (err) {
    console.warn("[when-done] get_when_done_state failed", err);
  }

  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    try {
      unlistenEvent = await ev.listen<ProtocolState>("when-done-state", (e) => {
        apply(e.payload);
      });
    } catch (err) {
      console.warn("[when-done] listen(when-done-state) failed", err);
    }
  }

  return () => {
    if (unlistenEvent) { try { unlistenEvent(); } catch { /* ignore */ } unlistenEvent = null; }
    stopSmoothing();
  };
}

/**
 * Arm the given action, or cancel if that same action is already armed
 * (toggle). Arming while the OTHER action is armed switches to the new one
 * (the daemon aborts the previous task on a fresh arm).
 */
export async function armOrToggleWhenDone(action: TerminalAction): Promise<void> {
  const current = state.whenDone;
  const sameArmed = isArmed(current) && current?.action === action;
  try {
    const next = sameArmed
      ? await invoke<ProtocolState>("cancel_when_done")
      : await invoke<ProtocolState>("arm_when_done", { action });
    apply(next);
  } catch (err) {
    console.error("[when-done] arm/cancel failed", err);
    alert(`Failed to ${sameArmed ? "cancel" : "arm"} ${ACTION_LABEL[action]}-when-done: ${err}`);
  }
}

/** Cancel any armed protocol. No-op-safe if already disarmed. */
export async function cancelWhenDone(): Promise<void> {
  try {
    const next = await invoke<ProtocolState>("cancel_when_done");
    apply(next);
  } catch (err) {
    console.error("[when-done] cancel failed", err);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the two toggle items + (when armed) a status/countdown row, as an
 * HTML string for injection into the overflow menu. Buttons carry
 * data-when-done="sleep|shutdown" and the cancel control data-when-done-cancel.
 */
export function whenDoneMenuHtml(): string {
  const s = state.whenDone;
  const action = s?.action ?? null;
  const sleepOn = isArmed(s) && action === "sleep";
  const shutdownOn = isArmed(s) && action === "shutdown";

  const items: string[] = [];
  items.push(
    `<button class="smore-item${sleepOn ? " is-on" : ""}" data-when-done="sleep">` +
    `<i class="ph ph-moon-stars"></i>Sleep when done` +
    `${sleepOn ? '<span class="smore-check-dot"></span>' : ""}</button>`,
  );
  items.push(
    `<button class="smore-item${shutdownOn ? " is-on" : ""}" data-when-done="shutdown">` +
    `<i class="ph ph-power"></i>Shutdown when done` +
    `${shutdownOn ? '<span class="smore-check-dot"></span>' : ""}</button>`,
  );

  if (isArmed(s) && s && action) {
    items.push(`<div class="smore-sep"></div>`);
    items.push(whenDoneStatusHtml(s, action));
  }

  return items.join("");
}

function whenDoneStatusHtml(s: ProtocolState, action: TerminalAction): string {
  const label = ACTION_LABEL[action];
  let text: string;
  if (s.phase === "countingDown" && s.countdown_remaining_secs != null) {
    text = `${esc(label)} in ${s.countdown_remaining_secs}s`;
  } else if (s.phase === "firing") {
    text = `${esc(label)} now...`;
  } else {
    const n = s.waiting_on.length;
    const sess = n === 1 ? "session" : "sessions";
    text = n > 0
      ? `${esc(label)} when done: armed (waiting on ${n} ${sess})`
      : `${esc(label)} when done: armed`;
  }
  return (
    `<div class="when-done-chip">` +
    `<span class="when-done-chip-text">${text}</span>` +
    `<button class="when-done-cancel" data-when-done-cancel><i class="ph ph-x"></i>Cancel</button>` +
    `</div>`
  );
}
