import { render } from "lit-html";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import type { PreviewMeta } from "../../types/ipc.generated";
import { PREVIEW_OPEN_EVENT } from "../../shared/chat/chat-preview-card";
import { DRAFT_OPEN_EVENT } from "../../shared/chat/chat-draft-card";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./sessions-mobile.css";
import "./project-rail.css";
import "./changes-rail.css";
import "./session-list.css";
import "./session-row-portrait.css";
import "./rate-limit-banner.css";
import "./session-ctx-menu.css";
import "./session-avatar.css";
import "./session-statusbar.css";
import "./session-statusbar-images.css";
import "./git-card.css";
import "./overflow-panel.css";
import "./project-picker.css";
import "./worktree-picker.css";
import "./model-effort-modal.css";
import "./model-effort-slider.css";
import "./new-project-modal.css";
import "./preview-panel.css";
import { startNewSession, loadAndRestorePendingSession, loadAndRestoreParkedDrafts } from "./pending-flow";
import { selectSession, updateHeaderAvatarStatus } from "./active-session";
import { state, resetState } from "./state";
import { initThinkingBar, updateThinkingBar } from "./session-thinking-bar";
import { sessionSubtitle } from "./sessions-helpers";
import { refreshSessions, closeCtxMenu } from "./sidebar";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import { getTransport } from "../../shared/transport";
import { closeViewMoreMenu } from "./view-more-menu";
import { initMobileKeyboard } from "../../shared/mobile-keyboard";
import {
  getSelectedSessionId,
  reopenPendingPrompt,
} from "./permission-modal";
import { reopenAnsweredPrompt } from "./permission-modal/resurface";
import { showToast } from "../../shared/toast";
import {
  setPaneRef,
  consumePendingOpenPicker,
} from "./session-controls";
import {
  wireRateLimitBanner,
  wireDaemonStatusListeners,
  wireInstancesChangedListener,
  wireChatRecoveryHeartbeat,
  reconcileEndedSessions,
} from "./sessions-wiring";
import {
  wirePreviewPanel,
  wireOverflowMenu,
  wireKeyboardShortcuts,
  wireStaticListeners,
  wireDocumentListeners,
} from "./sessions-dom-wiring";
import { armSetupStallTimer, disarmSetupStallTimer, initialLoadAndRestore } from "./sessions-initial-load";
import { setInstancesPollTimer, setChatHeartbeatDispose, teardownState } from "./sessions-teardown";
export {
  queueHistoryResume,
  queueSessionSelect,
  queueNewChat,
  triggerNewSessionGlobal,
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";

/** Session ids for which we have already called ensureSessionCharacter this
 * runtime. Prevents redundant IPC chatter on every instances-changed event.
 * Cleared on unmount so a fresh mount re-ensures any sessions that appeared
 * while the view was hidden. */
const _ensuredSessionIds = new Set<string>();

// The wire* listener-setup functions live in sessions-wiring.ts, the
// cold-start sequence (setup indicator, stall timer, initial fetch, restore)
// lives in sessions-initial-load.ts, and the shared teardown between this
// view's two entry points lives in sessions-teardown.ts (one job per file);
// renderSessionsView below is the ordered composition of those plus whatever
// genuinely can't be pulled out (the two listener locals below and the final
// teardown closure, which reach into this mount's own DOM references).

export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  // Reset state on each mount; bump mountId so any pending async work from
  // a prior mount sees a stale id and bails.
  const myMount = resetState();
  _ensuredSessionIds.clear();
  loadAndRestorePendingSession();
  loadAndRestoreParkedDrafts();

  render(template(), root);

  const view = root.querySelector<HTMLElement>(".view-sessions");
  const listEl = root.querySelector<HTMLElement>("#sessions-list");
  const pane = root.querySelector<HTMLElement>("#session-pane");
  const newBtn = root.querySelector<HTMLButtonElement>("#newSessionBtn");

  if (!view || !listEl || !pane) {
    console.error("[sessions] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  setPaneRef(pane);
  let previewController = wirePreviewPanel(root, pane);
  initThinkingBar(pane);
  const teardownMobileKeyboard = initMobileKeyboard(view);

  // Click a question card in the transcript to reopen it. A still-pending one
  // (gated on `.tool-qa-a--pending`) puts the real, answerable card back up;
  // an already-resolved one pops a read-only replay instead (todo 755) - the
  // question and whichever answer was given, dismissable, no submit control.
  pane.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".msg.question-card");
    if (!card) return;
    const sid = getSelectedSessionId();
    if (!sid) return;
    if (card.querySelector(".tool-qa-a--pending")) {
      void (async () => {
        if (await reopenPendingPrompt(sid, card.dataset.questionId)) return;
        showToast("This question can no longer be reopened.");
      })();
      return;
    }
    if (!reopenAnsweredPrompt(card.dataset.questionId)) {
      showToast("This question can no longer be reopened.");
    }
  });

  // ⤢ on a show_preview card: resolve its slug to the daemon's snapshot id and
  // hand it to the rail. Announced on `window` by the card's click handler so
  // shared/chat never has to reach into this view.
  const onPreviewOpen = (e: Event): void => {
    const slug = (e as CustomEvent<{ slug?: string }>).detail?.slug ?? "";
    void (async () => {
      let id: string | undefined;
      try {
        const all = await invoke<PreviewMeta[]>("list_previews");
        // Newest match wins: a same-slug re-push replaces in place, but a
        // stale entry can still be listed while the fresh one is written.
        id = (Array.isArray(all) ? all : []).filter((m) => m.slug === slug).pop()?.id;
      } catch (err) {
        console.error("[sessions] could not resolve preview slug", err);
      }
      previewController?.open(id);
    })();
  };
  window.addEventListener(PREVIEW_OPEN_EVENT, onPreviewOpen);

  // ⤴ on an inline draft card: hand the id to the FAB's Drafts panel, which
  // owns editing. Announced on `window` for the same reason the preview card
  // does it - shared/chat must not import this view.
  const onDraftOpen = (e: Event): void => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id ?? "";
    if (id) state.fabDial?.openDraft(id);
  };
  window.addEventListener(DRAFT_OPEN_EVENT, onDraftOpen);

  const teardownUsageDials = wireRateLimitBanner(root, listEl, myMount);

  if (consumePendingOpenPicker()) {
    void startNewSession(pane);
  }

  const teardownOverflowMenu = await wireOverflowMenu(root, previewController);
  const teardownKeyboardShortcuts = wireKeyboardShortcuts(listEl);

  await initialLoadAndRestore(pane, listEl, myMount);

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  const teardownDaemonStatusListeners = await wireDaemonStatusListeners(
    ev, listEl, pane, myMount, armSetupStallTimer, disarmSetupStallTimer,
  );
  setInstancesPollTimer(await wireInstancesChangedListener(ev, listEl, pane, myMount, _ensuredSessionIds));
  setChatHeartbeatDispose(wireChatRecoveryHeartbeat(myMount));

  wireStaticListeners(root, view, pane, listEl, newBtn);

  let unlistenDragEnter: (() => void) | null = null;
  let unlistenDragLeave: (() => void) | null = null;
  let unlistenFileDrop: (() => void) | null = null;
  void (async () => {
    if (!ev?.listen) return;
    [unlistenDragEnter, unlistenDragLeave, unlistenFileDrop] = await Promise.all([
      ev.listen("tauri://drag-enter", () => { view.classList.add("drag-over"); }),
      ev.listen("tauri://drag-leave", () => { view.classList.remove("drag-over"); }),
      ev.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
        view.classList.remove("drag-over");
        if (!state.composer || !e.payload.paths.length) return;
        void (async (composer, paths) => {
          for (const path of paths) await composer.attachFromPath(path);
        })(state.composer, e.payload.paths);
      }),
    ]);
  })();

  const teardownDocumentListeners = wireDocumentListeners(pane, listEl, myMount);

  return () => {
    teardownDocumentListeners();
    if (unlistenDragEnter) { try { unlistenDragEnter(); } catch { /* ignore */ } unlistenDragEnter = null; }
    if (unlistenDragLeave) { try { unlistenDragLeave(); } catch { /* ignore */ } unlistenDragLeave = null; }
    if (unlistenFileDrop) { try { unlistenFileDrop(); } catch { /* ignore */ } unlistenFileDrop = null; }
    view.classList.remove("drag-over");
    teardownKeyboardShortcuts();
    closeCtxMenu();
    closeViewMoreMenu();
    teardownOverflowMenu();
    teardownDaemonStatusListeners();
    teardownMobileKeyboard();
    window.removeEventListener(PREVIEW_OPEN_EVENT, onPreviewOpen);
    window.removeEventListener(DRAFT_OPEN_EVENT, onDraftOpen);
    previewController?.destroy();
    previewController = null;
    state.previewController = null;
    disarmSetupStallTimer();
    teardownUsageDials?.();
    teardownState();
  };
}

/**
 * Detached-window entry point. Renders ONLY the chat pane for `sessionId`
 * (no sidebar, no header). Called from main.ts when the URL hash starts
 * with `#detached?session=...`. Reuses the same selectSession internals
 * for renderer + composer wiring.
 *
 * Returns a teardown closure that detaches the renderer.
 */
export async function renderDetachedSession(
  root: HTMLElement,
  sessionId: string,
): Promise<() => void> {
  const myMount = resetState();

  // Solo chat layout: just the .session-pane, no sidebar, no header burger.
  render(detachedTemplate(sessionId), root);

  const pane = root.querySelector<HTMLElement>("#session-pane");
  if (!pane) {
    console.error("[sessions] detached template missing #session-pane");
    return () => { /* no-op */ };
  }
  // Main window's `renderSessionsView` does this too (see below) - without it
  // `updateThinkingBar()` no-ops forever (its `_pane` stays null), so the
  // pause button/held-messages "Send Now" bar never appears in this window
  // (Jarvis's only in-app surface - see jarvis-kebab-menu.ts's header note).
  initThinkingBar(pane);

  // We need state.sessions populated so selectSession can find the entry.
  await refreshSessions();
  if (state.mountId !== myMount) return () => { /* superseded */ };

  // Subscribe to instances-changed so the meta line refreshes if the
  // registry kind/busy/pid changes (e.g. takeover). Routed through the
  // transport seam so this also runs on the remote (phone) client.
  state.unlistenInstances = await getTransport().listen("instances-changed", async () => {
    if (state.mountId !== myMount) return;
    // Same ended/vanished diff as the main sessions view's handler (see
    // reconcileEndedSessions) - this detached window has its own event-store
    // singleton (separate webview), so it must reclaim its own cache entry
    // independently.
    const previousIds = new Set(state.sessions.map((s) => s.session_id));
    const refreshed = await refreshSessions();
    if (state.mountId !== myMount) return;
    reconcileEndedSessions(previousIds, refreshed);
    // Live-update the pane header title when the session name resolves, and
    // recolour the header avatar's status ring.
    if (state.selectedId) {
      const sess = state.sessions.find((s) => s.session_id === state.selectedId);
      if (sess) {
        const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
        if (titleEl) {
          const newTitle = sessionSubtitle(sess);
          if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
        }
        updateHeaderAvatarStatus(pane, sess);
        pane.classList.toggle("is-rate-limited", isBlocked(sess));
        state.composer?.refreshBlockedState();
      }
    }
    // Same busy-flag refresh the main window's instances-changed handler does
    // (sessions-wiring.ts) - without it, the pause button/Send-Now chip never
    // reacts once Jarvis starts or stops a turn after this initial mount.
    updateThinkingBar();
  });

  await selectSession(sessionId, pane);
  setChatHeartbeatDispose(wireChatRecoveryHeartbeat(myMount));

  return teardownState;
}
