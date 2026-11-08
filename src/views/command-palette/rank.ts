import { fuzzyScore } from "../../shared/chat/caret-popup/fuzzy-score";
import { isRunnable, type PaletteCommand } from "./types";

const MAX_ROWS = 60;

interface Hit {
  c: PaletteCommand;
  index: number;
  tier: number;
  score: number;
}

// Tiers, best first. A hit on the title always beats a hit on the words around
// it, so typing "model" lists the model commands before a chat that mentions one.
function tierOf(c: PaletteCommand, q: string): { tier: number; score: number } | null {
  const title = c.title.toLowerCase();
  if (title.startsWith(q)) return { tier: 0, score: 100_000 - title.length };
  if (title.split(/[\s:/-]+/).some((w) => w.startsWith(q))) return { tier: 1, score: 60_000 - title.length };
  if (title.includes(q)) return { tier: 2, score: 50_000 - title.length };
  const fuzzy = fuzzyScore(title, q);
  if (fuzzy > 0) return { tier: 3, score: fuzzy };

  const rest = [c.detail ?? "", c.group, ...(c.keywords ?? [])].join(" ").toLowerCase();
  const all = `${title} ${rest}`;
  // Every word must appear somewhere, so "settings sound" finds a Settings row
  // titled "Mute sounds" although neither word is a prefix of the whole title.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => all.includes(w))) return { tier: 4, score: 10_000 - all.length };
  if (rest.includes(q)) return { tier: 5, score: 5_000 - rest.length };
  return null;
}

/** Orders the rows for the current query. An empty query lists the recents
 *  (newest first) and then everything else in the order the sources gave.
 *  Rows that cannot run sort after the ones that can, so a greyed "Deploy" never
 *  pushes a working row down. */
export function rankCommands(commands: PaletteCommand[], query: string, recents: string[]): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  const recentIndex = new Map(recents.map((id, i) => [id, i]));

  if (!q) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recent = recents.map((id) => byId.get(id)).filter((c): c is PaletteCommand => !!c && isRunnable(c));
    const seen = new Set(recent.map((c) => c.id));
    const rest = commands.filter((c) => !seen.has(c.id));
    return [...recent, ...rest.filter(isRunnable), ...rest.filter((c) => !isRunnable(c))].slice(0, MAX_ROWS);
  }

  const hits: Hit[] = [];
  commands.forEach((c, index) => {
    const t = tierOf(c, q);
    if (t) hits.push({ c, index, ...t });
  });
  hits.sort((a, b) => {
    const dead = Number(!isRunnable(a.c)) - Number(!isRunnable(b.c));
    if (dead) return dead;
    if (a.tier !== b.tier) return a.tier - b.tier;
    // Within a tier a recent command wins over a longer-ago or never-run one.
    const ra = recentIndex.get(a.c.id) ?? Infinity;
    const rb = recentIndex.get(b.c.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return b.score - a.score || a.index - b.index;
  });
  return hits.slice(0, MAX_ROWS).map((h) => h.c);
}
