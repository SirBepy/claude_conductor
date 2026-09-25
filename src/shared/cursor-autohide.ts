// Chromium/WebKit natively hide the OS pointer while typing in a focused
// field and re-show it on the next hover recompute - including synthetic
// recomputes fired by DOM reflow (composer/chat re-render on every
// keystroke), which carry a zero movementX/Y. That native behavior flickers
// the cursor in and out on almost every character. This replaces it with a
// deterministic hide driven only by real pointer motion, so the cursor
// state only ever changes on an actual physical mouse move.
let hidden = false;

function hide(): void {
  if (hidden) return;
  hidden = true;
  document.documentElement.classList.add("cursor-typing-hidden");
}

function show(): void {
  if (!hidden) return;
  hidden = false;
  document.documentElement.classList.remove("cursor-typing-hidden");
}

function onMouseMove(e: MouseEvent): void {
  if (e.movementX !== 0 || e.movementY !== 0) show();
}

/** Call once at boot. Hides the OS cursor while typing, shows it again on real mouse movement. */
export function initCursorAutohide(): void {
  document.addEventListener("keydown", hide, { capture: true });
  document.addEventListener("mousemove", onMouseMove, { capture: true });
}
