// "This chat" action blocks, each a DOM fragment the caller appends:
//   - buildChatMenuBlock: view-more-menu.ts (the phone header's viewMore
//     dropdown, "THIS CHAT" section), with submenus
//   - buildRowMenuBlock: sidebar-ctx-menu.ts (the sidebar row's right-click
//     menu), four flat items

import { closeChat } from "./close-chat";
import { positionSubmenu } from "./position-dropdown";
import {
  buildOpenProjectItems,
  buildChatItems,
  buildConfigureItems,
  buildAgentItems,
  type ChatMenuCtx,
  type ItemDesc,
} from "./chat-menu-items";

export type { ChatMenuCtx };

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
  positionSubmenu(sub, parentItem);
}

// ── Build helper ─────────────────────────────────────────────────────────────

function makeItem(desc: ItemDesc): HTMLButtonElement {
  const btn = document.createElement("button");
  const classes = ["smore-item"];
  if (desc.danger) classes.push("smore-danger");
  if (desc.isOn) classes.push("is-on");
  if (desc.children) classes.push("smore-has-sub");
  else if (!desc.run || desc.disabledReason) classes.push("is-disabled");
  btn.className = classes.join(" ");
  if (desc.disabledReason) btn.title = desc.disabledReason;
  btn.innerHTML =
    `<i class="ph ph-${desc.icon}"></i>${desc.label}` +
    (desc.checkDot ? `<span class="smore-check-dot"></span>` : "") +
    (desc.children ? `<i class="ph ph-caret-right smore-sub-caret"></i>` : "");
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

  // Each submenu's items are assembled in chat-menu-items.ts (todo 972 split);
  // this file only wires the resulting ItemDesc[] into DOM + click handling.
  const openProjectItems = buildOpenProjectItems(ctx);
  const allChatItems = [...buildChatItems(ctx), ...buildConfigureItems(ctx)];
  const agentItems = buildAgentItems(ctx);

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

  frag.appendChild(makeCloseItem(ctx, closeMenu));

  return frag;
}

// ── Close / Delete draft ──────────────────────────────────────────────────────

function makeCloseItem(ctx: ChatMenuCtx, closeMenu: () => void): HTMLButtonElement {
  const closeBtn = document.createElement("button");
  closeBtn.className = "smore-item smore-danger";
  closeBtn.innerHTML = `<i class="ph ph-x-circle"></i>${ctx.kind === "draft" ? "Delete draft" : "Close session"}`;
  closeBtn.addEventListener("click", () => {
    closeSub();
    closeMenu();
    if (ctx.kind === "draft") {
      ctx.onDiscard?.();
    } else if (ctx.sessionId) {
      void closeChat(ctx.sessionId);
    }
  });
  return closeBtn;
}

/**
 * The sidebar row's right-click menu: four flat items, no submenus (Joe,
 * 2026-11-09): Copy PID, Freeze, Hide, Close. A draft row has no process to
 * freeze or hide, so it gets only Delete draft. A pinned sub's row also gets
 * Unpin from sidemenu (the chat menu is the only other place to unpin). Items come from the same
 * builders as the full menu, so their labels, disabled reasons and actions
 * cannot drift from it.
 */
export function buildRowMenuBlock(ctx: ChatMenuCtx, closeMenu: () => void): HTMLElement {
  const frag = document.createElement("div");
  frag.className = "chat-menu-block";

  if (ctx.kind === "live") {
    const chatItems = buildChatItems(ctx);
    const picks = [
      buildAgentItems(ctx).find((i) => i.label === "Copy PID"),
      chatItems.find((i) => /freeze chat$/i.test(i.label)),
      chatItems.find((i) => /hide chat$/i.test(i.label)),
      // Only a pinned sub's row is in the sidemenu because of the pin, so only it needs the way out.
      ctx.isSub && ctx.isPinned ? chatItems.find((i) => i.label === "Unpin from sidemenu") : undefined,
    ];
    for (const item of picks) {
      if (!item) continue;
      const btn = makeItem(item);
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (btn.classList.contains("is-disabled")) return;
        closeMenu();
        void item.run?.();
      });
      frag.appendChild(btn);
    }
  }

  frag.appendChild(makeCloseItem(ctx, closeMenu));
  return frag;
}

/**
 * A flat block of items from any ItemDesc list, for menus that are not the
 * "This chat" one: the dashboard's Subchats card right-click menu builds its
 * items in chat-menu-items.ts and gets the same look, disabled reasons and
 * danger styling as every other chat menu here.
 */
export function buildItemsBlock(items: ItemDesc[], closeMenu: () => void): HTMLElement {
  const frag = document.createElement("div");
  frag.className = "chat-menu-block";
  for (const item of items) {
    const btn = makeItem(item);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (item.children) {
        openChildren(btn, item.children, closeMenu);
        return;
      }
      if (btn.classList.contains("is-disabled")) return;
      closeMenu();
      void item.run?.();
    });
    frag.appendChild(btn);
  }
  return frag;
}

/** The submenu of an item that has `children`, beside its parent. Picking a child closes
 *  both levels; a disabled child only shows its reason. */
function openChildren(parent: HTMLElement, children: ItemDesc[], closeMenu: () => void): void {
  const sub = document.createElement("div");
  sub.className = "session-more-menu smore-submenu chat-menu-submenu";
  sub.dataset.subFor = parent.textContent ?? "";
  for (const child of children) {
    const btn = makeItem(child);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (btn.classList.contains("is-disabled")) return;
      closeSub();
      closeMenu();
      void child.run?.();
    });
    sub.appendChild(btn);
  }
  positionAndShowSubmenu(sub, parent);
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
