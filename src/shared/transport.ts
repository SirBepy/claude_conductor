// Single seam between the frontend and the daemon backend.
//
// Desktop webview -> TauriTransport (Tauri `invoke` + Tauri events).
// Browser PWA (phone) -> HttpTransport (REST + WebSocket to the daemon's
// remote-access server), selected at boot in getTransport() by the absence of
// window.__TAURI__.
//
// All request/response goes through `call`; all event streaming through
// `listen`. Keeping both behind this interface lets the same UI run in the
// Tauri webview and in a remote browser without the call sites knowing which.
//
// The `Window.__TAURI__` shape is declared ambiently in ./ipc, so this module
// can reference it without an import.

import { HttpTransport } from "./http-transport";

export type Unlisten = () => void;

/** Per-call hints. `background` marks a read nobody is waiting on (a timer or
 *  resume refresh): the phone's "Waiting for your PC" strip ignores it however
 *  slow it is. Only HttpTransport reads it. */
export interface CallOptions {
  background?: boolean;
}

export interface Transport {
  call<T>(command: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  /** Subscribe to a backend event channel. The callback receives the payload
   *  directly (the Tauri `{ payload }` envelope is unwrapped at this boundary). */
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
}

class TauriTransport implements Transport {
  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const core = window.__TAURI__?.core;
    if (!core?.invoke) {
      throw new Error(
        "Tauri runtime not available. Are you running via `cargo tauri dev` or a packaged build?",
      );
    }
    return core.invoke<T>(command, args);
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return () => {};
    return ev.listen<T>(event, (e) => cb(e.payload));
  }
}

let active: Transport | null = null;

/**
 * The active transport, resolved once at boot: TauriTransport inside the Tauri
 * webview (window.__TAURI__ present), HttpTransport in a plain browser (the
 * served PWA). The choice is cached for the process lifetime.
 */
export function getTransport(): Transport {
  if (!active) {
    active = isTauri() ? new TauriTransport() : new HttpTransport();
  }
  return active;
}

/** True inside the Tauri desktop webview (the runtime global is injected by the
 *  webview, never present in a plain browser). The single source of truth for
 *  "am I the desktop app vs the remote phone browser" - ai_todo 105. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

/** Inverse of {@link isTauri}: true in the remote (phone) browser PWA. */
export function isRemote(): boolean {
  return !isTauri();
}

/** Test-only: clear the cached transport so a test can re-resolve it. */
export function resetTransportForTests(): void {
  active = null;
}
