// A sub's avatar button: initials in a state ring and the corner glyph of a sub that
// is not progressing. Shared by the Subchats card and the Done card, so a sub looks
// the same in both (its CSS is subs-card.css). The model and effort are words in the
// card and hover card, not a corner glyph.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { subGlyphHtml, subInitials } from "../sub-list";

/** No native `title`: the hover card (sub-hover.ts) says it, and two tooltips on one avatar would stack. */
export function avatarHtml(it: SubCardItem, ring: string, selected: boolean): string {
  const name = escapeHtml(it.name);
  return `<button type="button" class="sx-av${selected ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}"${chatMenuAttr(it.id)} aria-pressed="${selected}" aria-label="${name}, ${escapeHtml(it.progress)}">`
    + `<span class="sx-face">${escapeHtml(subInitials(it.name))}${ring}</span>${subGlyphHtml(it.kind)}</button>`;
}
