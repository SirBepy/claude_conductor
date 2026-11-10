import "./question-icon.css";

/** The question card's icon: `ph-question-mark` stacked inside `ph-chat-circle`.
 *  Every place a question card draws its icon goes through here, so the glyph
 *  changes in one spot. The host's CSS sets the size (see question-icon.css). */
export function questionIconHtml(): string {
  return `<span class="q-icon" data-q-icon><i class="ph ph-chat-circle"></i><i class="ph-bold ph-question-mark q-icon__mark"></i></span>`;
}
