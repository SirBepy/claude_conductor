// Wires the .menu-anchor/.menu-popover/.menu-item click-toggle + dismiss-on-
// outside-click idiom shared by characters and the settings accounts row
// (todo 204). Toggles the `.hidden` class - accounts.ts's per-row popovers
// use a `hidden` attribute + close-others-on-open instead, so they keep
// their own wiring and only share the CSS.

const EDGE = 4;
const ANCHOR_GAP = 4; // matches `top: calc(100% + 4px)` in kebab-menu.css

/** Keeps an open `.menu-popover` (absolutely placed under its `.menu-anchor`,
 *  right-aligned) inside the viewport: shifts it sideways off an edge, and
 *  opens it upward or scrolls it when the bottom edge is too close. Uses the
 *  layout offsets, not getBoundingClientRect, so the open animation's scale
 *  does not skew the measure; `translate` composes with that animation's
 *  `transform` instead of replacing it. */
export function keepKebabMenuOnScreen(menu: HTMLElement): void {
  const parent = menu.offsetParent as HTMLElement | null;
  if (!parent) return;
  menu.style.translate = "";
  menu.style.top = "";
  menu.style.bottom = "";
  menu.style.maxHeight = "";
  const pr = parent.getBoundingClientRect();
  const left = pr.left + parent.clientLeft + menu.offsetLeft;
  const w = menu.offsetWidth;
  let dx = 0;
  if (left + w > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - (left + w);
  if (left + dx < EDGE) dx = EDGE - left;
  if (dx) menu.style.translate = `${dx}px 0`;
  const top = pr.top + parent.clientTop + menu.offsetTop;
  const spaceBelow = window.innerHeight - EDGE - top;
  if (menu.offsetHeight <= spaceBelow) return;
  const spaceAbove = pr.top - ANCHOR_GAP - EDGE;
  if (spaceAbove > spaceBelow) {
    menu.style.top = "auto";
    menu.style.bottom = `calc(100% + ${ANCHOR_GAP}px)`;
    menu.style.maxHeight = `${Math.max(80, spaceAbove)}px`;
  } else {
    menu.style.maxHeight = `${Math.max(80, spaceBelow)}px`;
  }
  menu.style.overflowY = "auto";
}

/** Wires `button` to toggle `menu`'s `.hidden` class, dismiss it on outside
 *  click or Escape (restoring focus to `button`), and stamp the shared menu
 *  a11y attributes. Returns a dispose function that removes the document
 *  listeners (call it from view teardown if the view unmounts). */
export function wireKebabMenu(button: HTMLElement, menu: HTMLElement): () => void {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  menu.setAttribute("role", "menu");
  menu.querySelectorAll(".menu-item").forEach((item) => item.setAttribute("role", "menuitem"));

  const isOpen = () => !menu.classList.contains("hidden");
  const items = () => Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
  const setOpen = (open: boolean) => {
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (open) keepKebabMenuOnScreen(menu);
  };

  const onDocClick = (e: MouseEvent) => {
    if (!isOpen()) return;
    const target = e.target as Node;
    if (menu.contains(target) || button.contains(target)) return;
    setOpen(false);
  };
  // Gated on isOpen() rather than added/removed per open state, so it never
  // shadows an unrelated Escape (e.g. a modal) while the menu is closed.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      setOpen(false);
      button.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      const current = list.indexOf(document.activeElement as HTMLElement);
      const next = (current + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    }
  };

  button.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    setOpen(!isOpen());
    if (isOpen()) items()[0]?.focus();
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeyDown);
  return () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}

/** Hides the menu - call from a `.menu-item` click handler. */
export function closeKebabMenu(menu: HTMLElement): void {
  menu.classList.add("hidden");
  menu.closest(".menu-anchor")
    ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
    ?.setAttribute("aria-expanded", "false");
}
