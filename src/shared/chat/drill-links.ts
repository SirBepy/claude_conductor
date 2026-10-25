// Terse-but-drillable replies: a send_message text links `[23 tickets](#d:ids)`
// and attaches `details: [{id, label, body_md}]`. The link becomes a quiet chip
// whose click opens the body in an anchored popover. A message that links an id
// it does not define resolves to the newest EARLIER definition in the chat, read
// straight from the rendered DOM (`data-details` on each defining bubble), so
// there is no second store to keep in sync across reload and history paging.
// The phone reuses the same popover: no generic bottom-sheet exists to share
// (permission-modal's drag-handle sheet is specific to that modal).

import type { ChatDetail } from "./chat-details";
import { openAnchoredPopover, type AnchoredPopoverHandle } from "./anchored-popover";
import { renderTextBlock } from "./chat-transforms";

const parsed = new WeakMap<Element, ChatDetail[]>();
const chipDetail = new WeakMap<Element, ChatDetail>();

function detailsOf(msg: Element): ChatDetail[] {
  let d = parsed.get(msg);
  if (!d) {
    try {
      const raw = JSON.parse(msg.getAttribute("data-details") ?? "[]");
      d = Array.isArray(raw) ? (raw as ChatDetail[]) : [];
    } catch {
      d = [];
    }
    parsed.set(msg, d);
  }
  return d;
}

function resolve(id: string, msg: Element, container: ParentNode): ChatDetail | null {
  const own = detailsOf(msg).find((d) => d.id === id);
  if (own) return own;
  const defs = Array.from(container.querySelectorAll(".msg[data-details]"));
  for (let i = defs.length - 1; i >= 0; i--) {
    const el = defs[i]!;
    if (el === msg || !(msg.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    const hit = detailsOf(el).find((d) => d.id === id);
    if (hit) return hit;
  }
  return null;
}

/** Turns `<a href="#d:id">` in assistant bubbles into drill chips. An id with
 *  no definition degrades to a plain-looking span that keeps its id, so a later
 *  run (history paging loads the defining message) can upgrade it to a chip. */
export function linkifyDrillRefs(root: HTMLElement, container: ParentNode = root): void {
  const scope = root.matches(".msg.assistant") ? [root] : Array.from(root.querySelectorAll<HTMLElement>(".msg.assistant"));
  for (const msg of scope) {
    const pending = Array.from(msg.querySelectorAll<HTMLElement>("span.drill-pending[data-d]"));
    for (const el of [...Array.from(msg.querySelectorAll<HTMLAnchorElement>('a[href^="#d:"]')), ...pending]) {
      const id = el instanceof HTMLAnchorElement ? (el.getAttribute("href") ?? "").slice(3) : (el.dataset.d ?? "");
      const detail = resolve(id, msg, container);
      if (!detail) {
        if (el instanceof HTMLAnchorElement) {
          const span = document.createElement("span");
          span.className = "drill-pending";
          span.dataset.d = id;
          span.textContent = el.textContent;
          el.replaceWith(span);
        }
        continue;
      }
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "drill-chip";
      chip.dataset.d = id;
      chip.setAttribute("aria-expanded", "false");
      chip.textContent = el.textContent;
      chipDetail.set(chip, detail);
      el.replaceWith(chip);
    }
  }
}

let open: { chip: HTMLElement; handle: AnchoredPopoverHandle } | null = null;

function openDrill(chip: HTMLElement, detail: ChatDetail): void {
  const wasOpen = open?.chip === chip;
  open?.handle.close();
  if (wasOpen) return;
  const pop = document.createElement("div");
  pop.className = "drill-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", detail.label);
  pop.innerHTML = `<div class="drill-pop-title"></div>${renderTextBlock(detail.body_md)}`;
  pop.querySelector(".drill-pop-title")!.textContent = detail.label;
  // Links inside a detail body must not navigate the app away either.
  pop.addEventListener("click", (e) => {
    if ((e.target as Element).closest('a[href^="#"]')) e.preventDefault();
  });
  document.body.appendChild(pop);
  chip.setAttribute("aria-expanded", "true");
  const handle = openAnchoredPopover({
    anchor: chip,
    el: pop,
    onClose: () => {
      pop.remove();
      chip.setAttribute("aria-expanded", "false");
      if (open?.handle === handle) open = null;
    },
  });
  open = { chip, handle };
  handle.reposition();
}

const chipOf = (e: Event) => (e.target as Element | null)?.closest<HTMLElement>(".drill-chip") ?? null;

export function handleDrillClick(e: MouseEvent): void {
  const chip = chipOf(e);
  const detail = chip && chipDetail.get(chip);
  if (!chip || !detail) return;
  e.preventDefault();
  openDrill(chip, detail);
}

// A <button> opens on Enter/Space through its native click, so no keydown
// handler is needed; this only keeps a stray `#d:` anchor from navigating.
export function handleDrillAnchorClick(e: MouseEvent): void {
  const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#d:"]');
  if (a) e.preventDefault();
}
