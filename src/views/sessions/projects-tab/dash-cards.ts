// User-defined cards (stats or a list of rows), configured from a chat's MCP
// tool or the cards modal. A card never throws: its error renders as a line.
import { html, nothing, type TemplateResult } from "lit-html";
import { fetchedLabel } from "./format";
import { card, kv, quiet, row, icon, type DashCtx } from "./dash-parts";
import type { CardView } from "./types";

function cardBody(c: DashCtx, v: CardView): TemplateResult | TemplateResult[] {
  const r = v.result;
  if (!r) return quiet("Not fetched yet");
  const parts: TemplateResult[] = [];
  if (r.error) parts.push(html`<div class="pd-err">${r.error}</div>`);
  if (v.config.display.kind === "stats") {
    for (const s of r.stats) parts.push(kv(s.label, s.value));
    if (!r.stats.length && !r.error) parts.push(quiet("No values"));
  } else {
    for (const x of r.rows) {
      const link = x.link;
      parts.push(row(icon(link ? "arrow-square-out" : "dot-outline"), x.label, {
        meta: x.value, onClick: link ? () => c.act.openUrl(link) : undefined,
      }));
    }
    if (!r.rows.length && !r.error) parts.push(quiet("Nothing to show"));
  }
  return parts;
}

function cardHeader(c: DashCtx, v: CardView): TemplateResult {
  const id = v.config.id;
  const busy = c.refreshing.has(id);
  const when = v.result ? fetchedLabel(v.result.fetched_at_ms, c.nowMs) : "";
  return html`<span class="pd-fetched">${when}</span>
    <button type="button" class="pd-ib sm ${busy ? "is-spinning" : ""}" title="Refresh" ?disabled=${busy}
      @click=${() => c.act.refreshCard(id)}><i class="ph ph-arrows-clockwise"></i></button>`;
}

/** Disabled cards stay in the cards modal but never paint on the dashboard. */
export function customCards(c: DashCtx): Array<TemplateResult | typeof nothing> {
  return c.snap.cards
    .filter((v) => v.config.enabled)
    .map((v) => card(v.config.title, cardBody(c, v), { id: `card:${v.config.id}`, trailing: cardHeader(c, v) }));
}
