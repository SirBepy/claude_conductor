// Collapses the phone's two header bands into one (todo 702): with the static
// "Chats" title and the dials hidden, `.view-header` holds only a back button
// and a ⋮, which move into `.session-header`'s slots. Nodes are RELOCATED, not
// re-created - listeners bind by id, and the ⋮ menu anchors to its own button.

import { isMobileViewport, onMobileViewportChange } from "../../shared/mobile-viewport";

const BACK_ID = "sessionsBackBtn";
const MORE_ID = "viewMoreBtn";

/** The live button plus where it sits on desktop, so it can go home again. */
interface Home {
  el: HTMLElement;
  parent: HTMLElement;
  next: ChildNode | null;
}

const homes = new Map<string, Home>();

function isSlot(el: HTMLElement): boolean {
  return el.classList.contains("session-header-lead")
    || el.classList.contains("session-header-trail");
}

/** Re-read on every pass: a view re-render builds a fresh `.view-header`, and
 *  a home still pointing at the previous, detached one would file the live
 *  button away where nothing can show it. */
function rememberHome(el: HTMLElement): void {
  const parent = el.parentElement;
  if (!parent || isSlot(parent)) {
    const prev = homes.get(el.id);
    if (prev) prev.el = el;
    return;
  }
  homes.set(el.id, { el, parent, next: el.nextSibling });
}

function goHome(el: HTMLElement): void {
  const home = homes.get(el.id);
  if (!home || el.parentElement === home.parent) return;
  if (!home.parent.isConnected) {
    homes.delete(el.id);
    return;
  }
  home.parent.insertBefore(el, home.next?.parentNode === home.parent ? home.next : null);
}

/** Every `pane.innerHTML = ...` rebuild destroys the `.session-header` a
 *  relocated button was living in, so fall back to the node we kept - it still
 *  carries the listeners bound at mount. */
function findButton(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`) ?? homes.get(id)?.el ?? null;
}

/** Idempotent: safe to call on every pane render and every breakpoint change. */
export function applyHeaderMerge(root: ParentNode = document): void {
  const back = findButton(root, BACK_ID);
  const more = findButton(root, MORE_ID);
  if (back) rememberHome(back);
  if (more) rememberHome(more);

  const header = root.querySelector<HTMLElement>(".session-header");
  const lead = header?.querySelector<HTMLElement>(".session-header-lead");
  const trail = header?.querySelector<HTMLElement>(".session-header-trail");

  // No pane header yet (empty state, or the sessions list): leave the buttons
  // where they are rather than orphaning them.
  if (!isMobileViewport() || !lead || !trail) {
    if (back) goHome(back);
    if (more) goHome(more);
    return;
  }
  if (back && back.parentElement !== lead) lead.appendChild(back);
  if (more && more.parentElement !== trail) trail.appendChild(more);
}

let unsubscribe: (() => void) | null = null;

/** Re-runs the merge when the viewport crosses the breakpoint. One live
 *  subscription only - a leaked one from a prior mount holds that mount's
 *  detached root and would re-home the buttons out of the visible header. */
export function initHeaderMerge(root: ParentNode = document): () => void {
  unsubscribe?.();
  applyHeaderMerge(root);
  const dispose = onMobileViewportChange(() => applyHeaderMerge(root));
  unsubscribe = dispose;
  return () => {
    dispose();
    if (unsubscribe === dispose) unsubscribe = null;
  };
}
