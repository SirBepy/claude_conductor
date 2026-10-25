// Phone: swipe left/right anywhere on the question card to page between
// questions - same destination as the pager arrows/dots, ungated like them
// (keyboard/dot paging already skips the "must answer first" rule the
// footer's Next button enforces - see question-keyboard.ts's page()).
// Delegated on the stable host element so it survives every render()'s
// innerHTML rebuild; no detach needed, the host dies with the card.

import { isMobileViewport } from "../../../shared/mobile-viewport";
import { attachSwipe } from "./swipe-detector";
import type { QuestionRenderState } from "./question-ui-templates";

export function attachQuestionSwipe(
  host: HTMLElement,
  state: QuestionRenderState,
  goToTab: (target: number) => void,
): void {
  attachSwipe(host, {
    axis: "x",
    startsOn: (target) => {
      if (!isMobileViewport()) return false;
      // Lets the free-text box keep its native cursor/selection dragging -
      // paging is for the rest of the card, not the typed answer.
      if (target.closest("textarea, input")) return false;
      // The whole card (header and footer too), not just the panel area, so
      // a thumb never has to aim. The collapsed bar is not a .prompt-card.
      return !!target.closest(".prompt-card");
    },
    onSwipe: (direction) => goToTab(state.activeTab + direction),
  });
}
