// User-defined cards (stats, a list of rows, or their own HTML), configured from a chat's MCP
// tool or the cards modal. A card never throws: its error renders as a line.
// Optional extras: a progress bar, a headline stat line and a run-a-command
// button, all driven by the card's own data so no card is special-cased.
import { html, nothing, type TemplateResult } from "lit-html";
import { fetchedLabel } from "./format";
import { card, kv, quiet, row, icon, type DashCtx } from "./dash-parts";
import { pageSlice } from "./paging";
import { htmlCardFrame } from "./dash-html-card";
import type { CardConfigX, CardProgress, CardResultX, CardView } from "./types";

function progressBar(p: CardProgress): TemplateResult {
  const pct = p.max > 0 ? Math.max(0, Math.min(100, (p.value / p.max) * 100)) : 0;
  return html`<div class="pd-prog ${p.behind ? "is-behind" : ""}">
    <div class="pd-prog-label">${p.label}</div>
    <div class="pd-prog-bar"><span style="width:${pct}%"></span></div>
  </div>`;
}

function headlineLine(c: DashCtx, r: CardResultX, action: CardConfigX["action"]): TemplateResult | typeof nothing {
  if (!r.headline && !action) return nothing;
  const button = action ? html`<button type="button" class="pd-act" data-pd-action
    @click=${(e: Event) => c.act.newChat(e.currentTarget as HTMLElement, action.command)}>${action.label}<i class="ph ph-arrow-right"></i></button>` : nothing;
  return html`<div class="pd-headline">
    <span class="pd-hl-t ${r.headline_tone ?? ""}">${r.headline ?? ""}</span>${button}</div>`;
}

function cardBody(c: DashCtx, v: CardView): { body: TemplateResult[], pager: TemplateResult | typeof nothing } {
  const r = v.result as CardResultX | null;
  if (!r) return { body: [quiet("Not fetched yet")], pager: nothing };
  const parts: TemplateResult[] = [];
  const display = v.config.display;
  // An html card draws its own progress and headline (a pie instead of the
  // bar, say); only its action button stays the dashboard's.
  const own = display.kind === "html";
  if (r.progress && !own) parts.push(progressBar(r.progress));
  const line = headlineLine(c, own ? { ...r, headline: null } : r, (v.config as CardConfigX).action);
  if (line !== nothing) parts.push(line);
  if (r.error) parts.push(html`<div class="pd-err">${r.error}</div>`);
  const extras = !!(r.progress || r.headline);
  let pager: TemplateResult | typeof nothing = nothing;
  if (display.kind === "html") {
    if (!r.error) parts.push(htmlCardFrame(v.config.title, display.template, r.data));
  } else if (display.kind === "stats") {
    const page = pageSlice(c, `card:${v.config.id}`, r.stats);
    pager = page.pager;
    for (const s of page.slice) parts.push(kv(s.label, s.value));
    if (!r.stats.length && !r.error && !extras) parts.push(quiet("No values"));
  } else {
    const page = pageSlice(c, `card:${v.config.id}`, r.rows);
    pager = page.pager;
    for (const x of page.slice) {
      const link = x.link;
      parts.push(row(icon(link ? "arrow-square-out" : "dot-outline"), x.label, {
        meta: x.value, onClick: link ? () => c.act.openUrl(link) : undefined,
      }));
    }
    if (!r.rows.length && !r.error && !extras) parts.push(quiet("Nothing to show"));
  }
  return { body: parts, pager };
}

function cardHeader(c: DashCtx, v: CardView, pager: TemplateResult | typeof nothing): TemplateResult {
  const id = v.config.id;
  const busy = c.refreshing.has(id);
  const when = v.result ? fetchedLabel(v.result.fetched_at_ms, c.nowMs) : "";
  return html`<span class="pd-fetched">${when}</span>${pager}
    <button type="button" class="pd-ib sm ${busy ? "is-spinning" : ""}" title="Refresh" ?disabled=${busy}
      @click=${() => c.act.refreshCard(id)}><i class="ph ph-arrows-clockwise"></i></button>`;
}

/** Disabled cards stay in the cards modal but never paint on the dashboard.
 *  Each body comes paired with its section id, so the two cannot drift apart. */
export function customCards(c: DashCtx): Array<{ id: string, body: TemplateResult }> {
  return c.snap.cards
    .filter((v) => v.config.enabled)
    .map((v) => {
      const id = `card:${v.config.id}`;
      const { body, pager } = cardBody(c, v);
      return { id, body: card(v.config.title, body, { id, trailing: cardHeader(c, v, pager) }) };
    });
}
