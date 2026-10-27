// A card's segmented bar (`_card.segments`): one bar split into labelled slices
// sized against the bar's max, an optional pace tick, and a toned note. A slice
// wide enough prints its label over its figure; a narrower one drops to a chip
// under the bar so nothing is lost and nothing is clipped.
import { html, nothing, type TemplateResult } from "lit-html";
import type { CardSegments, SegmentItem } from "./types";

/** Narrowest share of the bar that still holds a two-line label: about 34px of
 *  the card's ~410px bar. Share, not pixels, so the call needs no layout pass. */
export const MIN_LABEL_SHARE = 0.083;

// One hue (the app's violet) with lightness stepping up through the list, so
// slices read apart by shade. Entries past the last step hold the lightest.
const HUE = 295;
const RAMP: ReadonlyArray<readonly [lightness: number, chroma: number]> = [
  [0.64, 0.14], [0.69, 0.14], [0.74, 0.13], [0.79, 0.12], [0.84, 0.10], [0.88, 0.08], [0.91, 0.06],
];

/** Fill and text colour for the slice at `index`: the text is a dark shade of the fill's own hue. */
export function sliceColors(index: number): { bg: string, fg: string } {
  const [l, c] = RAMP[Math.min(Math.max(index, 0), RAMP.length - 1)]!;
  return { bg: `oklch(${l} ${c} ${HUE})`, fg: `oklch(0.27 0.06 ${HUE})` };
}

/** What the bar's width stands for: `max`, or the slices' sum when they overshoot it. */
function barTotal(s: CardSegments): number {
  return Math.max(s.max, s.items.reduce((sum, i) => sum + i.value, 0));
}

/** The figure a slice prints: its own text, else the raw value. Shared with the message a card's button sends. */
export const figure = (i: SegmentItem): string => i.text || String(i.value);

export function segmentsBar(s: CardSegments): TemplateResult {
  const total = barTotal(s);
  // A zero day has no slice to draw and would only add noise as a chip.
  const shown = s.items.map((item, index) => ({ item, index })).filter(({ item }) => item.value > 0);
  const fits = ({ item }: { item: SegmentItem }): boolean => item.value / total >= MIN_LABEL_SHARE;
  const slices = shown.map((e) => {
    const { bg, fg } = sliceColors(e.index);
    const label = fits(e) ? html`<em>${e.item.label}</em><b>${figure(e.item)}</b>` : nothing;
    return html`<span class="pd-seg-slice" style="width:${(e.item.value / total) * 100}%;background:${bg};color:${fg}">${label}</span>`;
  });
  const chips = shown.filter((e) => !fits(e)).map((e) => html`<span class="pd-seg-chip">
    <i style="background:${sliceColors(e.index).bg}"></i>${e.item.label} <b>${figure(e.item)}</b></span>`);
  const marker = s.marker === undefined || s.marker === null
    ? nothing
    : html`<i class="pd-seg-marker" style="left:${Math.min(100, (s.marker / total) * 100)}%"></i>`;
  const note = s.note ? html`<span class="pd-seg-note ${s.note_tone ?? ""}">${s.note}</span>` : nothing;
  const summary = shown.map((e) => `${e.item.label} ${figure(e.item)}`).join(", ");
  return html`<div class="pd-seg">
    <div class="pd-seg-bar" role="img" aria-label=${summary || "No time logged"}>${slices}${marker}</div>
    ${chips.length || s.note ? html`<div class="pd-seg-foot"><div class="pd-seg-chips">${chips}</div>${note}</div>` : nothing}
  </div>`;
}
