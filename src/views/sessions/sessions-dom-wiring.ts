// DOM/UI wiring half of sessions-wiring.ts (ai_todo 463): click handlers,
// keyboard shortcuts, and document-level custom events. Event-transport
// wiring (daemon/instances listeners) stays in sessions-wiring.ts.

import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import { renderPreview, type PreviewController } from "./preview-panel";
import { mountMobilePager } from "./mobile-pager";
import { mountFabDial } from "./fab-dial";
import { initHeaderMerge } from "./mobile-header-merge";
import { startNewSession, launchNewSession, discardDraft, resumeDraft } from "./pending-flow";
import { discardComposerDraft, moveComposerDraft } from "../../shared/chat/composer";
import { selectSession } from "./active-session";
import { state, setActiveSession, clearLastSelectedSession } from "./state";
import { updateThinkingBar } from "./session-thinking-bar";
import { paneEmptyStateHtml } from "./sessions-helpers";
import { renderSidebar, openCtxMenu, openDraftCtxMenu } from "./sidebar";
import { initWhenDone, subscribeWhenDone } from "./when-done";
import {
  closeViewMoreMenu,
  refreshViewMoreIndicator,
  rerenderViewMenuProtocol,
  toggleViewMoreMenu,
} from "./view-more-menu";
import {
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";

function discardStuckPending(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  // No confirm() guard: native confirm routes through the dialog plugin, which
  // is blocked by the ACL in this window. The X is already explicit intent.
  void (async () => {
    const target = pending.realId ?? pending.placeholderId;
    try { await invoke<void>("cancel_turn", { sessionId: target }); } catch { /* best-effort */ }
    if (pending.realId) {
      try { await invoke<void>("clear_session", { sessionId: pending.realId }); } catch { /* best-effort */ }
    }
    discardDraft(pane);
    updateThinkingBar();
  })();
}

/** Docked HTML preview panel (ai_todo 138): a snapshot store rendered as a
 * right-rail sibling of the pane, scoped to whichever chat is active (see
 * state.ts's setActiveSession -> previewController.setSessionScope). */
export function wirePreviewPanel(root: HTMLElement, pane: HTMLElement): PreviewController | null {
  const previewRoot = root.querySelector<HTMLElement>("#preview-panel-host");
  const previewController: PreviewController | null =
    previewRoot ? renderPreview(previewRoot, { mode: "panel" }) : null;
  state.previewController = previewController;
  previewController?.setSessionScope(state.selectedId);
  // Phone pager over the same two panes (Joe, 2026-08-19). Mounted alongside
  // the rail because it drives the rail's tab; CSS keeps it off desktop.
  const tabbarHost = root.querySelector<HTMLElement>("#mobile-tabbar-host");
  const layout = root.querySelector<HTMLElement>(".sessions-layout");
  if (tabbarHost && layout && previewController) {
    mountMobilePager(tabbarHost, layout);
  }

  // Ask / Todos / Preview, summoned from the chat pane rather than docked
  // (Joe, 2026-08-24). Owns its own host element because active-session.ts
  // rewrites the pane's innerHTML on every switch.
  state.fabDial = mountFabDial(pane, {
    onDraft: (text) => {
      state.composer?.setDraftText(text, false);
    },
    preview: previewController,
  });
  state.fabDial.setSessionScope(state.selectedId, null);
  initHeaderMerge(root);
  state.launchNewChatCallback = (project, config) => { void launchNewSession(pane, project, config); };
  // Test seam (ai_todo 402): create a draft directly, skipping pickProject and
  // the model modal, so the view-harness can drive discardDraft's scheduled-
  // item cancellation without simulating the whole new-chat UI chain.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__launchDraftForTest = state.launchNewChatCallback;
  }
  return previewController;
}

/** Wires the "more options" overflow button, the preview-panel toggle button
 * inside it, and the sleep/shutdown-when-done protocol subscription that
 * keeps the overflow menu's indicator dot + protocol section live. Returns a
 * dispose function for the whenDone subscription/listener. */
export async function wireOverflowMenu(
  root: HTMLElement,
  previewController: PreviewController | null,
): Promise<() => void> {
  const viewMoreBtn = root.querySelector<HTMLButtonElement>("#viewMoreBtn");
  const onViewMoreClick = (e: MouseEvent) => {
    e.stopPropagation();
    toggleViewMoreMenu(viewMoreBtn!);
  };
  if (viewMoreBtn) {
    viewMoreBtn.addEventListener("click", onViewMoreClick);
  }

  const previewToggleBtn = root.querySelector<HTMLButtonElement>("#previewToggleBtn");
  if (previewToggleBtn) {
    previewToggleBtn.addEventListener("click", () => {
      closeViewMoreMenu();
      previewController?.toggle();
    });
  }

  // Hydrate + subscribe to the global sleep/shutdown-when-done protocol state.
  // The subscriber refreshes the more-button indicator dot and, if the menu is
  // open, live-updates its protocol section (toggles + countdown chip).
  const unlistenWhenDone = await initWhenDone();
  const unsubWhenDone = subscribeWhenDone(() => {
    refreshViewMoreIndicator();
    rerenderViewMenuProtocol();
  });
  refreshViewMoreIndicator();

  return () => {
    viewMoreBtn?.removeEventListener("click", onViewMoreClick);
    unsubWhenDone();
    unlistenWhenDone();
  };
}

/** Registers the chats-view keyboard shortcuts (numbered slot jump/assign,
 * close-chat) and the ctrl-held sidebar hint class. Returns a dispose
 * function that unregisters everything. */
export function wireKeyboardShortcuts(listEl: HTMLElement): () => void {
  for (let i = 0; i < 9; i++) {
    const slot = i + 1;
    shortcuts.register(`open-chat-${slot}`, () => {
      if (shortcuts.getChatSlotMode() === "manual") {
        selectSessionBySlot(slot);
      } else {
        selectSessionByIndex(i);
      }
    });
    shortcuts.register(`assign-slot-${slot}`, () => assignCurrentToSlot(slot));
  }
  shortcuts.register("close-chat", closeFocusedChat);

  const unlistenCtrlHeld = shortcuts.onCtrlHeld((held) => {
    listEl.classList.toggle("kbd-hint-active", held);
  });

  return () => {
    for (let i = 1; i <= 9; i++) {
      shortcuts.unregister(`open-chat-${i}`);
      shortcuts.unregister(`assign-slot-${i}`);
    }
    shortcuts.unregister("close-chat");
    unlistenCtrlHeld();
  };
}

/** Wires the +New button, its floating FAB twin, the mobile back button,
 * the context menu, and the sidebar's main click handler (row menu buttons,
 * parked/pending/draft rows, session rows). No dispose function needed: the
 * next mount's `render(template(), root)` discards these nodes wholesale. */
export function wireStaticListeners(
  root: HTMLElement,
  view: HTMLElement,
  pane: HTMLElement,
  listEl: HTMLElement,
  newBtn: HTMLButtonElement | null,
): void {
  // Wire +New
  if (newBtn) {
    newBtn.disabled = false;
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => void startNewSession(pane));
  }

  // Wire the floating "new chat" CTA on the chats list (same action as +New).
  const fab = root.querySelector<HTMLButtonElement>("#sessionsFab");
  fab?.addEventListener("click", () => void startNewSession(pane));

  // Mobile back button: return from the chat pane to the session list overlay.
  // Only visible on ≤768px in chat mode (CSS-driven); a no-op on desktop.
  const backBtn = root.querySelector<HTMLButtonElement>("#sessionsBackBtn");
  backBtn?.addEventListener("click", () => view.setAttribute("data-mobile-pane", "list"));

  // Sort select moved to Settings. No binding needed here; sessions.ts reads
  // the persisted localStorage value on each renderSidebar call via loadSort().

  // Opens the right context menu for whichever row kind `li` is - shared by
  // the row's 3-dot click AND right-click (its only path in Portrait mode).
  const openMenuForRow = (li: HTMLElement, anchor: HTMLElement): void => {
    const sid = li.dataset.sessionId;
    if (sid) {
      openCtxMenu(sid, anchor);
      return;
    }
    const pid = li.dataset.placeholderId;
    if (!pid) return;
    if (li.classList.contains("parked-draft")) {
      const parked = state.parkedDrafts.find(d => d.placeholderId === pid);
      openDraftCtxMenu(anchor, () => {
        state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
        discardComposerDraft(pid);
        renderSidebar(listEl);
      }, parked?.projectPath ?? null);
    } else {
      openDraftCtxMenu(anchor, () => {
        if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
        else { discardDraft(pane); updateThinkingBar(); }
      });
    }
  };

  // Right-click anywhere on a session row opens the same context menu the
  // hover-revealed ⋮ button does (the button stays for discoverability).
  listEl.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id], li[data-placeholder-id]");
    if (!li) return;
    e.preventDefault();
    openMenuForRow(li, li);
  });

  listEl.addEventListener("click", (e) => {
    // All row menu buttons (3-dot) — handles live sessions, active drafts, and parked drafts.
    const menuBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".session-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const li = menuBtn.closest<HTMLLIElement>("li[data-session-id], li[data-placeholder-id]");
      if (li) openMenuForRow(li, menuBtn);
      return;
    }

    // Click on a parked draft row body: resume it as a new draft.
    const parkedLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.parked-draft[data-placeholder-id]");
    if (parkedLi) {
      const pid = parkedLi.dataset.placeholderId;
      if (pid) {
        const draft = state.parkedDrafts.find(d => d.placeholderId === pid);
        if (draft) {
          const oldPid = draft.placeholderId;
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
          void (async () => {
            await launchNewSession(pane, { path: draft.projectPath, name: draft.projectName }, draft.config);
            const newPid = state.pendingNewSession?.placeholderId;
            if (newPid && newPid !== oldPid) {
              moveComposerDraft(oldPid, newPid);
              state.composer?.setSessionId(newPid, { readOnly: false });
            }
            updateThinkingBar();
          })();
        }
      }
      return;
    }

    // Draft row click: re-open the pending pane.
    const draftLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending.draft");
    if (draftLi) {
      void (async () => { await resumeDraft(pane); updateThinkingBar(); })();
      return;
    }

    // Starting pending row click: if realId is already known (SessionStarted
    // fired), navigate there so the user can see progress. If not yet known,
    // no-op - the X button (data-discard-stuck) is the only way to abort,
    // and clicking the row body shouldn't trigger a destructive dialog.
    const startingLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending:not(.draft)");
    if (startingLi && startingLi.dataset.pending === "1") {
      const pending = state.pendingNewSession;
      const realId = pending?.realId;
      if (realId) {
        void (async () => { await selectSession(realId, pane); updateThinkingBar(); })();
      }
      return;
    }

    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) {
      void (async () => { await selectSession(id, pane); updateThinkingBar(); })()
        .catch((err) => console.error(`[sessions] selectSession(${id}) failed`, err));
    }
  });
}

/** Subscribes the three document-level custom events the rest of the app
 * dispatches at this pane (session-closed from elsewhere, sort-preference
 * change from Settings, "delete draft" from the view-more menu). Returns a
 * dispose function that removes all three. */
export function wireDocumentListeners(pane: HTMLElement, listEl: HTMLElement, myMount: number): () => void {
  const onSessionClosed = (e: Event) => {
    const { sessionId } = (e as CustomEvent<{ sessionId: string }>).detail;
    if (state.selectedId !== sessionId) return;
    if (state.renderer) state.renderer.detach();
    state.renderer = null;
    state.composer?.destroy();
    state.composer = null;
    setActiveSession(null);
    // Explicit close: forget the persisted chat so a restart doesn't re-open it.
    clearLastSelectedSession();
    pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
    // Optimistic removal: drop the row immediately without waiting for
    // instances-changed from the daemon (which takes a few seconds).
    state.sessions = state.sessions.filter(s => s.session_id !== sessionId);
    renderSidebar(listEl);
  };
  document.addEventListener("cc:session-closed", onSessionClosed);

  // When the Settings view changes the sort preference, rerender the sidebar.
  const onSortChanged = () => {
    if (state.mountId !== myMount) return;
    renderSidebar(listEl);
  };
  document.addEventListener("cc-sort-changed", onSortChanged);

  // view-more-menu dispatches this when the draft "Delete draft" is tapped.
  const onDiscardPendingDraft = () => {
    if (state.mountId !== myMount) return;
    if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
    else { discardDraft(pane); updateThinkingBar(); }
  };
  document.addEventListener("discard-pending-draft", onDiscardPendingDraft);

  return () => {
    document.removeEventListener("cc:session-closed", onSessionClosed);
    document.removeEventListener("cc-sort-changed", onSortChanged);
    document.removeEventListener("discard-pending-draft", onDiscardPendingDraft);
  };
}
