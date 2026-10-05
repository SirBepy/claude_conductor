// Phone, keyboard open: the header + chip row stay up by default; a swipe up
// on them tucks both away, a swipe down from the pane's top edge brings them
// back (Joe, 2026-10-05). Keyboard-closed layouts ignore the gesture, and
// closing the keyboard clears the tuck so the next open starts shown.
// sessions-mobile.css does the sliding off data-mobile-header-tucked.

const SWIPE_PX = 40;
// Once tucked, the transcript owns the top of the pane, so only a drag that
// starts this close to its edge counts as "pull the header back".
const TOP_EDGE_PX = 48;

const TUCKED = "data-mobile-header-tucked";
// SessionStatusbar renames its host slot on mount, so match either name.
const CHIP_ROW = ".session-statusbar, .session-statusbar-host";

export function initMobileHeaderSwipe(view: HTMLElement, pane: HTMLElement): () => void {
  let mode: "tuck" | "reveal" | null = null;
  let startX = 0;
  let startY = 0;

  const keyboardOpen = (): boolean =>
    view.hasAttribute("data-mobile-keyboard") && view.dataset.mobilePane === "chat";

  function setTucked(on: boolean): void {
    if (on) {
      const header = pane.querySelector<HTMLElement>(".session-header");
      const statusbar = pane.querySelector<HTMLElement>(CHIP_ROW);
      const h = (header?.offsetHeight ?? 0) + (statusbar?.offsetHeight ?? 0);
      view.style.setProperty("--mobile-chrome-h", `${h}px`);
    }
    view.toggleAttribute(TUCKED, on);
  }

  const onStart = (e: TouchEvent): void => {
    mode = null;
    const t = e.touches[0];
    if (!keyboardOpen() || e.touches.length !== 1 || !t) return;
    const tucked = view.hasAttribute(TUCKED);
    if (!tucked && (e.target as Element).closest(`.session-header, ${CHIP_ROW}`)) {
      mode = "tuck";
    } else if (tucked && t.clientY - pane.getBoundingClientRect().top < TOP_EDGE_PX) {
      mode = "reveal";
    }
    startX = t.clientX;
    startY = t.clientY;
  };

  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!mode || !t) return;
    const dy = t.clientY - startY;
    // Sideways drags belong to the chip row's own horizontal scroll.
    if (Math.abs(t.clientX - startX) > Math.abs(dy)) return;
    // Keeps the transcript from scrolling under a reveal pull.
    if (mode === "reveal" && e.cancelable) e.preventDefault();
    if (mode === "tuck" && dy < -SWIPE_PX) {
      setTucked(true);
      mode = null;
    } else if (mode === "reveal" && dy > SWIPE_PX) {
      setTucked(false);
      mode = null;
    }
  };

  const onEnd = (): void => {
    mode = null;
  };

  const keyboardWatch = new MutationObserver(() => {
    if (!view.hasAttribute("data-mobile-keyboard")) view.removeAttribute(TUCKED);
  });
  keyboardWatch.observe(view, { attributes: true, attributeFilter: ["data-mobile-keyboard"] });

  pane.addEventListener("touchstart", onStart, { passive: true });
  pane.addEventListener("touchmove", onMove, { passive: false });
  pane.addEventListener("touchend", onEnd);
  pane.addEventListener("touchcancel", onEnd);

  return () => {
    keyboardWatch.disconnect();
    pane.removeEventListener("touchstart", onStart);
    pane.removeEventListener("touchmove", onMove);
    pane.removeEventListener("touchend", onEnd);
    pane.removeEventListener("touchcancel", onEnd);
    view.removeAttribute(TUCKED);
    view.style.removeProperty("--mobile-chrome-h");
  };
}
