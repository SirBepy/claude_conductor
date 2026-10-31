// Terse-but-drillable replies: a send_message text links `[23 tickets](#d:ids)`
// and attaches `details: [{id, label, body_md}]`. The link becomes a quiet chip
// whose click opens the body in a fixed-size card just above the message. A
// message that links an id it does not define resolves to the newest EARLIER
// definition in the chat, read straight from the rendered DOM (`data-details`
// on each defining bubble), so there is no second store to keep in sync across
// reload and history paging. The phone reuses the same card: no generic
// bottom-sheet exists to share (permission-modal's drag-handle sheet is
// specific to that modal).

import type { ChatDetail } from "./chat-details";
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
      // An open card is a child of this bubble; a `#d:` link in its body must
      // stay a plain link (its click handler only swallows navigation), not
      // turn into a chip that swaps the card for another detail mid-read.
      if (el.closest(".drill-pop")) continue;
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

const CARD_W = 460;
const CARD_H = 340;
const CARD_GAP = 8;
const CARD_EDGE = 8;

let open: { chip: HTMLElement; card: HTMLElement; close: () => void } | null = null;

/** Sizes the card (fixed height, so every detail has the same shape) and puts
 *  it directly above its message, left-aligned with it but kept inside the
 *  scroller. When the message has less than a card of content above it (the
 *  very top of the chat) it opens below instead. Then scrolls the chat so the
 *  whole card is on screen. */
function placeCard(card: HTMLElement, msg: HTMLElement, host: HTMLElement): void {
  const hr = host.getBoundingClientRect();
  const mr = msg.getBoundingClientRect();
  // clientWidth/clientLeft, not the rect's width: the rect includes the
  // scrollbar gutter, which the card (inside the scrolled content) never gets.
  const innerLeft = hr.left + host.clientLeft;
  const innerRight = innerLeft + host.clientWidth;
  const w = Math.min(CARD_W, host.clientWidth - 2 * CARD_EDGE);
  const h = Math.min(CARD_H, host.clientHeight - 2 * CARD_EDGE);
  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
  const left = Math.min(Math.max(mr.left, innerLeft + CARD_EDGE), innerRight - CARD_EDGE - w);
  card.style.left = `${left - mr.left}px`;

  const msgTopInContent = mr.top - hr.top + host.scrollTop;
  const below = msgTopInContent < h + CARD_GAP;
  card.classList.toggle("below", below);
  const cr = card.getBoundingClientRect();
  const deficit = below ? cr.bottom - (hr.bottom - CARD_EDGE) : hr.top + CARD_EDGE - cr.top;
  if (deficit > 0) host.scrollTop += below ? deficit : -deficit;
}

function openDrill(chip: HTMLElement, detail: ChatDetail, host: HTMLElement): void {
  const wasOpen = open?.chip === chip && open.card.isConnected;
  open?.close();
  const msg = chip.closest<HTMLElement>(".msg");
  if (wasOpen || !msg) return;
  const card = document.createElement("div");
  card.className = "drill-pop";
  card.tabIndex = -1;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", detail.label);
  card.innerHTML =
    `<div class="drill-pop-head"><span class="drill-pop-title"></span>` +
    `<button type="button" class="drill-pop-close" aria-label="Close"><i class="ph ph-x"></i></button></div>` +
    `<div class="drill-pop-body">${renderTextBlock(detail.body_md)}</div>`;
  card.querySelector(".drill-pop-title")!.textContent = detail.label;
  // Esc is scoped to the card (and the chip that opened it) so it never fights
  // the composer's own Esc handling while the user is typing.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
    chip.focus({ preventScroll: true });
  };
  const close = (): void => {
    card.remove();
    chip.removeEventListener("keydown", onKey);
    chip.setAttribute("aria-expanded", "false");
    if (open?.card === card) open = null;
  };
  card.querySelector(".drill-pop-close")!.addEventListener("click", () => {
    close();
    chip.focus({ preventScroll: true });
  });
  card.addEventListener("keydown", onKey);
  chip.addEventListener("keydown", onKey);
  // Links inside a detail body must not navigate the app away either.
  card.addEventListener("click", (e) => {
    if ((e.target as Element).closest('a[href^="#"]')) e.preventDefault();
  });
  // Child of the bubble, so it scrolls with the message and vanishes with it
  // when the bubble re-renders; the chat's own child list stays untouched.
  msg.appendChild(card);
  chip.setAttribute("aria-expanded", "true");
  open = { chip, card, close };
  placeCard(card, msg, host);
  card.focus({ preventScroll: true });
}

const chipOf = (e: Event) => (e.target as Element | null)?.closest<HTMLElement>(".drill-chip") ?? null;

export function handleDrillClick(e: MouseEvent): void {
  const chip = chipOf(e);
  const detail = chip && chipDetail.get(chip);
  if (!chip || !detail) return;
  e.preventDefault();
  openDrill(chip, detail, e.currentTarget as HTMLElement);
}

// A <button> opens on Enter/Space through its native click, so no keydown
// handler is needed; this only keeps a stray `#d:` anchor from navigating.
export function handleDrillAnchorClick(e: MouseEvent): void {
  const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#d:"]');
  if (a) e.preventDefault();
}
