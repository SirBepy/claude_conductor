/**
 * The asker picker's in-place patch, shared by the question card and the secret
 * card. Another chat asking (or settling) must change the picker under Joe's
 * cursor without rebuilding the card, so the strip is reconciled by chip instead of
 * replaced: a chip that stays keeps its node (and so its hover and focus), a new
 * one fades in, a gone one fades out and the others slide into its gap, and the
 * whole strip opens or closes by rows (0fr <-> 1fr). Nothing here runs on the
 * card's first render, which draws the strip as it is.
 */

import { afterPaint } from "../../../shared/after-paint";
import { askersStripHtml } from "./question-ui-templates";
import type { AskerChip } from "./types";

// Mirrors --motion-fast / --motion-base (tokens.css) in permission-modal-askers.css.
const CHIP_MS = 150;
const STRIP_MS = 200;

// Two frames so the start state is painted once; afterPaint also runs it when frames are paused.
const nextFrame = (fn: () => void): void => afterPaint(fn, 2);

function parse(html: string): HTMLElement | null {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl.content.firstElementChild as HTMLElement | null;
}

function chipsOf(row: Element): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(":scope > .prompt-asker")];
}

/** Slides every chip still on screen from where it was to where it is, so a chip
 *  that came or went moves its neighbours by a transition instead of a jump. */
function flip(row: HTMLElement, before: Map<string, DOMRect>): void {
  for (const chip of chipsOf(row)) {
    const was = before.get(chip.dataset.asker ?? "");
    if (!was || chip.classList.contains("is-leaving")) continue;
    const now = chip.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (!dx && !dy) continue;
    chip.style.transition = "none";
    chip.style.transform = `translate(${dx}px, ${dy}px)`;
    chip.getBoundingClientRect();
    chip.style.transition = "";
    chip.style.transform = "";
  }
}

function reconcile(row: HTMLElement, nextRow: HTMLElement): void {
  const before = new Map(chipsOf(row).map((c) => [c.dataset.asker ?? "", c.getBoundingClientRect()]));
  const live = new Map(chipsOf(row).filter((c) => !c.classList.contains("is-leaving")).map((c) => [c.dataset.asker ?? "", c]));
  const wanted = chipsOf(nextRow);
  const wantedKeys = new Set(wanted.map((c) => c.dataset.asker ?? ""));
  // The next chip that is meant to stay, skipping any still fading out.
  const stayingFrom = (el: Element | null): Element | null => {
    while (el?.classList.contains("is-leaving")) el = el.nextElementSibling;
    return el;
  };
  let cursor = stayingFrom(row.firstElementChild);
  let added = false;
  for (const fresh of wanted) {
    const have = live.get(fresh.dataset.asker ?? "");
    let el: HTMLElement = fresh;
    if (have) {
      el = have;
      // Same chip, new numbers: only touch what changed, so a hovered chip keeps its state.
      // A chip still fading in keeps its is-new class, or a patch inside the fade would snap it.
      const cls = have.classList.contains("is-new") ? `${fresh.className} is-new` : fresh.className;
      if (have.className !== cls) have.className = cls;
      if (have.title !== fresh.title) have.title = fresh.title;
      if (have.getAttribute("aria-pressed") !== fresh.getAttribute("aria-pressed")) have.setAttribute("aria-pressed", fresh.getAttribute("aria-pressed") ?? "false");
      if (have.innerHTML !== fresh.innerHTML) have.innerHTML = fresh.innerHTML;
    } else {
      fresh.classList.add("is-new");
      fresh.addEventListener("animationend", () => fresh.classList.remove("is-new"), { once: true });
      added = true;
    }
    if (el === cursor) cursor = stayingFrom(el.nextElementSibling);
    else row.insertBefore(el, cursor);
  }
  let left = false;
  for (const [key, chip] of live) {
    if (wantedKeys.has(key)) continue;
    left = true;
    chip.classList.add("is-leaving");
    chip.setAttribute("tabindex", "-1");
    setTimeout(() => {
      const rects = new Map(chipsOf(row).map((c) => [c.dataset.asker ?? "", c.getBoundingClientRect()]));
      chip.remove();
      flip(row, rects);
    }, CHIP_MS);
  }
  if (added && !left) flip(row, before);
}

/**
 * Brings `card`'s picker in line with `chips`: opens it, patches it, or closes it.
 * `onPick` is wired once per chip click (the buttons are delegated through the row,
 * so a reconciled chip needs no new listener). Returns whether a strip now shows,
 * which the caller needs to hide or restore its own "from" chip.
 */
export function patchAskersStrip(
  card: HTMLElement,
  chips: AskerChip[] | null,
  onPick: (askerId: string) => void,
): boolean {
  const html = askersStripHtml(chips);
  const wrap = card.querySelector<HTMLElement>(":scope > .prompt-askers-wrap");
  if (!html) {
    if (!wrap || wrap.classList.contains("is-closing")) return false;
    wrap.classList.add("is-closing");
    const drop = (): void => { if (wrap.classList.contains("is-closing")) wrap.remove(); };
    wrap.addEventListener("transitionend", (e) => { if (e.target === wrap) drop(); }, { once: true });
    setTimeout(drop, STRIP_MS + 120);
    return false;
  }
  const next = parse(html);
  if (!next) return true;
  if (!wrap) {
    next.classList.add("is-opening");
    card.querySelector(".prompt-card__handle")?.after(next);
    wireRow(next, onPick);
    // Two frames: the 0fr state has to be painted once or the browser skips the transition.
    nextFrame(() => next.classList.remove("is-opening"));
    return true;
  }
  // Coming back while it was closing reverses the same transition from where it is.
  wrap.classList.remove("is-closing");
  const row = wrap.querySelector<HTMLElement>(".prompt-askers__row");
  const nextRow = next.querySelector<HTMLElement>(".prompt-askers__row");
  if (row && nextRow) reconcile(row, nextRow);
  wireRow(wrap, onPick);
  return true;
}

/** One delegated click listener per strip (a re-wire replaces, never stacks). */
const wired = new WeakMap<Element, (e: Event) => void>();
export function wireRow(wrap: HTMLElement, onPick: (askerId: string) => void): void {
  const row = wrap.querySelector<HTMLElement>(".prompt-askers__row");
  if (!row) return;
  const prev = wired.get(row);
  if (prev) row.removeEventListener("click", prev);
  const handler = (e: Event): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".prompt-asker");
    const id = btn?.dataset.asker;
    if (id && btn && !btn.classList.contains("is-active") && !btn.classList.contains("is-leaving")) onPick(id);
  };
  wired.set(row, handler);
  row.addEventListener("click", handler);
}
