// Phone: swipe left/right over the question card's track to page between
// questions - same destination as the pager arrows/dots, ungated like them
// (keyboard/dot paging already skips the "must answer first" rule the
// footer's Next button enforces - see question-keyboard.ts's page()).
// Delegated on the stable host element so it survives every render()'s
// innerHTML rebuild; no detach needed, the host dies with the card.

import { isMobileViewport } from "../../../shared/mobile-viewport";
import type { QuestionRenderState } from "./question-ui-templates";

const SWIPE_PX = 40;

export function attachQuestionSwipe(
  host: HTMLElement,
  state: QuestionRenderState,
  goToTab: (target: number) => void,
): void {
  let active = false;
  let startX = 0;
  let startY = 0;

  const onStart = (e: TouchEvent): void => {
    active = false;
    const t = e.touches[0];
    if (!isMobileViewport() || e.touches.length !== 1 || !t) return;
    // Lets the free-text box keep its native cursor/selection dragging -
    // paging is for the panel/options area, not the typed answer.
    if ((e.target as Element).closest("textarea, input")) return;
    if (!(e.target as Element).closest(".prompt-track-viewport")) return;
    active = true;
    startX = t.clientX;
    startY = t.clientY;
  };

  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!active || !t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Vertical drags belong to the panel's own vertical scroll (a long
    // option list uses overflow-y: auto).
    if (Math.abs(dy) > Math.abs(dx)) { active = false; return; }
    if (e.cancelable) e.preventDefault();
  };

  const onEnd = (e: TouchEvent): void => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    if (Math.abs(dx) < SWIPE_PX) return;
    goToTab(state.activeTab + (dx < 0 ? 1 : -1));
  };

  host.addEventListener("touchstart", onStart, { passive: true });
  host.addEventListener("touchmove", onMove, { passive: false });
  host.addEventListener("touchend", onEnd);
  host.addEventListener("touchcancel", () => { active = false; });
}
