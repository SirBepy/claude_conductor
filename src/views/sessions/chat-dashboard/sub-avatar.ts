// A sub's avatar button: initials in a state ring, the corner glyph of a sub that
// is not progressing and the model battery. Shared by the Subchats card and the
// finished tray, so a sub looks the same in both (its CSS is subs-card.css).

import { escapeHtml } from "../../../shared/escape-html";
import type { SubCardItem } from "../../../shared/chat/dashboard/subs-model";
import { modelBatteryHtml } from "../sidebar-row-visuals";
import { subGlyphHtml, subInitials } from "../sub-list";

/** No native `title`: the hover card (sub-hover.ts) says it, and two tooltips on one avatar would stack. */
export function avatarHtml(it: SubCardItem, ring: string, selected: boolean): string {
  const name = escapeHtml(it.name);
  return `<button type="button" class="sx-av${selected ? " on" : ""}" data-sub="${escapeHtml(it.id)}" data-kind="${it.kind}" aria-pressed="${selected}" aria-label="${name}, ${escapeHtml(it.progress)}">`
    + `<span class="sx-face">${escapeHtml(subInitials(it.name))}${ring}</span>${subGlyphHtml(it.kind)}${modelBatteryHtml(it.model, it.effort)}</button>`;
}
