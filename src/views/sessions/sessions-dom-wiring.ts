// DOM/UI wiring half of sessions-wiring.ts (ai_todo 463): click handlers,
// keyboard shortcuts, and document-level custom events. Event-transport
// wiring (daemon/instances listeners) stays in sessions-wiring.ts.

import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import { isRemote } from "../../shared/transport";
import { toggleChatView } from "./chat-dashboard/chat-view-pref";
import { mountPreviewTab, type PreviewController } from "./preview-panel";
import { mountFabDial } from "./fab-dial";
import { enterCodeMode } from "./code-mode/entry";
import { initHeaderMerge } from "./mobile-header-merge";
import { startNewSession, launchNewSession, discardDraft, resumeDraft, resumeParkedDraft } from "./pending-flow";
import { discardComposerDraft } from "../../shared/chat/composer";
import { saveParkedDrafts } from "./pending-draft-storage";
import { selectSession } from "./active-session";
// Registers the opener behind every [data-chat-menu-id] right-click (shared/chat/chat-menu-target.ts).
import "./chat-menu-open";
import { state, setActiveSession, clearLastSelectedSession } from "./state";
import { updateThinkingBar } from "./session-thinking-bar";
import { paneEmptyStateHtml } from "./sessions-helpers";
import { renderSidebar, refreshSessions, openCtxMenu, openDraftCtxMenu } from "./sidebar";
import { headsUi } from "./chat-heads";
import { createHeadKeys } from "./chat-heads-keys";
import { attachHeadDrag } from "./chat-heads-drag";
import { showTouchHoverCard } from "./sidebar-hover-card";
import { initWhenDone, subscribeWhenDone } from "./when-done";
import { mountWhenDoneChip } from "./when-done-chip";
import { openVoiceRecorder, voiceEntryAvailable, watchVoiceChanges } from "../../shared/mobile/voice-entry";
import {
  closeViewMoreMenu,
  refreshViewMoreIndicator,
  toggleViewMoreMenu,
} from "./view-more-menu";
import {
  selectSessionByIndex,
  closeFocusedChat,
  openFocusedChatDashboard,
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

/** The chat pane's panels: Todos / Drafts / Backlog / Preview, in a split beside
 * the chat on desktop and a full-screen cover on the phone (fab-dial.ts).
 * Preview's controller is what the rest of the view drives Preview through. Owns its own host element
 * because active-session.ts rewrites the pane's innerHTML on every switch. */
export function wirePreviewPanel(root: HTMLElement, pane: HTMLElement): PreviewController | null {
  state.fabDial = mountFabDial(pane, {
    mountPreview: mountPreviewTab,
    onCode: () => void enterCodeMode(),
  });
  const previewController = state.fabDial.previewController();
  state.previewController = previewController;
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
  // The button only exists on the phone (template.ts): the desktop opens the
  // command palette with Ctrl+Shift+P instead, which carries every row the
  // dropdown had. The phone has no keyboard, and History / Preview / Scheduled /
  // Filter / Hidden have no palette row, so it keeps the dropdown.
  const onViewMoreClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (viewMoreBtn) toggleViewMoreMenu(viewMoreBtn);
  };
  viewMoreBtn?.addEventListener("click", onViewMoreClick);

  const previewToggleBtn = root.querySelector<HTMLButtonElement>("#previewToggleBtn");
  if (previewToggleBtn) {
    previewToggleBtn.addEventListener("click", () => {
      closeViewMoreMenu();
      previewController?.toggle();
    });
  }

  // Hydrate + subscribe to the global sleep/shutdown-when-done protocol state.
  // The subscriber refreshes the more-button indicator dot.
  const unlistenWhenDone = await initWhenDone();
  const unsubWhenDone = subscribeWhenDone(() => {
    refreshViewMoreIndicator();
  });
  refreshViewMoreIndicator();
  const disposeChip = mountWhenDoneChip(root);

  return () => {
    viewMoreBtn?.removeEventListener("click", onViewMoreClick);
    disposeChip();
    unsubWhenDone();
    unlistenWhenDone();
  };
}

/** Registers the chats-view keyboard shortcuts (numbered chat jump,
 * close-chat) and the ctrl-held sidebar hint class. Returns a dispose function
 * that unregisters everything. Ctrl+Shift+1-9 (new chat from a favourite
 * project slot) and the favourites strip shown while Ctrl+Shift is held live
 * in boot.ts instead, since they must work even when this view isn't mounted. */
// Haiku, Sonnet, Opus, Fable: shortcuts.ts declares set-model-1..4.
const MODEL_SLOTS = 4;

export function wireKeyboardShortcuts(listEl: HTMLElement): () => void {
  for (let i = 0; i < 9; i++) {
    const slot = i + 1;
    shortcuts.register(`open-chat-${slot}`, () => selectSessionByIndex(i));
  }
  shortcuts.register("close-chat", closeFocusedChat);
  shortcuts.register("project-dashboard", openFocusedChatDashboard);
  // Draft and live chat alike: the open pane's statusbar owns both values.
  for (let i = 0; i < MODEL_SLOTS; i++) {
    shortcuts.register(`set-model-${i + 1}`, () => state.statusbar?.pickModelSlot(i));
  }
  shortcuts.register("effort-up", () => state.statusbar?.stepEffort(1));
  shortcuts.register("effort-down", () => state.statusbar?.stepEffort(-1));
  // The phone always draws Messages, so a switch there would only flip the desktop's setting.
  const desktop = !isRemote();
  if (desktop) {
    shortcuts.register("toggle-chat-view", () => toggleChatView().catch((err) => console.error("[chat-view] saving the chat view failed", err)));
  }

  // Holding Ctrl opens the stack and numbers the heads; Up/Down walk a highlight; releasing
  // opens it (chat-heads-keys.ts). The renderer draws the numbers off `headsUi.numbers`.
  const headKeys = createHeadKeys({
    ui: headsUi,
    // The hidden-chats view draws no numbered stack, so a walk there would open an unseen chat.
    count: () => (headsUi.showHidden ? 0 : state.sortedSessionIds.length),
    render: () => renderSidebar(listEl),
    openIndex: selectSessionByIndex,
  });
  const unlistenModifierHint = shortcuts.onModifierHint((hint) => headKeys.hint(hint.numbers));
  const onHeadKey = (e: KeyboardEvent): void => {
    if (headKeys.keydown(e)) { e.preventDefault(); e.stopPropagation(); }
  };
  // Capture phase: the composer's own Ctrl+Arrow handling must not see a walk.
  document.addEventListener("keydown", onHeadKey, true);
  // The phone's back button: from an open chat with the stack closed, back opens the stack
  // (the list the old two-pane layout went back to); with it open, back leaves the view.
  const onHeadsBack = (e: Event): void => {
    if (headsUi.open) return;
    headsUi.open = true;
    renderSidebar(listEl);
    (e as CustomEvent<{ handled: boolean }>).detail.handled = true;
  };
  document.addEventListener("chat-heads-back", onHeadsBack);

  return () => {
    document.removeEventListener("chat-heads-back", onHeadsBack);
    for (let i = 1; i <= 9; i++) {
      shortcuts.unregister(`open-chat-${i}`);
    }
    shortcuts.unregister("close-chat");
    shortcuts.unregister("project-dashboard");
    for (let i = 1; i <= MODEL_SLOTS; i++) shortcuts.unregister(`set-model-${i}`);
    shortcuts.unregister("effort-up");
    shortcuts.unregister("effort-down");
    if (desktop) shortcuts.unregister("toggle-chat-view");
    document.removeEventListener("keydown", onHeadKey, true);
    headKeys.dispose();
    unlistenModifierHint();
  };
}

/** Wires the +New button, the context menu, and the sidebar's main click handler (row menu buttons,
 * parked/pending/draft rows, session rows). No dispose function needed: the
 * next mount's `render(template(), root)` discards these nodes wholesale. */
export function wireStaticListeners(
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

  // Opens the right context menu for whichever row kind `li` is - right-click
  // only, there is no 3-dot button.
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
        saveParkedDrafts(state.parkedDrafts);
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

  // Right-click anywhere on a session row opens the row's context menu.
  listEl.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id], li[data-placeholder-id]");
    if (!li) return;
    e.preventDefault();
    openMenuForRow(li, li);
  });

  // Drag to reorder; a long-press without a move raises the hover card with its Menu button.
  attachHeadDrag(listEl, {
    render: () => renderSidebar(listEl),
    onLongPress: (li) => showTouchHoverCard(li, (head, sid) => openCtxMenu(sid, head)),
  });
  // The mic head's live dot follows the recorder, including a note started from the tile or the notification.
  if (voiceEntryAvailable()) watchVoiceChanges(() => { if (listEl.isConnected) renderSidebar(listEl); });

  listEl.addEventListener("click", (e) => {
    // The control heads: toggle, +, hidden chats, back.
    const control = (e.target as HTMLElement).closest<HTMLElement>("[data-heads-toggle], [data-heads-new], [data-heads-hidden], [data-heads-back], [data-heads-voice]");
    if (control) {
      // Leaves for the bundled recorder; nothing in the stack changes.
      if (control.dataset.headsVoice) { openVoiceRecorder(); return; }
      if (control.dataset.headsNew) {
        void startNewSession(pane);
        if (isRemote()) headsUi.open = false;
      } else if (control.dataset.headsToggle) headsUi.open = !headsUi.open;
      else if (control.dataset.headsHidden) headsUi.showHidden = true;
      else if (control.dataset.headsBack) headsUi.showHidden = false;
      renderSidebar(listEl);
      return;
    }
    // A tap on the phone opens the chat and puts the stack away (a desktop keeps it).
    if (isRemote() && (e.target as HTMLElement).closest("li.chat-head:not(.chat-head-control)")) {
      headsUi.open = false;
      headsUi.showHidden = false;
      renderSidebar(listEl);
    }
    // Click on a parked draft row body: resume it as a new draft.
    const parkedLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.parked-draft[data-placeholder-id]");
    if (parkedLi) {
      const pid = parkedLi.dataset.placeholderId;
      if (pid) {
        const draft = state.parkedDrafts.find(d => d.placeholderId === pid);
        if (draft) {
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
          saveParkedDrafts(state.parkedDrafts);
          void (async () => {
            await resumeParkedDraft(pane, draft);
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
    if (state.mountId !== myMount) return;
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
    // Backstop: by the time clear_session resolved (performClose awaits it),
    // the daemon's cached_instances already excludes this session - re-pull
    // from that source of truth too, so the row can't survive the optimistic
    // removal above if anything (a stale concurrent render, a missed filter)
    // undid it.
    void refreshSessions().then(() => {
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
    });
  };
  document.addEventListener("cc:session-closed", onSessionClosed);

  // view-more-menu dispatches this when the draft "Delete draft" is tapped.
  const onDiscardPendingDraft = () => {
    if (state.mountId !== myMount) return;
    if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
    else { discardDraft(pane); updateThinkingBar(); }
  };
  document.addEventListener("discard-pending-draft", onDiscardPendingDraft);

  return () => {
    document.removeEventListener("cc:session-closed", onSessionClosed);
    document.removeEventListener("discard-pending-draft", onDiscardPendingDraft);
  };
}
