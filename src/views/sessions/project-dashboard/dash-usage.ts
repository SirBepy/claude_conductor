// Usage: tokens per day for the dashboard's repos, as a bar chart with a
// 7d / 30d / All switch and paging back through older days. Reads the same
// token-history store the Home charts use (shared/token-history.ts).
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { formatTokens, totalTok, type AliasMap, type TokenRecord } from "../../../shared/tokens";
import { card, hidden, quiet, type DashCtx } from "./dash-parts";
import { sameCwd } from "./format";

export type UsageRange = "7d" | "30d" | "all";

export interface UsageState {
  range: UsageRange;
  /** Pages of BARS days back from the newest; 0 = the latest page. */
  offset: number;
  /** Null until the first load lands. */
  records: TokenRecord[] | null;
}

const BARS = 10;
const RANGES: Array<{ id: UsageRange, label: string }> = [
  { id: "7d", label: "7d" }, { id: "30d", label: "30d" }, { id: "all", label: "All" },
];

/** Every folder whose tokens count for a repo: itself plus whatever was merged into it. */
function repoPaths(cwd: string, aliases: AliasMap): string[] {
  return [cwd, ...(aliases[cwd]?.mergedPaths ?? [])];
}

/** Tokens per day for the given repos inside the range, oldest day first. Pure, for tests. */
export function usageByDay(
  records: TokenRecord[], repoCwds: string[], aliases: AliasMap, range: UsageRange, now: Date = new Date(),
): Array<{ date: string, tokens: number }> {
  const paths = repoCwds.flatMap((c) => repoPaths(c, aliases));
  let cutoff = "";
  if (range !== "all") {
    const d = new Date(now);
    d.setDate(d.getDate() - (range === "7d" ? 7 : 30));
    cutoff = d.toISOString().slice(0, 10);
  }
  const byDate = new Map<string, number>();
  for (const r of records) {
    if (!r.cwd || !paths.some((p) => sameCwd(p, r.cwd!))) continue;
    const date = r.date || "";
    if (!date || date < cutoff) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + totalTok(r));
  }
  return [...byDate.entries()].map(([date, tokens]) => ({ date, tokens })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 420x160 viewBox, y labels on the left, MM-DD under each bar. */
function chartSvg(days: Array<{ date: string, tokens: number }>): string {
  const W = 420, H = 160, ML = 40, MR = 8, MT = 8, MB = 36;
  const PW = W - ML - MR, PH = H - MT - MB;
  const maxTok = Math.max(...days.map((d) => d.tokens), 1);
  const spacing = PW / days.length;
  const barW = Math.max(4, spacing - 3);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const y = MT + (1 - frac) * PH;
    return `<line x1="${ML}" x2="${W - MR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--color-border)" stroke-width="1"/>
      <text x="${ML - 4}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="var(--sb-muted)" font-size="9" font-family="Fira Code,monospace">${formatTokens(Math.round(frac * maxTok))}</text>`;
  }).join("");
  const bars = days.map((d, i) => {
    const x = ML + i * spacing + (spacing - barW) / 2;
    const h = Math.max(1, (d.tokens / maxTok) * PH);
    return `<rect x="${x.toFixed(1)}" y="${(MT + PH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--color-primary)" opacity="0.85"><title>${d.date}: ${formatTokens(d.tokens)}</title></rect>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(H - MB + 14).toFixed(1)}" text-anchor="middle" fill="var(--sb-muted)" font-size="9" font-family="DM Sans,system-ui">${d.date.slice(5)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">${ticks}
    <line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="var(--color-border)" stroke-width="1"/>${bars}</svg>`;
}

export function usage(c: DashCtx, aliases: AliasMap): TemplateResult | typeof nothing {
  if (hidden(c, "usage")) return nothing;
  const u = c.usage;
  const days = u.records ? usageByDay(u.records, c.snap.target.repos.map((r) => r.cwd), aliases, u.range, new Date(c.nowMs)) : [];
  const end = days.length - u.offset * BARS;
  const start = Math.max(0, end - BARS);
  const visible = days.slice(start, Math.max(end, 0));
  const total = visible.reduce((s, d) => s + d.tokens, 0);
  const trailing = html`<span class="pd-usage-ranges">${RANGES.map((r) => html`
      <button type="button" class="pd-rtab ${u.range === r.id ? "on" : ""}" data-pd-range=${r.id} @click=${() => c.act.setUsageRange(r.id)}>${r.label}</button>`)}</span>
    <span class="pd-pager">
      <button type="button" class="pd-pg" title="Earlier" ?disabled=${start === 0} @click=${() => c.act.setUsageOffset(u.offset + 1)}><i class="ph ph-caret-left"></i></button>
      <button type="button" class="pd-pg" title="Later" ?disabled=${u.offset === 0} @click=${() => c.act.setUsageOffset(u.offset - 1)}><i class="ph ph-caret-right"></i></button>
    </span>`;
  const body = !u.records ? quiet("Loading...")
    : !visible.length ? quiet("No activity in this period")
    : html`<div class="pd-usage-total">${formatTokens(total)} tokens</div><div class="pd-usage-chart">${unsafeHTML(chartSvg(visible))}</div>`;
  return card("Usage", body, { id: "usage", trailing });
}
