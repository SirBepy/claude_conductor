// Settings as a centered popup over the chat (Joe, 2026-11-02), instead of a
// full-screen view. Only the desktop Chats window does this: the phone and the
// pop-out windows keep the router views.
//
// The popup does not change the active view: the Chats view stays mounted
// underneath. The router still owns the views' render functions, so it hands
// each one in here (showInSettingsPopup) rather than this module importing the
// router, whose import chain already reaches this file.

import { lockInputToHost } from "./modal-input-lock";
import { isTextEntryElement } from "./text-entry";
import { isRemote } from "./transport";
import { isChatsWindow } from "./window-roles";
import "./settings-popup.css";

type RenderFn = (root: HTMLElement) => void | Promise<void> | (() => void) | Promise<() => void>;

/** Router views that live inside the popup: Settings, every subpage, and the
 *  skill / character pages that hang off it (app-rail.ts's railActiveFor). */
export function opensInSettingsPopup(view: string): boolean {
  if (isRemote() || !isChatsWindow()) return false;
  return (
    view === "settings" ||
    view.startsWith("settings-") ||
    view === "characters" ||
    view === "character-detail" ||
    view === "skills" ||
    view === "skill-detail"
  );
}

/** Skills and Characters head their page with a burger, which opens a side
 *  menu the Chats window does not have; the popup swaps it for a way back. */
const BURGER_PAGES = new Set(["skills", "characters"]);

let backdrop: HTMLElement | null = null;
let viewRoot: HTMLElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let teardown: (() => void) | null = null;
let seq = 0;
let returnFocus: HTMLElement | null = null;
let navigateBack: (() => void) | null = null;
let unlockInput: (() => void) | null = null;
const listeners = new Set<() => void>();

export function isSettingsPopupOpen(): boolean {
  return backdrop !== null;
}

/** The rail repaints its pressed entry from this. */
export function onSettingsPopupChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Renders `view` into the popup, opening it first when it is closed. Resolves
 *  once the view has rendered (or was superseded / closed meanwhile). */
export async function showInSettingsPopup(view: string, render: RenderFn, goTo: (view: string) => void): Promise<void> {
  const opening = backdrop === null;
  if (opening) {
    open();
    notify();
  }
  const card = backdrop!.querySelector<HTMLElement>(".settings-popup")!;
  const mine = ++seq;

  teardown?.();
  teardown = null;
  // A fresh root per page: lit remembers what it rendered into a node, and the
  // views mix lit and innerHTML.
  viewRoot?.remove();
  const root = document.createElement("div");
  root.className = "settings-popup-view v-enter";
  root.dataset.view = view;
  card.appendChild(root);
  viewRoot = root;
  card.dataset.view = view;
  backBtn!.hidden = !BURGER_PAGES.has(view);
  navigateBack = () => goTo("settings");

  const result = await render(root);
  const fn = typeof result === "function" ? result : null;
  // Closed, or another page took over, while this one was loading.
  if (mine !== seq || backdrop === null) fn?.();
  else teardown = fn;
}

export function closeSettingsPopup(): void {
  if (!backdrop) return;
  seq++;
  teardown?.();
  teardown = null;
  window.removeEventListener("keydown", onKey);
  unlockInput?.();
  unlockInput = null;
  backdrop.remove();
  backdrop = null;
  viewRoot = null;
  backBtn = null;
  navigateBack = null;
  const back = returnFocus;
  returnFocus = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
  notify();
}

/** Locks background input to the backdrop and to whatever a page puts on top of
 *  it. A popover appended to <body> (the device icon picker) focuses its first
 *  button the moment it opens, before anything could register it as a host, so
 *  the lock's focus half would blur it and leave its Arrow keys dead. This
 *  adopts any later <body> child the focus lands in, ahead of that blur. */
function lockPopupInput(bd: HTMLElement): () => void {
  const unlockBackdrop = lockInputToHost(bd);
  const adopted = new Map<HTMLElement, () => void>();
  const onFocusIn = (e: FocusEvent): void => {
    let top: Node | null = e.target instanceof Node ? e.target : null;
    while (top && top.parentNode !== document.body) top = top.parentNode;
    if (!(top instanceof HTMLElement) || top === bd || adopted.has(top)) return;
    if (!(bd.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    adopted.set(top, lockInputToHost(top));
  };
  const release = (el: HTMLElement): void => {
    adopted.get(el)?.();
    adopted.delete(el);
  };
  const removals = new MutationObserver(() => {
    for (const el of [...adopted.keys()]) if (!el.isConnected) release(el);
  });
  removals.observe(document.body, { childList: true });
  // Capture phase on window runs ahead of the lock's own document-level focusin.
  window.addEventListener("focusin", onFocusIn, true);
  return () => {
    window.removeEventListener("focusin", onFocusIn, true);
    removals.disconnect();
    for (const el of [...adopted.keys()]) release(el);
    unlockBackdrop();
  };
}

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Tab stops in DOM order. A hidden control (the Back button on the settings
 *  index) has no client rects, so it drops out without a separate check. */
function tabStops(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.matches(":disabled") && el.getClientRects().length > 0,
  );
}

/** Keeps Tab / Shift+Tab inside the card: the chat and the rail behind the
 *  backdrop are still in the document, so the browser would walk onto them. */
function trapTab(e: KeyboardEvent, card: HTMLElement): void {
  const target = e.target instanceof Node ? e.target : null;
  // A modal opened from a page (a confirm, the add-account wizard) sits outside
  // the card and owns its own Tab order.
  if (target && target !== document.body && target !== document.documentElement && !card.contains(target)) return;
  const stops = tabStops(card);
  if (stops.length === 0) {
    e.preventDefault();
    card.focus({ preventScroll: true });
    return;
  }
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !card.contains(active) || active === card;
  if (e.shiftKey && (outside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (outside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/** Window bubble phase, so a modal opened from a page (a confirm, the add-account
 *  wizard) that handles Escape on `document` gets it first and claims it. */
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (e.key === "Tab") {
    const card = backdrop?.querySelector<HTMLElement>(".settings-popup");
    if (card) trapTab(e, card);
    return;
  }
  if (e.key !== "Escape") return;
  e.preventDefault();
  // Escape in a field first leaves the field (the field's own handler, which
  // runs before this one, has already reverted an unsaved edit); the next
  // Escape closes the popup.
  const active = document.activeElement;
  if (active instanceof HTMLElement && isTextEntryElement(active) && backdrop?.contains(active)) {
    active.blur();
    return;
  }
  closeSettingsPopup();
}

function open(): void {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const bd = document.createElement("div");
  bd.className = "settings-popup-backdrop";
  bd.innerHTML =
    `<div class="settings-popup" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">` +
    `<button type="button" class="icon-btn settings-popup-back" title="Back" aria-label="Back" hidden>` +
    `<i class="ph ph-arrow-left"></i></button>` +
    `<button type="button" class="icon-btn settings-popup-close" title="Close" aria-label="Close settings">` +
    `<i class="ph ph-x"></i></button>` +
    `</div>`;
  // A drag that starts in the card and ends on the backdrop (selecting text) is not a dismissal.
  let downOnBackdrop = false;
  bd.addEventListener("pointerdown", (e) => {
    downOnBackdrop = e.target === bd;
  });
  bd.addEventListener("click", (e) => {
    if (e.target === bd && downOnBackdrop) closeSettingsPopup();
  });
  backBtn = bd.querySelector<HTMLButtonElement>(".settings-popup-back")!;
  backBtn.addEventListener("click", () => navigateBack?.());
  bd.querySelector(".settings-popup-close")!.addEventListener("click", () => closeSettingsPopup());
  document.body.appendChild(bd);
  backdrop = bd;
  // The popup leaves the Chats view active, so without the lock the chat's
  // sessions-context shortcuts (close chat, new chat) keep firing behind it.
  unlockInput = lockPopupInput(bd);
  window.addEventListener("keydown", onKey);
  bd.querySelector<HTMLElement>(".settings-popup")!.focus({ preventScroll: true });
}
