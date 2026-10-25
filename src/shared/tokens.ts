/**
 * Token formatting and aggregation helpers.
 */

export interface TokenRecord {
  cwd?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  turns?: number;
  lastActiveAt?: string;
  recordedAt?: string;
  date?: string;
  [k: string]: unknown;
}

export interface ProjectAggregate {
  cwd: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  lastDate: string;
}

export interface ProjectAlias {
  name?: string;
  emoji?: string;
  mergedInto?: string;
  mergedPaths?: string[];
}

export type AliasMap = Record<string, ProjectAlias | undefined>;

export { formatTokens } from "./formatters";

export function tokensAllIn(t: { input: bigint; output: bigint; cache_read: bigint; cache_create: bigint }): number {
  return Number(t.input) + Number(t.output) + Number(t.cache_read) + Number(t.cache_create);
}

export function totalTok(r: TokenRecord): number {
  return (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
}

export function cacheEffPct(r: TokenRecord): number {
  const denom = (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
  if (!denom) return 0;
  return Math.round((r.cacheReadTokens || 0) / denom * 100);
}

import { resolveMergeChain } from "./merges";
import { isSubagentCwd, isBlacklisted } from "./projects";

export function aggregateByProject(
  tokenHistory: TokenRecord[],
  aliases: AliasMap,
  blacklist: string[] = [],
): ProjectAggregate[] {
  const mergeMap = new Map<string, string>();
  for (const c of Object.keys(aliases)) {
    if (aliases[c]?.mergedInto) mergeMap.set(c, resolveMergeChain(c, aliases));
  }

  const map = new Map<string, ProjectAggregate>();
  for (const r of tokenHistory) {
    if (isSubagentCwd(r.cwd)) continue;
    const key = mergeMap.get(r.cwd || "") || r.cwd || "(unknown)";
    if (isBlacklisted(key, aliases, blacklist)) continue;
    if (!map.has(key)) {
      map.set(key, {
        cwd: key,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
        lastDate: "",
      });
    }
    const p = map.get(key)!;
    p.sessions++;
    p.inputTokens += r.inputTokens || 0;
    p.outputTokens += r.outputTokens || 0;
    p.cacheReadTokens += r.cacheReadTokens || 0;
    p.cacheCreationTokens += r.cacheCreationTokens || 0;
    p.turns += r.turns || 0;
    const ts = r.lastActiveAt || r.recordedAt || r.date || "";
    if (ts > p.lastDate) p.lastDate = ts;
  }
  return Array.from(map.values());
}
