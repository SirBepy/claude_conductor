// Shared "This chat" action block used by:
//   - view-more-menu.ts  (top-right viewMore dropdown, "THIS CHAT" section)
//   - sidebar-ctx-menu.ts (per-row 3-dot context menu)
//
// Returns a built DOM fragment; caller appends it into the parent container.

import { invoke } from "../../shared/ipc";
import {
  isAutoAccept,
  setAutoAccept,
  autoAcceptParked,
} from "./permission-modal";
import { closeChat } from "./close-chat";
import {
  loadHiddenSessions,
  saveHiddenSessions,
} from "./sessions-helpers";
import { triggerHandoff } from "./handoff";
import { isRawViewEnabled, setRawViewEnabled } from "../../shared/chat/message-filter-pref";
import { state } from "./state";

export interface ChatMenuCtx {
  kind: "live" | "draft";
  sessionId: string | null;
  cwd: string | null;
  pid: number | null;
  readOnly: boolean;
  autoAcceptOn: boolean;
  isHidden: boolean;
  /** Jarvis-flagged sessions always auto-accept (Part A) - the toggle is
   *  disabled for them so flipping it off can't silently stall the fleet. */
  isJarvis?: boolean;
  /** Daemon-authoritative frozen flag (`Instance.frozen`). Freeze/Unfreeze is
   *  only offered for Interactive sessions - callers gate that via `readOnly`
   *  (true for external/automated), same as every other agent-only action. */
  isFrozen?: boolean;
  viewChanges?: () => void;
  onAfterAction?: () => void;
  onDiscard?: () => void;
}

// ── Submenu positioning ──────────────────────────────────────────────────────

let _activeSub: HTMLElement | null = null;

function closeSub(): void {
  _activeSub?.remove();
  _activeSub = null;
}

export function positionAndShowSubmenu(sub: HTMLElement, parentItem: HTMLElement): void {
  closeSub();
  document.body.appendChild(sub);
  _activeSub = sub;

  const itemRect = parentItem.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();
  let left = itemRect.right + 4;
  if (left + subRect.width > window.innerWidth - 4) {
    left = itemRect.left - subRect.width - 4;
  }
  let top = itemRect.top;
  if (top + subRect.height > window.innerHeight - 4) {
    top = window.innerHeight - subRect.height - 4;
  }
  if (top < 4) top = 4;
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
}

// ── Item descriptor ──────────────────────────────────────────────────────────

interface ItemDesc {
  icon: string;
  label: string;
  run?: () => void | Promise<void>;
  disabledReason?: string;
  danger?: boolean;
  checkDot?: boolean;
  isOn?: boolean;
}

// ── Build helper ─────────────────────────────────────────────────────────────

function makeItem(desc: ItemDesc): HTMLButtonElement {
  const btn = document.createElement("button");
  const classes = ["smore-item"];
  if (desc.danger) classes.push("smore-danger");
  if (desc.isOn) classes.push("is-on");
  if (!desc.run || desc.disabledReason) classes.push("is-disabled");
  btn.className = classes.join(" ");
  if (desc.disabledReason) btn.title = desc.disabledReason;
  btn.innerHTML =
    `<i class="ph ph-${desc.icon}"></i>${desc.label}` +
    (desc.checkDot ? `<span class="smore-check-dot"></span>` : "");
  return btn;
}

function makeSubParent(icon: string, label: string, items: ItemDesc[]): HTMLButtonElement {
  const allDisabled = items.every(i => !i.run || !!i.disabledReason);
  const btn = document.createElement("button");
  btn.className = "smore-item smore-has-sub" + (allDisabled ? " is-disabled" : "");
  if (allDisabled) btn.title = "No actions available";
  btn.dataset.subLabel = label;
  btn.innerHTML = `<i class="ph ph-${icon}"></i>${label}<i class="ph ph-caret-right smore-sub-caret"></i>`;
  return btn;
}

// ── Public builder ───────────────────────────────────────────────────────────

/**
 * Build the "This chat" DOM block (4 submenus + Close / Delete draft) for the
 * given context. The returned fragment is ready to be appended into a parent
 * container that already has the section label.
 *
 * The caller must also call `bindChatMenuClicks(container, ctx, closeMenu)` to
 * wire click handlers.
 */
export function buildChatMenuBlock(
  ctx: ChatMenuCtx,
  closeMenu: () => void,
): HTMLElement {
  const frag = document.createElement("div");
  frag.className = "chat-menu-block";

  const isDraft = ctx.kind === "draft";
  const sessionId = ctx.sessionId;
  const cwd = ctx.cwd;

  // ── Open project in ▸ ──────────────────────────────────────────────────────
  const openProjectItems: ItemDesc[] = [
    {
      icon: "code",
      label: "VS Code",
      run: cwd ? async () => {
        try { await invoke<void>("open_in_vscode", { path: cwd }); }
        catch { /* code may not be installed */ }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
    {
      icon: "terminal-window",
      label: "Terminal",
      run: cwd ? async () => {
        try { await invoke<void>("open_terminal_in_directory", { path: cwd }); }
        catch (err) { alert(`Failed to open terminal: ${err}`); }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
    {
      icon: "folder-notch-open",
      label: "File Explorer",
      run: cwd ? async () => {
        try { await invoke<void>("open_in_explorer", { path: cwd }); }
        catch (err) { alert(`Failed to open file explorer: ${err}`); }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
    {
      icon: "squares-four",
      label: "Dashboard",
      run: cwd ? async () => {
        try { await invoke<void>("open_dashboard_project", { cwd }); }
        catch (e) { console.error("[chat-menu] open_dashboard_project failed", e); }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
  ];

  // ── Chat ▸ ─────────────────────────────────────────────────────────────────
  const isHidden = ctx.isHidden;
  const chatItems: ItemDesc[] = [
    {
      icon: isHidden ? "eye" : "eye-slash",
      label: isHidden ? "Unhide chat" : "Hide chat",
      run: isDraft || !sessionId
        ? undefined
        : () => {
            const hidden = loadHiddenSessions();
            if (isHidden) hidden.delete(sessionId);
            else hidden.add(sessionId);
            saveHiddenSessions(hidden);
            ctx.onAfterAction?.();
          },
      disabledReason: isDraft ? "Not available until the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "terminal-window",
      label: "Move to terminal",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            try { await invoke<void>("open_session_in_terminal", { sessionId }); }
            catch (err) { alert(`Failed to open terminal: ${err}`); }
          },
      disabledReason: isDraft ? "No active agent" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: ctx.isFrozen ? "play-circle" : "snowflake",
      label: ctx.isFrozen ? "Unfreeze chat" : "Freeze chat",
      run: isDraft || !sessionId || ctx.readOnly
        ? undefined
        : async () => {
            try {
              await invoke<void>(ctx.isFrozen ? "unfreeze_session" : "freeze_session", { sessionId });
            } catch (err) {
              alert(`Failed to ${ctx.isFrozen ? "unfreeze" : "freeze"} chat: ${err}`);
            }
            ctx.onAfterAction?.();
          },
      disabledReason: isDraft
        ? "Not available until the chat starts"
        : (!sessionId ? "No session" : (ctx.readOnly ? "Only available for interactive chats" : undefined)),
    },
    {
      icon: "git-diff",
      label: "View changes",
      run: ctx.viewChanges
        ? () => { ctx.viewChanges!(); }
        : undefined,
      disabledReason: !ctx.viewChanges
        ? (isDraft ? "No active agent" : "Open the chat to view changes")
        : undefined,
    },
  ];

  // ── Configure items (merged into Chat) ─────────────────────────────────────
  const autoOn = ctx.autoAcceptOn;
  const configureItems: ItemDesc[] = [
    {
      icon: "shield-check",
      label: "Auto-accept",
      isOn: autoOn,
      checkDot: autoOn,
      run: isDraft || !sessionId || ctx.isJarvis
        ? undefined
        : () => {
            const next = !isAutoAccept(sessionId);
            setAutoAccept(sessionId, next);
            if (next) autoAcceptParked(sessionId);
          },
      disabledReason: isDraft
        ? "Available once the chat starts"
        : (!sessionId ? "No session" : (ctx.isJarvis ? "Jarvis always auto-accepts" : undefined)),
    },
    {
      icon: "eye",
      label: "Show raw activity",
      isOn: !isDraft && !!sessionId && isRawViewEnabled(sessionId),
      checkDot: !isDraft && !!sessionId && isRawViewEnabled(sessionId),
      run: isDraft || !sessionId
        ? undefined
        : () => {
            const next = !isRawViewEnabled(sessionId);
            setRawViewEnabled(sessionId, next);
            if (state.renderer && state.renderer.sessionId === sessionId) {
              state.renderer.container.classList.toggle("show-raw-chat", next);
            }
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "user-switch",
      label: "Change character",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            const m = await import("./active-session");
            await m.changeCharacterForSession(sessionId);
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "user-circle",
      label: "Change account",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            const m = await import("./active-session");
            await m.changeAccountForSession(sessionId);
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
  ];
  const allChatItems = [...chatItems, ...configureItems];

  // ── Agent ▸ ────────────────────────────────────────────────────────────────
  const agentItems: ItemDesc[] = [
    {
      icon: "handshake",
      label: "Handoff to next AI",
      run: isDraft || !sessionId || !cwd
        ? undefined
        : async () => {
            await triggerHandoff(sessionId, cwd);
          },
      disabledReason: isDraft ? "No active agent" : (!sessionId ? "No session" : (!cwd ? "No project directory" : undefined)),
    },
    {
      icon: "copy",
      label: "Copy PID",
      run: ctx.pid
        ? () => { void navigator.clipboard.writeText(String(ctx.pid)); }
        : undefined,
      disabledReason: !ctx.pid ? (isDraft ? "No active agent" : "No active agent") : undefined,
    },
    {
      icon: "arrow-square-out",
      label: "Detach",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            try { await invoke<void>("detach_window", { sessionId }); }
            catch (err) { console.warn("[chat-menu] detach_window unavailable", err); }
          },
      disabledReason: isDraft ? "No active agent" : (!sessionId ? "No session" : undefined),
    },
  ];

  // ── Build submenus ──────────────────────────────────────────────────────────

  function appendSubMenu(parentBtn: HTMLButtonElement, items: ItemDesc[]): void {
    frag.appendChild(parentBtn);

    parentBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (parentBtn.classList.contains("is-disabled")) return;

      // Toggle: if already showing this sub, close it.
      const existingSub = document.querySelector<HTMLElement>(".chat-menu-submenu[data-sub-for]");
      if (existingSub && existingSub.dataset.subFor === parentBtn.dataset.subLabel) {
        closeSub();
        return;
      }

      const sub = document.createElement("div");
      sub.className = "session-more-menu smore-submenu chat-menu-submenu";
      sub.dataset.subFor = parentBtn.dataset.subLabel ?? "";

      for (const item of items) {
        const btn = makeItem(item);
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (btn.classList.contains("is-disabled")) return;
          closeSub();
          closeMenu();
          void item.run?.();
        });
        sub.appendChild(btn);
      }

      positionAndShowSubmenu(sub, parentBtn);
    });
  }

  appendSubMenu(makeSubParent("folder-open", "Open project in", openProjectItems), openProjectItems);
  appendSubMenu(makeSubParent("chat-dots", "Chat", allChatItems), allChatItems);
  appendSubMenu(makeSubParent("robot", "Agent", agentItems), agentItems);

  // ── Close / Delete draft ────────────────────────────────────────────────────
  const closeLabel = isDraft ? "Delete draft" : "Close session";
  const closeBtn = document.createElement("button");
  closeBtn.className = "smore-item smore-danger";
  closeBtn.innerHTML = `<i class="ph ph-x-circle"></i>${closeLabel}`;
  closeBtn.addEventListener("click", () => {
    closeSub();
    closeMenu();
    if (isDraft) {
      ctx.onDiscard?.();
    } else if (sessionId) {
      void closeChat(sessionId);
    }
  });
  frag.appendChild(closeBtn);

  return frag;
}

/** Must be called once to close the active submenu on outside clicks.
 * Call this at module level so it's registered once. */
document.addEventListener("click", (e) => {
  if (_activeSub && !_activeSub.contains(e.target as Node)) {
    closeSub();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _activeSub) closeSub();
});

/** Close the active submenu (exported so parent menus can call it on close). */
export function closeActiveChatSubmenu(): void {
  closeSub();
}
