// Hold, right-click and swipe-up on the Send button. Send itself stays one plain
// button; everything else (schedule, and voice when it is enabled) hangs off
// these gestures instead of a chevron beside it.

const HOLD_MS = 450;
const SWIPE_PX = 40;
// A touch long-press can raise `contextmenu` itself on top of our own hold timer.
// One menu is enough, so a second trigger inside this window is dropped.
const DEDUPE_MS = 800;

export interface SendGestureCallbacks {
  /** Right-click or long-press. */
  onMenu: () => void;
  /** Swipe up past SWIPE_PX. Only called when `swipeUpEnabled()` is true. */
  onSwipeUp: () => void;
  swipeUpEnabled: () => boolean;
  isDisabled: () => boolean;
}

/** `wrap` carries the `holding` class that drives the hold ring (composer.css). */
export function wireSendGestures(btn: HTMLElement, wrap: HTMLElement, cb: SendGestureCallbacks): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startY = 0;
  // Set once a gesture has done its job, so the click that still follows the
  // pointer release does not also send the message.
  let consumed = false;
  let lastMenuAt = 0;

  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    wrap.classList.remove("holding");
  };
  const openMenu = (): void => {
    const now = Date.now();
    if (now - lastMenuAt < DEDUPE_MS) return;
    lastMenuAt = now;
    cb.onMenu();
  };

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || cb.isDisabled()) return;
    consumed = false;
    startY = e.clientY;
    wrap.classList.add("holding");
    timer = setTimeout(() => {
      timer = null;
      consumed = true;
      stop();
      openMenu();
    }, HOLD_MS);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!timer || !cb.swipeUpEnabled()) return;
    if (startY - e.clientY < SWIPE_PX) return;
    consumed = true;
    stop();
    cb.onSwipeUp();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    btn.addEventListener(type, () => {
      stop();
      // A release elsewhere (off Send, or on the menu) never produces the click
      // that clears `consumed`, which would otherwise swallow a later keyboard
      // activation. The click that does follow a release on Send is dispatched in
      // the same task, ahead of this timer.
      if (consumed) setTimeout(() => { consumed = false; }, 0);
    });
  }

  // Capture phase on the target itself runs before the composer's own click
  // listener, whichever order the two were added in.
  btn.addEventListener(
    "click",
    (e) => {
      if (!consumed) return;
      consumed = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (cb.isDisabled()) return;
    openMenu();
  });
}
