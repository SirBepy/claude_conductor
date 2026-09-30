// Shared teardown for the Sessions view's two entry points
// (renderSessionsView's main mount and renderDetachedSession), split out of
// sessions.ts (todo 937). Owns the two dispose handles both entry points set
// while wiring the live-instances poll fallback and the chat recovery
// heartbeat, since exactly one of the two entry points is mounted per window.

import { unwatchCurrentExternalSession } from "./active-session";
import { setPaneRef } from "./session-controls";
import { initThinkingBar } from "./session-thinking-bar";
import { state, setActiveSession } from "./state";
import { backgroundRetainedChat, isRetainedRenderer } from "./chat-pane-cache";

/** Poll-fallback disposer for the lossy instances-changed broadcast (see the
 * visibleInterval at the listener registration site). Cleared in teardownState. */
let instancesPollTimer: (() => void) | null = null;

/** Dispose function for the chat live-channel recovery heartbeat (see
 * wireChatRecoveryHeartbeat). Shared by both entry points; cleared in
 * teardownState. */
let chatHeartbeatDispose: (() => void) | null = null;

export function setInstancesPollTimer(timer: (() => void) | null): void {
  instancesPollTimer = timer;
}

export function setChatHeartbeatDispose(dispose: (() => void) | null): void {
  chatHeartbeatDispose = dispose;
}

/**
 * Shared teardown: detach renderer/composer/statusbar, drop instance
 * listener, clear active session, drop the cached pane reference. Used by
 * both the main view and the detached-window entry.
 */
export function teardownState(): void {
  unwatchCurrentExternalSession();
  setPaneRef(null);
  initThinkingBar(null);
  if (state.unlistenInstances) {
    try { state.unlistenInstances(); } catch { /* ignore */ }
    state.unlistenInstances = null;
  }
  if (state.unlistenScheduled) {
    try { state.unlistenScheduled(); } catch { /* ignore */ }
    state.unlistenScheduled = null;
  }
  if (state.unlistenHeldDelivered) {
    try { state.unlistenHeldDelivered(); } catch { /* ignore */ }
    state.unlistenHeldDelivered = null;
  }
  if (instancesPollTimer !== null) {
    instancesPollTimer();
    instancesPollTimer = null;
  }
  if (chatHeartbeatDispose) {
    chatHeartbeatDispose();
    chatHeartbeatDispose = null;
  }
  // Leaving the Sessions view parks the open chat rather than tearing it down,
  // so coming back reopens it instantly. Non-retained renderers (pending pane)
  // still detach here.
  if (state.selectedId) backgroundRetainedChat(state.selectedId);
  if (state.renderer) {
    if (!isRetainedRenderer(state.renderer)) state.renderer.detach();
    state.renderer = null;
  }
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }
  state.composer?.destroy();
  state.composer = null;
  // The held-messages controller is a per-window singleton that otherwise
  // survives this teardown (its map/deferRetryTimer are meant to), but a
  // pending auto-rescue fuse (todo 926) is tied to the pane's own
  // interrupt()/getIsBusy() closures - safe to leave armed only while that
  // pane exists. Disarm rather than let it fire against a session whose
  // "current" busy state can no longer be read correctly.
  state.heldMessages?.cancelPendingRescue();
  setActiveSession(null);
}
