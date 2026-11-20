// ── Phone-only "more options" overflow menu (Variant B) ──────────────────────
//
// #viewMoreBtn renders on the phone transport only (template.ts); the desktop
// reaches the same actions through the command palette, the project dashboard,
// the chat tool strip and the right rail.
//
// Menu structure:
//   GENERAL  (greyed label)
//     New chat        (relocated from #view-more-host)
//     Preview         (relocated from #view-more-host; toggles the HTML preview panel)
//     Scheduled       (opens the standalone `session-schedule` window)
//     Menu            (the app's side menu)
//   ──────
//   THIS CHAT  (greyed label; only when a session or draft is selected)
//     ... (built by chat-menu.ts / buildChatMenuBlock)
//
// Sort lives in Settings; its label + select stay dormant in #view-more-host.

import { createMoreMenu } from "./more-menu-base";
import { whenDoneArmed } from "./when-done";
import { state } from "./state";
import {
  buildChatMenuBlock,
  closeActiveChatSubmenu,
  type ChatMenuCtx,
} from "./chat-menu";
import { liveChatMenuCtx } from "./chat-menu-ctx";
import { openSchedule } from "../../shared/open-schedule";
import { openSidemenu } from "../../shared/sidemenu";
import { cachedHasDeployWorkflow } from "./deploy-workflow-gate";

export function refreshViewMoreIndicator(): void {
  const btn = document.getElementById("viewMoreBtn");
  if (btn) btn.classList.toggle("has-indicator", whenDoneArmed());
}

const viewMenu = createMoreMenu<[]>({
  className: "session-more-menu view-more-menu",
  isOutside: (target, menu, btn) =>
    !menu.contains(target) && target !== btn,
  /** Move the relocated host controls back before the menu DOM is dropped. */
  beforeClose: (menu) => {
    closeActiveChatSubmenu();
    const host = document.getElementById("view-more-host");
    if (host) {
      const newBtn = menu.querySelector("#newSessionBtn");
      const previewBtn = menu.querySelector("#previewToggleBtn");
      if (newBtn) host.appendChild(newBtn);
      if (previewBtn) host.appendChild(previewBtn);
    }
  },
  build: (menu, close) => {
    const host = document.getElementById("view-more-host");

    const genLabel = document.createElement("span");
    genLabel.className = "smore-section-label";
    genLabel.textContent = "General";
    menu.appendChild(genLabel);

    // Relocate New chat and Preview (but NOT the sort select). Closed chats are
    // reached from a project dashboard's History modal, not an all-projects list.
    if (host) {
      for (const id of ["#newSessionBtn", "#previewToggleBtn"]) {
        const btn = host.querySelector(id);
        if (btn) menu.appendChild(btn);
      }
    }

    // Scheduled: opens the standalone calendar window (open_schedule_window
    // builds/focuses the `session-schedule` window). Works from either window
    // since it's a plain backend command, not an in-window route.
    const schedBtn = document.createElement("button");
    schedBtn.className = "smore-item";
    schedBtn.innerHTML = `<i class="ph ph-calendar-dots"></i><span>Scheduled</span>`;
    schedBtn.addEventListener("click", () => {
      openSchedule();
      close();
    });
    menu.appendChild(schedBtn);

    // The app menu: the phone's chat view hides the header that holds the burger.
    const appMenuBtn = document.createElement("button");
    appMenuBtn.className = "smore-item";
    appMenuBtn.innerHTML = `<i class="ph ph-list"></i><span>Menu</span>`;
    appMenuBtn.addEventListener("click", () => {
      close();
      openSidemenu();
    });
    menu.appendChild(appMenuBtn);

    // Hidden chats are the eye-slash head at the end of the chat heads (chat-heads.ts).

    // ── "This chat" section: only when a session or draft is active ─────────
    // A focused draft is also state.selectedId (its placeholder id), so it has
    // to win here or the draft gets the live "Close session" item instead of
    // "Delete draft".
    const pendingDraft = state.pendingNewSession;
    const hasDraft = !!pendingDraft && (!state.selectedId || state.selectedId === pendingDraft.placeholderId);
    const hasLive = !!state.selectedId && !hasDraft;

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
        ctx = liveChatMenuCtx(state.selectedId, () => close());
      } else {
        // draft
        const pending = state.pendingNewSession!;
        const cwd = pending.projectPath;
        ctx = {
          kind: "draft",
          sessionId: pending.realId,
          cwd,
          pid: null,
          readOnly: false,
          autoAcceptOn: false,
          subchatsOn: false,
          isHidden: false,
          isJarvis: false,
          isFrozen: false,
          hasDeployWorkflow: cachedHasDeployWorkflow(cwd),
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

    // Close the menu when New chat or Preview is clicked (their own listeners fire first).
    menu.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("#newSessionBtn") || target.closest("#previewToggleBtn")) {
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
