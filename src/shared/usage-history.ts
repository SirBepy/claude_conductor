/**
 * Incremental cache over `get_history`. The store keeps one row per poll per
 * account (48k rows, ~17MB of JSON on this dev's machine), and every
 * `usage-updated` used to re-download all of it once per listener plus once
 * per dashboard chart widget. Desktop's first read fetches everything and later
 * reads fetch only rows at or after the newest one already held. The phone
 * (after `enableUsageHistoryPersistence`) holds only the last WINDOW_DAYS days,
 * saved between launches, and `loadUsageHistory({ fromMs })` extends it back.
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
  /** False when the plan has no 5h limit at all; absent on rows saved earlier. */
  five_hour_limited?: boolean;
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
  /** False when the plan has no 5h limit, so views draw no 5h ring. Undefined reads as limited. */
  session_limited?: boolean;
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
    session_limited: snap.five_hour_limited !== false,
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

/** What the phone saves between launches: the rows it holds and the span they
 *  cover. `floor` is the oldest second the rows are complete from (the span may
 *  start before the first row), `cursor` the newest row's second. */
export interface StoredUsageHistory {
  rows: UsageSnapshot[];
  floor: number;
  cursor: number;
}

/** Where the phone keeps {@link StoredUsageHistory}. Calls never reject: a
 *  store that cannot read or write behaves as an empty one. */
export interface UsageHistoryStore {
  load(): Promise<StoredUsageHistory | null>;
  save(stored: StoredUsageHistory): Promise<void>;
  clear(): Promise<void>;
}

/** Days of history held up front. The charts draw a 5h and a 7d window and look
 *  one window back to decide whether a "previous" arrow shows, so the current
 *  week plus the week before it must be present; the rest is slack. */
const WINDOW_DAYS = 15;

let persistence: UsageHistoryStore | null = null;
/** Serialises every store call, so a clear queued by a reset can never be
 *  overtaken by a save that was queued before it. */
let storeOps: Promise<unknown> = Promise.resolve();
let hydration: Promise<void> | null = null;

function queueStoreOp<T>(op: () => Promise<T>): Promise<T> {
  const run = storeOps.then(op, op);
  storeOps = run.catch(() => {});
  return run;
}

/** Phone only (desktop reads the local database over a pipe and keeps nothing).
 *  Switches the cache from "download every stored poll once per launch" to
 *  "hold the last {@link WINDOW_DAYS} days, saved in `store`, and download only
 *  what is newer than the saved copy". Older rows come on demand through
 *  `loadUsageHistory({ fromMs })`. */
export function enableUsageHistoryPersistence(store: UsageHistoryStore): void {
  persistence = store;
  addFlushListeners();
  resetMemory();
}

let rows: UsageSnapshot[] = [];
/** Oldest unix second the held rows are complete from; null while unbounded
 *  (desktop) or before the first fetch of a bounded cache lands. */
let floor: number | null = null;
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

function windowStart(): number {
  return Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400;
}

function rowsBetween(list: UsageSnapshot[], from: number, to: number): number {
  let n = 0;
  for (const s of list) {
    const ts = unixSeconds(s.captured_at);
    if (ts >= from && ts <= to) n++;
  }
  return n;
}

/** Loads the saved copy once per launch, and keeps it only if it is still the
 *  PC's data: the PC counts its rows over the saved span, and a different count
 *  means retention or a clear removed rows the phone would keep drawing. Any
 *  failure leaves the cache empty, which costs one window download and nothing
 *  else. */
function hydrate(): Promise<void> {
  if (!hydration) {
    const store = persistence;
    hydration = !store ? Promise.resolve() : (async () => {
      const gen = generation;
      const stored = await queueStoreOp(() => store.load()).catch(() => null);
      if (!stored || gen !== generation) return;
      const start = windowStart();
      if (stored.cursor < start) return;
      let count: number;
      try {
        const meta = await invoke<{ count: number }>("get_history_meta", {
          since: stored.floor,
          until: stored.cursor,
        });
        count = meta?.count;
      } catch {
        return;
      }
      if (gen !== generation || count !== rowsBetween(stored.rows, stored.floor, stored.cursor)) return;
      // Rows older than the window are dropped so the saved copy does not grow
      // by every page the user ever scrolled back through.
      const kept = stored.rows.filter((s) => unixSeconds(s.captured_at) >= start);
      rows = kept;
      floor = Math.max(stored.floor, start);
      cursor = stored.cursor;
      edgeKeys = new Set(kept.filter((s) => unixSeconds(s.captured_at) === cursor).map(rowKey));
      derived = new Map();
    })();
  }
  return hydration;
}

/** Minimum gap between saves driven by new poll rows. The saved blob is about
 *  whole 15-day window, and handing it to IndexedDB is a structured clone on
 *  the main thread (about 15ms per 2MB on a desktop V8), so a save per poll is
 *  jank for a few hundred bytes of change. A save skipped here loses nothing: the saved copy
 *  is always a consistent floor/cursor/rows snapshot, so the next launch just
 *  re-reads the newer rows from the PC. */
const SAVE_INTERVAL_MS = 60_000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaveAt = 0;
let flushListenersAdded = false;

function persist(): void {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  const store = persistence;
  if (!store || floor === null || cursor === null) return;
  lastSaveAt = Date.now();
  const snapshot: StoredUsageHistory = { rows: rows.slice(), floor, cursor };
  void queueStoreOp(() => store.save(snapshot)).catch(() => {});
}

/** Save for rows a poll appended: at once if the last save is over a minute
 *  old, otherwise one trailing save at the minute mark (later rows join it). */
function persistSoon(): void {
  if (!persistence || saveTimer !== null) return;
  const wait = lastSaveAt + SAVE_INTERVAL_MS - Date.now();
  if (wait <= 0) persist();
  else saveTimer = setTimeout(persist, wait);
}

/** Settles a held save when the page is hidden or going away, the last moment
 *  the phone is sure to run any script. */
function flushHeldSave(): void {
  if (saveTimer !== null) persist();
}

function addFlushListeners(): void {
  if (flushListenersAdded || typeof document === "undefined" || typeof window === "undefined") return;
  flushListenersAdded = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHeldSave();
  });
  window.addEventListener("pagehide", flushHeldSave);
}

async function fetchDelta(): Promise<void> {
  // Awaited only when there is a saved copy: desktop issues its fetch in the
  // same tick it always did.
  if (persistence) await hydrate();
  const gen = generation;
  const since = cursor ?? floor ?? (persistence ? windowStart() : null);
  const fresh = (await invoke<UsageSnapshot[]>("get_history", {
    limit: null,
    accountId: null,
    since,
  })) || [];
  if (gen !== generation) return;
  if (persistence && floor === null) floor = since;
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
  if (grew) {
    derived = new Map();
    persistSoon();
  }
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

let backQueue: Promise<void> = Promise.resolve();

/** Fetches the rows older than the held span down to `fromMs`. Calls are
 *  serialised and each re-checks the floor, so four chart widgets asking for the
 *  same week cost one download. */
function ensureBack(fromMs: number): Promise<void> {
  const run = backQueue.then(async () => {
    await sync();
    const want = Math.floor(fromMs / 1000);
    if (floor === null || want >= floor) return;
    const gen = generation;
    const until = floor;
    const older = (await invoke<UsageSnapshot[]>("get_history", {
      limit: null,
      accountId: null,
      since: want,
      until,
    })) || [];
    if (gen !== generation) return;
    rows = older.filter((s) => unixSeconds(s.captured_at) < until).concat(rows);
    floor = want;
    derived = new Map();
    persist();
  });
  backQueue = run.catch(() => {});
  return run;
}

/** Usage history ascending, scoped to one account (`null` = every account),
 *  trimmed to the newest `limit` rows when given. On the phone the cache holds
 *  the recent days only; `fromMs` extends it back to that time first, for a
 *  chart paged to an older window. */
export async function loadUsageHistory(
  opts: { accountId?: string | null; limit?: number; fromMs?: number } = {},
): Promise<UsageRecord[]> {
  if (persistence && opts.fromMs != null) await ensureBack(opts.fromMs);
  else await sync();
  const key = opts.accountId ?? "";
  let records = derived.get(key);
  if (!records) {
    const scoped = opts.accountId ? rows.filter((s) => s.account_id === opts.accountId) : rows;
    records = scoped.map(toUsageRecord).filter((r): r is UsageRecord => r !== null);
    derived.set(key, records);
  }
  return opts.limit != null ? records.slice(-opts.limit) : records;
}

function resetMemory(): void {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  lastSaveAt = 0;
  generation++;
  rows = [];
  floor = null;
  cursor = null;
  edgeKeys = new Set();
  derived = new Map();
  hydration = null;
}

/** Drop the cache so the next read refetches everything - for when stored
 *  rows were deleted or rewritten rather than appended. The saved copy goes
 *  too, or the next launch would load the rows this was called to discard. */
export function resetUsageHistoryCache(): void {
  resetMemory();
  const store = persistence;
  if (store) void queueStoreOp(() => store.clear()).catch(() => {});
}
