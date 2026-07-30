// Wires the .menu-anchor/.menu-popover/.menu-item click-toggle + dismiss-on-
// outside-click idiom shared by project-detail/session-detail/characters
// (todo 204). Toggles the `.hidden` class - accounts.ts's per-row popovers
// use a `hidden` attribute + close-others-on-open instead, so they keep
// their own wiring and only share the CSS.

/** Wires `button` to toggle `menu`'s `.hidden` class and dismiss it on an
 *  outside click. Returns a dispose function that removes the document
 *  listener (call it from view teardown if the view unmounts). */
export function wireKebabMenu(button: HTMLElement, menu: HTMLElement): () => void {
  const onDocClick = (e: MouseEvent) => {
    if (menu.classList.contains("hidden")) return;
    const target = e.target as Node;
    if (menu.contains(target) || button.contains(target)) return;
    menu.classList.add("hidden");
  };
  button.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  };
  document.addEventListener("click", onDocClick);
  return () => document.removeEventListener("click", onDocClick);
}

/** Hides the menu - call from a `.menu-item` click handler. */
export function closeKebabMenu(menu: HTMLElement): void {
  menu.classList.add("hidden");
}
