// Take-over-button handler extracted from active-session.ts's selectSession
// (ai_todo 468): the readOnly pane's "Take Over" flow grew past a simple
// inline closure. Pure move, no behavior change.

import { invoke } from "../../shared/ipc";
import { sessionEvents } from "../../shared/chat/event-store";
import { askConfirm } from "../../shared/confirm";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import type { Instance } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { renderSidebar, refreshSessions } from "./sidebar";
import { rekeyRetainedChat } from "./chat-pane-cache";
import { mountComposer } from "./active-session-composer";

/** Confirm/account-modal -> `takeover_manual` invoke -> reconcile this pane
 * onto the new session id in place (no teardown/rebuild, no sidebar jump).
 * The watched-transcript id and header avatar callbacks are injected since
 * both live in active-session.ts and importing back would cycle. */
export async function handleTakeoverClick(
  pane: HTMLElement,
  sess: Instance,
  takeoverBtn: HTMLButtonElement,
  callbacks: {
    getWatchedId: () => string | null;
    setWatchedId: (id: string | null) => void;
    updateHeaderAvatarStatus: (pane: HTMLElement, sess: Instance) => void;
  },
): Promise<void> {
  const ok = await askConfirm(
    `Take over manual session? This kills the external claude process (pid ${sess.pid}) so this app can resume the session.`,
    { confirmLabel: "Take over" },
  );
  if (!ok) return;
  // The manual session was started outside this app, so there is no
  // account already on record for it - ask which one future turns
  // (--resume calls) should run under, instead of silently falling back
  // to the app's default account.
  const accountId = await openChangeAccountModal({ currentId: null, title: "Take over as which account?" });
  if (!accountId) return;
  const originalId = sess.session_id;
  takeoverBtn.disabled = true;
  state.takeoverInFlightIds.add(originalId);
  try {
    const newId = await invoke<string>("takeover_manual", { manualPid: sess.pid, accountId });
    if (!newId) return;
    await refreshSessions();
    const updatedSess = state.sessions.find((s) => s.session_id === newId);
    // Bail without forcing a jump if the user navigated away mid-takeover,
    // or the promoted entry is missing - refreshSessions/renderSidebar
    // below already reflect the promotion either way.
    if (!updatedSess || state.selectedId !== originalId) return;

    // Stay on this same pane (no teardown/rebuild, no sidebar jump).
    // newId can differ from originalId - takeover.rs prefers the
    // on-disk session file over a possibly-stale registry entry - so
    // repoint identity silently instead of switching the visible chat.
    if (newId !== originalId) {
      setActiveSession(newId);
      await rekeyRetainedChat(originalId, newId);
      if (callbacks.getWatchedId() === originalId) {
        void invoke<void>("unwatch_session_transcript", { sessionId: originalId }).catch(() => {});
        sessionEvents.stopWatchListener(originalId);
        callbacks.setWatchedId(newId);
        void invoke<void>("watch_session_transcript", { sessionId: newId, cwd: updatedSess.cwd ?? null })
          .then(() => sessionEvents.ensureWatchListener(newId))
          .catch(() => {});
      }
    }
    // rekeyRetainedChat above awaits; bail if the user left this pane
    // meanwhile instead of mutating a pane that's no longer on screen.
    if (state.selectedId !== newId) return;
    pane.querySelector(".readonly-banner")?.remove();
    mountComposer(pane, updatedSess, newId, false);
    state.statusbar?.setReadOnlyEffort(false);
    callbacks.updateHeaderAvatarStatus(pane, updatedSess);
    const root = document.querySelector<HTMLElement>(".view-sessions");
    const listEl = root?.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  } catch (err) {
    console.error("[sessions] takeover_manual failed", err);
    alert(`Takeover failed: ${err}`);
  } finally {
    state.takeoverInFlightIds.delete(originalId);
    takeoverBtn.disabled = false;
  }
}
