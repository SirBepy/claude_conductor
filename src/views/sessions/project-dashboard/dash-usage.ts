// Usage: tokens per day for the dashboard's repos, as a line over the whole
// 7d / 30d / All range, drawn by the same line chart as the Todos card. Reads
// the same token-history store the Home charts use (shared/token-history.ts).
import { html, nothing, type TemplateResult } from "lit-html";
import { formatTokens, totalTok, type AliasMap, type TokenRecord } from "../../../shared/tokens";
import { card, hidden, quiet, rangeTabs, type DashCtx, type DashRange } from "./dash-parts";
import { lineChart, type LineSeries } from "./dash-line-chart";
import { sameCwd } from "./format";

export type UsageRange = DashRange;

export interface UsageState {
  range: UsageRange;
  /** Null until the first load lands. */
  records: TokenRecord[] | null;
}

const SERIES: readonly LineSeries[] = [
  { key: "tokens", label: "Tokens", color: "var(--color-primary)", width: 2.25, dash: "", lead: true },
];

/** Every folder whose tokens count for a repo: itself plus whatever was merged into it. */
function repoPaths(cwd: string, aliases: AliasMap): string[] {
  return [cwd, ...(aliases[cwd]?.mergedPaths ?? [])];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD in local time, the form token records carry. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Tokens per day for the given repos, one entry for EVERY day of the range
 *  (the newest 7 or 30 days, or from the first active day for All), oldest
 *  first, with 0 on quiet days so the line drops instead of skipping them.
 *  Pure, for tests. */
export function usageByDay(
  records: TokenRecord[], repoCwds: string[], aliases: AliasMap, range: UsageRange, now: Date = new Date(),
): Array<{ date: string, tokens: number }> {
  const paths = repoCwds.flatMap((c) => repoPaths(c, aliases));
  const today = ymd(now);
  const back = (n: number): string => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  const byDate = new Map<string, number>();
  for (const r of records) {
    // A date not in YYYY-MM-DD form would make an Invalid Date the start of the All range and empty the chart.
    if (!r.cwd || !r.date || !DAY.test(r.date) || !paths.some((p) => sameCwd(p, r.cwd!))) continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + totalTok(r));
  }
  const first = range === "all" ? [...byDate.keys()].sort()[0] : back(range === "7d" ? 6 : 29);
  if (!first) return [];
  const out: Array<{ date: string, tokens: number }> = [];
  for (let i = 0; ; i++) {
    const d = new Date(`${first}T12:00:00`);
    d.setDate(d.getDate() + i);
    const date = ymd(d);
    if (date > today) break;
    out.push({ date, tokens: byDate.get(date) ?? 0 });
  }
  return out;
}

export function usage(c: DashCtx, aliases: AliasMap): TemplateResult | typeof nothing {
  if (hidden(c, "usage")) return nothing;
  const u = c.usage;
  const days = u.records ? usageByDay(u.records, c.snap.target.repos.map((r) => r.cwd), aliases, u.range, new Date(c.nowMs)) : [];
  const total = days.reduce((s, d) => s + d.tokens, 0);
  const body = !u.records ? quiet("Loading...")
    : !total ? quiet("No activity in this period")
    : html`<div class="pd-usage-total">${formatTokens(total)} tokens</div>
      ${lineChart({ series: SERIES, rows: days, format: formatTokens, integer: true })}`;
  return card("Usage", body, { id: "usage", trailing: rangeTabs(u.range, c.act.setUsageRange) });
}
