// Shared "This chat" action block used by:
//   - view-more-menu.ts  (top-right viewMore dropdown, "THIS CHAT" section)
//   - sidebar-ctx-menu.ts (per-row 3-dot context menu)
//
// Returns a built DOM fragment; caller appends it into the parent container.

import { closeChat } from "./close-chat";
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
