// Per-row 3-dot context menu, split out of sidebar.ts.
// Uses a rerender callback (injected by sidebar.ts) to avoid a circular import.
//
// Now delegates to chat-menu.ts for the shared "This chat" action block.

import { positionDropdown } from "./position-dropdown";
import { state } from "./state";
import {
  loadHiddenSessions,
  loadHiddenCollapsed,
  saveHiddenCollapsed,
  toggleSegCollapse,
} from "./sessions-helpers";
import { loadAnimEnabled, markSessionExiting } from "./sidebar-anim";
import { isAutoAccept } from "./permission-modal";
import { closeNeedsConfirm } from "./close-chat";
import {
  buildChatMenuBlock,
  closeActiveChatSubmenu,
  type ChatMenuCtx,
} from "./chat-menu";
import { isRemote } from "../../shared/transport";
import { cachedHasDeployWorkflow, refreshDeployWorkflowCache } from "./deploy-workflow-gate";

let activeCtxMenu: HTMLElement | null = null;
let rerenderSidebar: (() => void) | null = null;

export function setRerenderCallback(fn: () => void): void {
  rerenderSidebar = fn;
}

export function closeCtxMenu(): void {
  closeActiveChatSubmenu();
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

export function openDraftCtxMenu(
  anchor: HTMLElement,
  onDiscard: () => void,
  cwd: string | null = state.pendingNewSession?.projectPath ?? null,
): void {
  closeCtxMenu();
  const pending = state.pendingNewSession;

  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";
  document.body.appendChild(menu);
  activeCtxMenu = menu;

  const ctx: ChatMenuCtx = {
    kind: "draft",
    sessionId: pending?.realId ?? null,
    cwd,
    pid: null,
    readOnly: false,
    autoAcceptOn: false,
    isHidden: false,
    isJarvis: false,
    isFrozen: false,
    hasDeployWorkflow: cachedHasDeployWorkflow(cwd),
    onDiscard: () => { closeCtxMenu(); onDiscard(); },
    onAfterAction: () => closeCtxMenu(),
  };
  if (!isRemote()) void refreshDeployWorkflowCache(cwd);

  const block = buildChatMenuBlock(ctx, closeCtxMenu);
  menu.appendChild(block);

  positionDropdown(menu, anchor);
}

export function openCtxMenu(
  sessionId: string,
  anchor: HTMLElement,
): void {
  closeCtxMenu();

  const sess = state.sessions.find(s => s.session_id === sessionId);
  if (!sess) return;

  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";
  document.body.appendChild(menu);
  activeCtxMenu = menu;

  const hiddenSet = loadHiddenSessions();
  const isHidden = hiddenSet.has(sessionId);

  // "View changes" is only available when this is the currently active session
  // and the ChangesPanel is registered.
  const isActive = state.selectedId === sessionId;
  const viewChanges = isActive ? state.activeChatActions?.viewChanges : undefined;
  const cwd = sess.cwd ? String(sess.cwd) : null;

  const ctx: ChatMenuCtx = {
    kind: "live",
    sessionId,
    cwd,
    pid: sess.pid ?? null,
    readOnly: sess.kind === "external" || sess.kind === "automated",
    autoAcceptOn: isAutoAccept(sessionId),
    isHidden,
    isJarvis: sess.jarvis === true,
    isFrozen: sess.frozen === true,
    hasDeployWorkflow: cachedHasDeployWorkflow(cwd),
    viewChanges,
    onAfterAction: () => {
      closeCtxMenu();
      rerenderSidebar?.();
    },
    onDiscard: undefined,
  };
  if (!isRemote()) void refreshDeployWorkflowCache(cwd);

  const block = buildChatMenuBlock(ctx, closeCtxMenu);

  // Wire exit animation for Close (capture so it runs before chat-menu's close).
  // A busy chat asks "discard the turn?" first, and a sticky exit can't be
  // undone, so a Cancel would hide the still-open chat from the sidebar for
  // good. That case leaves the exit to the reconcile once clear_session lands.
  const closeBtn = block.querySelector<HTMLButtonElement>(".smore-item.smore-danger");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (closeNeedsConfirm(sessionId)) return;
      const listEl = anchor.closest<HTMLElement>("#sessions-list");
      if (listEl && loadAnimEnabled()) markSessionExiting(listEl, sessionId);
    }, true);
  }

  menu.appendChild(block);
  positionDropdown(menu, anchor);
}

// Close context menu on outside click or Escape (wired once at module load)
document.addEventListener("click", (e) => {
  if (activeCtxMenu && !activeCtxMenu.contains(e.target as Node)) {
    closeCtxMenu();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeCtxMenu) closeCtxMenu();
});

// Right-click anywhere on a session row opens the same menu the 3-dot button
// used to. The portrait row style drops that button entirely, so this is the
// only way in there; it works in the classic style too rather than being
// gated on the setting.
document.addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("#sessions-list li[data-session-id]");
  if (!row) return;
  const sessionId = row.dataset.sessionId;
  if (!sessionId) return;
  e.preventDefault();
  openCtxMenu(sessionId, row);
});

document.addEventListener("click", (e) => {
  const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-hidden-toggle]");
  if (toggle) {
    saveHiddenCollapsed(!loadHiddenCollapsed());
    rerenderSidebar?.();
  }
});

document.addEventListener("click", (e) => {
  const segToggle = (e.target as HTMLElement).closest<HTMLElement>("[data-seg-toggle]");
  if (segToggle) {
    const seg = parseInt(segToggle.dataset.segToggle!, 10);
    toggleSegCollapse(seg);
    rerenderSidebar?.();
  }
});
