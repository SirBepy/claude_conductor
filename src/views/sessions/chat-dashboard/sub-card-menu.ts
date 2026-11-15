// The Subchats card's right-click menu on an avatar. The items come from
// chat-menu-items.ts (buildSubCardItems) and the block from chat-menu.ts
// (buildItemsBlock), so the look, disabled reasons and danger styling are the
// chat menu's own; only the popup shell around them lives here.

import { invoke } from "../../../shared/ipc";
import { positionDropdown } from "../position-dropdown";
import { buildItemsBlock } from "../chat-menu";
import { buildSubCardItems, type SubCardMenuCtx } from "../chat-menu-items";
import "../session-ctx-menu.css";

let active: HTMLElement | null = null;

export interface PreviewRef { slug: string; title: string }

/** The newest preview `subId` pushed in `mainId`'s family, or null. */
export async function latestSubPreview(mainId: string, subId: string): Promise<PreviewRef | null> {
  try {
    const list = await invoke<Array<{ slug: string; title: string; session_id: string | null }>>("list_previews", { sessionId: mainId });
    // The list is newest first, so the first match is the latest.
    const hit = (Array.isArray(list) ? list : []).find((m) => m.session_id === subId);
    return hit ? { slug: hit.slug, title: hit.title } : null;
  } catch {
    return null;
  }
}

export function closeSubCardMenu(): void {
  active?.remove();
  active = null;
}

/** Opens the menu under `ctx.anchor`. One at a time: a second open closes the first. */
export function openSubCardMenu(ctx: SubCardMenuCtx): HTMLElement {
  closeSubCardMenu();
  const menu = document.createElement("div");
  menu.className = "session-ctx-menu sx-menu";
  menu.dataset.sub = ctx.subId;
  menu.appendChild(buildItemsBlock(buildSubCardItems(ctx), closeSubCardMenu));
  document.body.appendChild(menu);
  active = menu;
  positionDropdown(menu, ctx.anchor, { align: "left" });
  return menu;
}

// Closes on an outside click or Escape. Wired once at module load, like
// sidebar-ctx-menu.ts, so no caller has to remember to.
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    // A nested submenu (chat-menu.ts openChildren) lives on the body, outside this menu, but a click
    // in it is a click in the menu: closing here would strand the submenu a disabled child left open.
    const target = e.target as HTMLElement;
    if (active && !active.contains(target) && !target.closest?.(".chat-menu-submenu")) closeSubCardMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active) closeSubCardMenu();
  });
}
