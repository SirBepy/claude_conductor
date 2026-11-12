// ── Phone-only "more options" overflow menu (Variant B) ──────────────────────
//
// #viewMoreBtn renders on the phone transport only (template.ts); the desktop
// reaches the same actions through the command palette, the project dashboard,
// the chat tool strip and the right rail.
//
// Menu structure:
//   GENERAL  (greyed label)
//     New chat        (relocated from #view-more-host)
//     History         (relocated from #view-more-host)
//     Preview         (relocated from #view-more-host; toggles the HTML preview panel)
//     Scheduled       (opens the standalone `session-schedule` window)
//     Filter by project ▸ / Hidden ▸  (submenus)
//   ──────
//   THIS CHAT  (greyed label; only when a session or draft is selected)
//     ... (built by chat-menu.ts / buildChatMenuBlock)
//
// Sort lives in Settings; its label + select stay dormant in #view-more-host.

import { positionSubmenu } from "./position-dropdown";
import { createMoreMenu } from "./more-menu-base";
import { whenDoneArmed } from "./when-done";
import { state, windowIdOf } from "./state";
import {
  buildChatMenuBlock,
  closeActiveChatSubmenu,
  type ChatMenuCtx,
} from "./chat-menu";
import { loadHiddenSessions, loadHiddenProjects, isJarvisOrWorker, isSubchat, loadSort, loadUnreadSet, deriveQuestionSet } from "./sessions-helpers";
import { pendingPromptSessionIds } from "./permission-modal";
import { liveChatMenuCtx } from "./chat-menu-ctx";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import { openSchedule } from "../../shared/open-schedule";
import { isRemote } from "../../shared/transport";
import { cachedHasDeployWorkflow } from "./deploy-workflow-gate";
import { renderSidebarRow, sessionRowOptions } from "./sidebar-rows";
import { renderProjectRail } from "./project-rail";
import { selectSession } from "./active-session";
import { renderSidebar } from "./sidebar";

// Filter-by-project and Hidden (below) share this: at most one of this
// menu's own submenus is open at a time, so reopening one closes the other.
let _viewSubMenu: HTMLElement | null = null;

function closeViewSubMenu(): void {
  _viewSubMenu?.remove();
  _viewSubMenu = null;
}

export function refreshViewMoreIndicator(): void {
  const btn = document.getElementById("viewMoreBtn");
  if (btn) btn.classList.toggle("has-indicator", whenDoneArmed());
}

const viewMenu = createMoreMenu<[]>({
  className: "session-more-menu view-more-menu",
  isOutside: (target, menu, btn) =>
    !menu.contains(target) && target !== btn && !_viewSubMenu?.contains(target),
  /** Move the relocated host controls back before the menu DOM is dropped. */
  beforeClose: (menu) => {
    closeViewSubMenu();
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

    // Relocate New chat, History and Preview (but NOT the sort select).
    if (host) {
      for (const id of ["#newSessionBtn", "#historyBtn", "#previewToggleBtn"]) {
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

    // ── Filter by project / Hidden ──────────────────────────────────────────
    // On the phone the project rail and Hidden live here instead of inline in
    // the sidebar (a permanent chip row, and a Hidden row pinned under the
    // floating "new chat" FAB); the desktop sidebar renders both inline
    // (sidebar-entries.ts). The isRemote() guard keeps them out of the menu
    // in any non-phone harness mount.
    if (isRemote()) {
      const listSessions = state.sessions.filter((s) => !isJarvisOrWorker(s) && !isSubchat(s));

      const filterBtn = document.createElement("button");
      filterBtn.className = "smore-item smore-has-sub";
      filterBtn.innerHTML = `<i class="ph ph-funnel-simple"></i><span>Filter by project</span><i class="ph ph-caret-right smore-sub-caret"></i>`;
      menu.appendChild(filterBtn);
      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_viewSubMenu) {
          closeViewSubMenu();
          return;
        }
        const sub = document.createElement("div");
        sub.className = "session-more-menu smore-submenu smore-filter-submenu";
        document.body.appendChild(sub);
        _viewSubMenu = sub;
        // Real component, not a reimplementation: same renderProjectRail the
        // desktop/inline rail calls, just given this submenu as its host. A
        // toggle re-renders both this submenu (active/off chip state) and the
        // real sidebar list (so the filter actually applies below).
        const onFilterChange = () => {
          renderProjectRail(sub, listSessions, onFilterChange);
          const listEl = document.getElementById("sessions-list");
          if (listEl) renderSidebar(listEl);
        };
        renderProjectRail(sub, listSessions, onFilterChange);
        positionSubmenu(sub, filterBtn);
      });

      const hidden = loadHiddenSessions();
      const hiddenProjects = loadHiddenProjects();
      const hiddenSessions = listSessions.filter(
        (s) => hidden.has(s.session_id) && !hiddenProjects.has(String(s.cwd ?? "")),
      );

      const hiddenBtn = document.createElement("button");
      hiddenBtn.className = "smore-item smore-has-sub" + (hiddenSessions.length ? "" : " is-disabled");
      if (!hiddenSessions.length) hiddenBtn.title = "No hidden chats";
      hiddenBtn.innerHTML =
        `<i class="ph ph-eye-slash"></i><span>Hidden</span>` +
        (hiddenSessions.length ? `<span class="smore-count-badge">${hiddenSessions.length}</span>` : "") +
        `<i class="ph ph-caret-right smore-sub-caret"></i>`;
      menu.appendChild(hiddenBtn);
      if (hiddenSessions.length) {
        hiddenBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (_viewSubMenu) {
            closeViewSubMenu();
            return;
          }
          const sub = document.createElement("div");
          sub.className = "session-more-menu smore-submenu";
          const sort = loadSort();
          // Same status computation sidebar-entries.ts uses for every other
          // row (code-check, 2026-10-18): empty sets here silently blanked a
          // hidden chat's status dot/attention pulse even when it was
          // genuinely rate-limited, closing, or needing input.
          const unread = loadUnreadSet();
          const attention = pendingPromptSessionIds();
          const openRowId = windowIdOf(state.selectedId);
          if (openRowId) attention.delete(openRowId);
          const question = deriveQuestionSet(hiddenSessions);
          for (const id of pendingPromptSessionIds()) question.add(id);
          const rateLimited = new Set(hiddenSessions.filter(isBlocked).map((s) => s.session_id));
          const closing = new Set(hiddenSessions.filter((s) => s.closing).map((s) => s.session_id));
          sub.innerHTML = `<ul class="sessions-list smore-hidden-list">${hiddenSessions
            .map((s) => renderSidebarRow(sessionRowOptions(s, {
              isActive: s.session_id === openRowId,
              unread, attention, question, rateLimited, closing,
              sort, drainMap: new Map(), scheduledCountMap: new Map(), kbdHint: "",
            })))
            .join("")}</ul>`;
          document.body.appendChild(sub);
          _viewSubMenu = sub;
          positionSubmenu(sub, hiddenBtn);
          sub.addEventListener("click", (ev) => {
            const li = (ev.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
            const id = li?.dataset.sessionId;
            if (!id) return;
            const pane = document.querySelector<HTMLElement>(".session-pane");
            if (pane) void selectSession(id, pane);
            close();
          });
        });
      }
    }

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
