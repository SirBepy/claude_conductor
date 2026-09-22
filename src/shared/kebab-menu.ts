// Wires the .menu-anchor/.menu-popover/.menu-item click-toggle + dismiss-on-
// outside-click idiom shared by project-detail/session-detail/characters
// (todo 204). Toggles the `.hidden` class - accounts.ts's per-row popovers
// use a `hidden` attribute + close-others-on-open instead, so they keep
// their own wiring and only share the CSS.

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
