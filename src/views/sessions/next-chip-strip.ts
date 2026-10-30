// Renders next-chips.ts into the pane's `.next-chip-slot`. A plain click puts
// the chip in the message box; Shift+click sends it at once, but only when
// nothing is typed, so a half-written message is never dropped.
import { getSettings } from "../../shared/state";
import { currentTurnNextActions } from "../../shared/chat/chat-next-actions";
import { state } from "./state";
import { isWrapUpOnDone, onWrapUpChange } from "./permission-modal/gating";
import { withCommand } from "./project-dashboard/format";
import { isSlashChip, nextChips } from "./next-chips";
import "./next-chips.css";

let _lastPane: HTMLElement | null = null;

// A flip of "Wrap up when done" changes the chip set without any instance
// update, so the strip listens for it directly.
onWrapUpChange(() => { if (_lastPane) refreshNextChips(_lastPane); });

function onChipClick(chip: string, shift: boolean): void {
  const composer = state.composer;
  if (!composer) return;
  const draft = composer.getDraftText();
  if (shift && composer.isDraftEmpty()) {
    void composer.sendText(chip);
    return;
  }
  if (isSlashChip(chip)) {
    // The daemon only treats a prompt as a command when it starts with it, so
    // the command goes first and what was typed stays after it as arguments.
    composer.setDraftText(withCommand(draft, chip), false);
  } else if (draft.trim() === "") {
    composer.setDraftText(chip, false);
  } else if (!draft.startsWith(chip)) {
    // A reply goes above what was typed, never over it; a second click on the
    // same chip must not stack it twice.
    composer.setDraftText(`${chip}\n${draft}`, false);
  }
}

/** Re-evaluate the strip for the open chat. Cheap and idempotent: the buttons
 *  are only rebuilt when the chip list changed, because a rebuild under the
 *  cursor swallows the click that was about to land. */
export function refreshNextChips(pane: HTMLElement): void {
  _lastPane = pane;
  const slot = pane.querySelector<HTMLElement>(".next-chip-slot");
  if (!slot) return;
  const id = state.selectedId;
  // The renderer can still be the previous chat's for a beat after a switch.
  const renderer = id && state.renderer?.sessionId === id ? state.renderer : null;
  const chips = nextChips({
    enabled: getSettings().nextActionChips !== false,
    inst: id ? state.sessions.find((s) => s.session_id === id) : undefined,
    wrapUp: isWrapUpOnDone(id),
    hasHeld: !!state.heldMessages?.hasItemsForActive(),
    nextActions: renderer ? currentTurnNextActions(renderer.messages) : [],
  });
  const key = chips.join("\n");
  if (slot.dataset.chips === key) return;
  slot.dataset.chips = key;
  slot.replaceChildren(...chips.map((chip) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "next-chip";
    b.textContent = chip;
    b.title = "Click to fill the message box, Shift+click to send";
    b.addEventListener("click", (e) => onChipClick(chip, e.shiftKey));
    return b;
  }));
}
