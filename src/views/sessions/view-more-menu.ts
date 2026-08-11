// ── View-level "more options" overflow menu (Variant B) ──────────────────────
//
// Menu structure:
//   GENERAL  (greyed label)
//     New chat        (relocated from #view-more-host)
//     History         (relocated from #view-more-host)
//     Preview         (relocated from #view-more-host; toggles the HTML preview panel)
//     Scheduled       (opens the standalone `session-schedule` window)
//     When done ▸     (Sleep / Shutdown submenu; amber chip on parent when armed)
//   ──────
//   THIS CHAT  (greyed label; only when a session or draft is selected)
//     ... (built by chat-menu.ts / buildChatMenuBlock)
//
// Sort moved to Settings (Step 6). The sort label + select are no longer
// relocated into this menu; they stay dormant in #view-more-host.

import type { TerminalAction } from "../../types/ipc.generated";
import { positionSubmenu } from "./position-dropdown";
import { createMoreMenu } from "./more-menu-base";
import {
  armOrToggleWhenDone,
  cancelWhenDone,
  whenDoneArmed,
  whenDoneMenuHtml,
  whenDoneAction,
} from "./when-done";
import { state } from "./state";
import {
  buildChatMenuBlock,
  closeActiveChatSubmenu,
  type ChatMenuCtx,
} from "./chat-menu";
import { loadHiddenSessions } from "./sessions-helpers";
import { isAutoAccept } from "./permission-modal";
import { invoke } from "../../shared/ipc";

let _whenDoneSubMenu: HTMLElement | null = null;

function closeWhenDoneSub(): void {
  _whenDoneSubMenu?.remove();
  _whenDoneSubMenu = null;
}

export function refreshViewMoreIndicator(): void {
  const btn = document.getElementById("viewMoreBtn");
  if (btn) btn.classList.toggle("has-indicator", whenDoneArmed());
}

/** Rebuild the when-done parent row text in an open menu (countdown changes). */
export function rerenderViewMenuProtocol(): void {
  const menu = viewMenu.element();
  if (!menu) return;
  const parentRow = menu.querySelector<HTMLElement>("[data-when-done-parent]");
  if (!parentRow) return;
  _updateWhenDoneParent(parentRow);
}

function _whenDoneParentText(): string {
  const s = state.whenDone;
  if (!s || s.phase === "disarmed") return "When done";
  const action = whenDoneAction();
  const label = action === "sleep" ? "Sleep" : action === "shutdown" ? "Shutdown" : "When done";
  if (s.phase === "countingDown" && s.countdown_remaining_secs != null) {
    return `${label} in ${s.countdown_remaining_secs}s`;
  }
  if (s.phase === "firing") return `${label} now...`;
  return `${label} when done`;
}

function _updateWhenDoneParent(el: HTMLElement): void {
  const armed = whenDoneArmed();
  el.classList.toggle("is-on", armed);
  const textSpan = el.querySelector<HTMLElement>(".when-done-parent-text");
  if (textSpan) textSpan.textContent = _whenDoneParentText();
  const dot = el.querySelector<HTMLElement>(".smore-check-dot");
  if (armed && !dot) {
    const d = document.createElement("span");
    d.className = "smore-check-dot";
    el.appendChild(d);
  } else if (!armed && dot) {
    dot.remove();
  }
}

const viewMenu = createMoreMenu<[]>({
  className: "session-more-menu view-more-menu",
  isOutside: (target, menu, btn) =>
    !menu.contains(target) && target !== btn && !_whenDoneSubMenu?.contains(target),
  /** Move the relocated host controls back before the menu DOM is dropped. */
  beforeClose: (menu) => {
    closeWhenDoneSub();
    closeActiveChatSubmenu();
    const host = document.getElementById("view-more-host");
    if (host) {
      const newBtn = menu.querySelector("#newSessionBtn");
      const histBtn = menu.querySelector("#historyBtn");
      const previewBtn = menu.querySelector("#previewToggleBtn");
      if (newBtn) host.appendChild(newBtn);
      if (histBtn) host.appendChild(histBtn);
      if (previewBtn) host.appendChild(previewBtn);
    }
  },
  build: (menu, close) => {
    const host = document.getElementById("view-more-host");

    const genLabel = document.createElement("span");
    genLabel.className = "smore-section-label";
    genLabel.textContent = "General";
    menu.appendChild(genLabel);

    // Relocate New chat + History + Preview-toggle buttons (but NOT the sort select).
    if (host) {
      const newBtn = host.querySelector("#newSessionBtn");
      const histBtn = host.querySelector("#historyBtn");
      const previewBtn = host.querySelector("#previewToggleBtn");
      if (newBtn) menu.appendChild(newBtn);
      if (histBtn) menu.appendChild(histBtn);
      if (previewBtn) menu.appendChild(previewBtn);
    }

    // Scheduled: opens the standalone calendar window (open_schedule_window
    // builds/focuses the `session-schedule` window). Works from either window
    // since it's a plain backend command, not an in-window route.
    const schedBtn = document.createElement("button");
    schedBtn.className = "smore-item";
    schedBtn.innerHTML = `<i class="ph ph-calendar-dots"></i><span>Scheduled</span>`;
    schedBtn.addEventListener("click", () => {
      void invoke("open_schedule_window").catch((err) =>
        console.error("[view-more] open_schedule_window failed", err),
      );
      close();
    });
    menu.appendChild(schedBtn);

    // ── When done ▸ submenu parent ─────────────────────────────────────────
    const whenDoneParent = document.createElement("button");
    whenDoneParent.className = "smore-item smore-has-sub" + (whenDoneArmed() ? " is-on" : "");
    whenDoneParent.dataset.whenDoneParent = "1";
    whenDoneParent.innerHTML =
      `<i class="ph ph-moon-stars"></i>` +
      `<span class="when-done-parent-text">${_whenDoneParentText()}</span>` +
      `<i class="ph ph-caret-right smore-sub-caret"></i>` +
      (whenDoneArmed() ? `<span class="smore-check-dot"></span>` : "");
    menu.appendChild(whenDoneParent);

    whenDoneParent.addEventListener("click", (e) => {
      e.stopPropagation();

      if (_whenDoneSubMenu) {
        closeWhenDoneSub();
        return;
      }

      const sub = document.createElement("div");
      sub.className = "session-more-menu smore-submenu";
      sub.innerHTML = whenDoneMenuHtml();
      document.body.appendChild(sub);
      _whenDoneSubMenu = sub;

      // Position the submenu to the right (or left if no room) of the parent item.
      positionSubmenu(sub, whenDoneParent);

      sub.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const cancelBtn = target.closest("[data-when-done-cancel]");
        if (cancelBtn) {
          void cancelWhenDone();
          closeWhenDoneSub();
          return;
        }
        const toggle = target.closest<HTMLButtonElement>("[data-when-done]");
        if (toggle) {
          const action = toggle.dataset.whenDone as TerminalAction;
          void armOrToggleWhenDone(action);
          closeWhenDoneSub();
        }
      });
    });

    // ── "This chat" section: only when a session or draft is active ─────────
    const hasLive = !!state.selectedId;
    const hasDraft = !!state.pendingNewSession;

    if (hasLive || hasDraft) {
      const sep = document.createElement("div");
      sep.className = "smore-sep";
      menu.appendChild(sep);

      const chatLabel = document.createElement("span");
      chatLabel.className = "smore-section-label";
      chatLabel.textContent = "This Chat";
      menu.appendChild(chatLabel);

      let ctx: ChatMenuCtx;
      if (hasLive && state.selectedId) {
        const sid = state.selectedId;
        const sess = state.sessions.find(s => s.session_id === sid);
        const hiddenSet = loadHiddenSessions();
        ctx = {
          kind: "live",
          sessionId: sid,
          cwd: sess?.cwd ? String(sess.cwd) : null,
          pid: sess?.pid ?? null,
          readOnly: sess?.kind === "external" || sess?.kind === "automated",
          autoAcceptOn: isAutoAccept(sid),
          isHidden: hiddenSet.has(sid),
          isJarvis: sess?.jarvis === true,
          isFrozen: sess?.frozen === true,
          viewChanges: state.activeChatActions?.viewChanges,
          onAfterAction: () => close(),
        };
      } else {
        // draft
        const pending = state.pendingNewSession!;
        ctx = {
          kind: "draft",
          sessionId: pending.realId,
          cwd: pending.projectPath,
          pid: null,
          readOnly: false,
          autoAcceptOn: false,
          isHidden: false,
          isJarvis: false,
          isFrozen: false,
          onDiscard: () => {
            close();
            // Signal sessions.ts to handle draft discard.
            document.dispatchEvent(new CustomEvent("discard-pending-draft"));
          },
        };
      }

      const block = buildChatMenuBlock(ctx, close);
      menu.appendChild(block);
    }

    // Close the menu when New chat or History is clicked (their own listeners fire first).
    menu.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("#newSessionBtn") || target.closest("#historyBtn") || target.closest("#previewToggleBtn")) {
        close();
      }
    });
  },
});

export function closeViewMoreMenu(): void {
  viewMenu.close();
}

/** Toggle the menu open/closed. */
export function toggleViewMoreMenu(btn: HTMLButtonElement): void {
  viewMenu.toggle(btn);
}
