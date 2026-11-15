// Whether the current mode asks Conductor to stay quiet (`mute_conductor`), for the
// one sound the webview makes itself: the OS notification for a missed scheduled
// item. The turn sound and the phone push are muted in the daemon
// (`daemon::notify_gate`), which the webview never sees.
//
// The daemon owns the mode (`daemon::modes`). This keeps a cached flag: seeded from
// `get_mode` at startup, then kept current by the `mode-changed` event.

import { invoke } from "./ipc";
import { getTransport } from "./transport";

export interface ModeView {
  mode?: string | null;
  flags?: string[];
  until?: string | null;
}

let muted = false;
let started = false;

/** True while a mode that carries `mute_conductor` is on and its end time has not passed. */
export function isConductorMuted(): boolean {
  return muted;
}

/** An unparseable end time counts as passed, as in the daemon (`ModeState::is_expired`). */
export function applyMode(view: ModeView | null | undefined): void {
  if (!view?.mode || !Array.isArray(view.flags) || !view.flags.includes("mute_conductor")) {
    muted = false;
    return;
  }
  const until = view.until ? Date.parse(view.until) : null;
  muted = until === null || (Number.isFinite(until) && until > Date.now());
}

/** Seeds the flag and follows the daemon. Safe to call twice. */
export function initModeMute(): void {
  if (started) return;
  started = true;
  void getTransport().listen<ModeView>("mode-changed", (v) => applyMode(v));
  invoke<ModeView>("get_mode").then(applyMode, (err) => console.warn("[mode] get_mode failed", err));
}

/** For tests: forgets the cached flag and the one-shot start. */
export function resetModeMuteForTest(): void {
  muted = false;
  started = false;
}
