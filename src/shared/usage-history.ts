/**
 * Incremental cache over `get_history`. The store keeps one row per poll per
 * account (48k rows, ~17MB of JSON on this dev's machine), and every
 * `usage-updated` used to re-download all of it once per listener plus once
 * per dashboard chart widget. Now the first read fetches everything, later
 * reads fetch only rows at or after the newest one already held.
 */

import { invoke } from "./ipc";

interface UsageWindow {
  utilization: number;
  resets_at?: string | null;
}
export interface ExtraUsage {
  is_enabled?: boolean;
  used_credits?: number;
  monthly_limit?: number;
}
export interface UsageSnapshot {
  captured_at: string;
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  extra_usage?: ExtraUsage | null;
  account_id?: string | null;
}

// Renderer-facing legacy shape (kept until views consume UsageSnapshot directly).
export interface UsageRecord {
  hour: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  extra_usage: ExtraUsage | null;
  [k: string]: unknown;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

export function toUsageRecord(snap: UsageSnapshot | null | undefined): UsageRecord | null {
  if (!snap || !snap.five_hour || !snap.seven_day) return null;
  const d = new Date(snap.captured_at);
  const hour = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
  return {
    hour,
    session_pct: Math.round(snap.five_hour.utilization),
    weekly_pct: Math.round(snap.seven_day.utilization),
    session_resets_at: snap.five_hour.resets_at || null,
    weekly_resets_at: snap.seven_day.resets_at || null,
    extra_usage: snap.extra_usage || null,
  };
}

/** Same floor the store derives its `timestamp` column with. */
function unixSeconds(capturedAt: string): number {
  return Math.floor(new Date(capturedAt).getTime() / 1000);
}

function rowKey(s: UsageSnapshot): string {
  return `${s.captured_at}|${s.account_id ?? ""}`;
}

let rows: UsageSnapshot[] = [];
/** Unix seconds of the newest cached row; null until the first fetch lands. */
let cursor: number | null = null;
/** Keys of cached rows in the cursor's second: the inclusive re-read returns
 *  them again, and these are what get dropped as duplicates. */
let edgeKeys = new Set<string>();
/** Mapped records per account key ("" = every account), rebuilt on growth. */
let derived = new Map<string, UsageRecord[]>();
let generation = 0;

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

async function fetchDelta(): Promise<void> {
  const gen = generation;
  const fresh = (await invoke<UsageSnapshot[]>("get_history", {
    limit: null,
    accountId: null,
    since: cursor,
  })) || [];
  if (gen !== generation) return;
  let grew = false;
  for (const snap of fresh) {
    const ts = unixSeconds(snap.captured_at);
    if (Number.isNaN(ts)) continue;
    const key = rowKey(snap);
    if (cursor !== null && ts <= cursor && edgeKeys.has(key)) continue;
    rows.push(snap);
    grew = true;
    if (cursor === null || ts > cursor) {
      cursor = ts;
      edgeKeys = new Set();
    }
    if (ts === cursor) edgeKeys.add(key);
  }
  if (grew) derived = new Map();
}

/** One delta fetch at a time. A call landing mid-fetch waits for one more
 *  fetch after it, since the row that prompted it may postdate the running
 *  read; every caller in that burst shares that single follow-up. */
function sync(): Promise<void> {
  if (!running) {
    running = fetchDelta().finally(() => { running = null; });
    return running;
  }
  if (!queued) {
    queued = running.catch(() => {}).then(() => {
      queued = null;
      return sync();
    });
  }
  return queued;
}

/** Usage history ascending, scoped to one account (`null` = every account),
 *  trimmed to the newest `limit` rows when given. */
export async function loadUsageHistory(
  opts: { accountId?: string | null; limit?: number } = {},
): Promise<UsageRecord[]> {
  await sync();
  const key = opts.accountId ?? "";
  let records = derived.get(key);
  if (!records) {
    const scoped = opts.accountId ? rows.filter((s) => s.account_id === opts.accountId) : rows;
    records = scoped.map(toUsageRecord).filter((r): r is UsageRecord => r !== null);
    derived.set(key, records);
  }
  return opts.limit != null ? records.slice(-opts.limit) : records;
}

/** Drop the cache so the next read refetches everything - for when stored
 *  rows were deleted or rewritten rather than appended. */
export function resetUsageHistoryCache(): void {
  generation++;
  rows = [];
  cursor = null;
  edgeKeys = new Set();
  derived = new Map();
}
