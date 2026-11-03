// Settings as a centered popup over the chat (Joe, 2026-11-02), instead of a
// full-screen view. Only the desktop Chats window does this: the phone and the
// pop-out windows keep the router views.
//
// The popup does not change the active view: the Chats view stays mounted
// underneath. The router still owns the views' render functions, so it hands
// each one in here (showInSettingsPopup) rather than this module importing the
// router, whose import chain already reaches this file.

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
  // the card and owns its own Tab order. Focus on <body> is ours to pull back in.
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
  window.addEventListener("keydown", onKey);
  bd.querySelector<HTMLElement>(".settings-popup")!.focus({ preventScroll: true });
}
