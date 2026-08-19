// Collapses the phone's two header bands into one (todo 702): with the static
// "Chats" title and the dials hidden, `.view-header` holds only a back button
// and a ⋮, which move into `.session-header`'s slots. Nodes are RELOCATED, not
// re-created - listeners bind by id, and the ⋮ menu anchors to its own button.

import { isMobileViewport, onMobileViewportChange } from "../../shared/mobile-viewport";

const BACK_ID = "sessionsBackBtn";
const MORE_ID = "viewMoreBtn";

/** Where each button sits on desktop, so it can go home again. */
interface Home {
  parent: HTMLElement;
  next: ChildNode | null;
}

const homes = new Map<string, Home>();

function rememberHome(el: HTMLElement): void {
  if (homes.has(el.id) || !el.parentElement) return;
  homes.set(el.id, { parent: el.parentElement, next: el.nextSibling });
}

function goHome(el: HTMLElement): void {
  const home = homes.get(el.id);
  if (!home || el.parentElement === home.parent) return;
  home.parent.insertBefore(el, home.next);
}

/** Idempotent: safe to call on every pane render and every breakpoint change. */
export function applyHeaderMerge(root: ParentNode = document): void {
  const back = root.querySelector<HTMLElement>(`#${BACK_ID}`);
  const more = root.querySelector<HTMLElement>(`#${MORE_ID}`);
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

/** Re-runs the merge when the viewport crosses the breakpoint. */
export function initHeaderMerge(root: ParentNode = document): () => void {
  applyHeaderMerge(root);
  return onMobileViewportChange(() => applyHeaderMerge(root));
}
