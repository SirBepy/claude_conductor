// Hold-vs-send-now choice popped when the composer sends into a frozen chat
// (Instance.frozen - the underlying process was torn down and won't
// respawn on its own). Mirrors the openComposerMenu/openSchedulePicker
// popover idiom and reuses its chrome so there's no new visual language.
import { openAnchoredPopover } from "./anchored-popover";
import "./schedule-picker.css";

export type FrozenChoice = "hold" | "now";

/** Resolves with the user's pick, or null if dismissed (outside click/Escape)
 *  without choosing - the caller restores the draft in that case. */
export function openFrozenChoice(anchor: HTMLElement): Promise<FrozenChoice | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const pop = document.createElement("div");
    pop.className = "schedule-picker-popover composer-frozen-choice-popover";
    pop.innerHTML = `
      <div class="schedule-picker-title">This chat is frozen</div>
      <div class="schedule-picker-rows">
        <button type="button" class="schedule-picker-row" data-choice="hold">
          <span class="schedule-picker-row-label"><i class="ph ph-hourglass"></i> Hold - send once unfrozen</span>
        </button>
        <button type="button" class="schedule-picker-row" data-choice="now">
          <span class="schedule-picker-row-label"><i class="ph ph-paper-plane-right"></i> Send now (unfreezes chat)</span>
        </button>
      </div>
    `;
    document.body.appendChild(pop);

    const popover = openAnchoredPopover({
      anchor,
      el: pop,
      onClose: () => {
        pop.remove();
        if (!resolved) resolve(null);
      },
    });

    pop.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((btn) => {
      btn.addEventListener("click", () => {
        resolved = true;
        popover.close();
        resolve(btn.dataset.choice as FrozenChoice);
      });
    });

    popover.reposition();
  });
}
