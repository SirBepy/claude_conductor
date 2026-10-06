/**
 * Progress + time-estimate tracking for the phone's HTTP transport.
 *
 * Desktop talks to the daemon over a Tauri pipe with no readable byte stream,
 * so this is remote-only by construction: every phone RPC is a single
 * `POST /api/rpc` whose axum `Json` response carries a `Content-Length`, which
 * is the only real denominator available anywhere in the app.
 *
 * Two numbers come out of here and they have different pedigrees:
 *  - the PERCENT is real, measured bytes over that Content-Length, and simply
 *    does not exist before the first byte lands;
 *  - the ESTIMATE is a prediction, the rolling median of this device's own past
 *    durations for that same RPC method.
 *
 * The blend below is what lets both be honest at once: the estimate drives a
 * small leading slice while the request is still in flight, bytes drive the
 * rest, and once elapsed passes the estimate the countdown is abandoned rather
 * than allowed to run negative. Nothing here touches the DOM - `load-dial.ts`
 * renders it, and both boot and the chat overlay poll a tracker at frame rate.
 */

/** Fraction of the bar the pre-first-byte phase is allowed to claim. Bytes map
 *  into the remaining 88%, so the handover never steps backwards. */
const HANDOFF = 0.12;

/** Ceiling every unmeasurable path approaches but never reaches - both the
 *  time-only climb and the overdue arc it hands over to. One value, not two, so
 *  that handover is continuous by construction rather than by matching numbers.
 *  Only a real completion is allowed to render 100%. */
const OVERDUE_CEILING = 0.9;

/** Time constant of the overdue climb, in seconds. Deliberately slow: at the
 *  original 3.5s a load 12s into a 1.8s estimate painted 90%, which reads as
 *  "any moment now" at exactly the point we have admitted we cannot predict it.
 *  At 12s this now lands near 60% instead - still visibly moving, but honestly
 *  far from finished. */
const OVERDUE_TAU_S = 12;

/** Durations kept per method before the oldest is dropped. Ten is enough for
 *  the median to survive a couple of outliers without taking a week to react to
 *  a genuine network change (WiFi to LTE). */
const HISTORY_LEN = 10;

/** First-load fallback on a device with no recorded history yet. Deliberately
 *  one number rather than per-method constants: a wrong-but-stable seed is
 *  replaced by a real measurement after a single load. */
const SEED_MS = 1800;

const STORE_KEY = "cc_load_ms_v1";

export type LoadPhase = "waiting" | "streaming" | "overdue" | "done";

export interface LoadSnapshot {
  phase: LoadPhase;
  /** 0..1 once a number is defensible, `null` while it would be invented. */
  fraction: number | null;
  /** Milliseconds remaining, or `null` when the estimate has been abandoned. */
  etaMs: number | null;
  receivedBytes: number;
  /** `null` when the response carried no Content-Length. */
  totalBytes: number | null;
  elapsedMs: number;
}

// ── Duration history ───────────────────────────────────────────────────────

type DurationStore = Record<string, number[]>;

function readStore(): DurationStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as DurationStore;
  } catch {
    return {};
  }
}

function writeStore(store: DurationStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota - estimates just fall back to the seed */
  }
}

/** Median of the last `HISTORY_LEN` durations for `method`, or `SEED_MS`. */
export function estimateMs(method: string): number {
  const history = readStore()[method];
  if (!history || !history.length) return SEED_MS;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return median && median > 0 ? median : SEED_MS;
}

/** Append a completed duration, trimming to the newest `HISTORY_LEN`. */
export function recordDuration(method: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const store = readStore();
  const next = [...(store[method] ?? []), ms].slice(-HISTORY_LEN);
  store[method] = next;
  writeStore(store);
}

/** Test seam: drop all learned history. */
export function clearDurationHistory(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ── The tracker ────────────────────────────────────────────────────────────

/**
 * One in-flight load. Passive state: the caller pushes byte counts in, the UI
 * polls `snapshot()` at frame rate. Holding no timer of its own means an
 * abandoned tracker cannot leak one.
 */
export class LoadTracker {
  private startedAt: number;
  private received = 0;
  private total: number | null = null;
  private firstByteAt: number | null = null;
  private finishedAt: number | null = null;
  private readonly estimate: number;

  constructor(readonly method: string, now = Date.now()) {
    this.startedAt = now;
    this.estimate = estimateMs(method);
  }

  /** Called once the response head is in, before the body is drained. */
  onHead(contentLength: number | null, now = Date.now()): void {
    if (this.firstByteAt === null) this.firstByteAt = now;
    this.total = contentLength !== null && contentLength > 0 ? contentLength : null;
  }

  onChunk(bytes: number): void {
    this.received += bytes;
  }

  /** Records the duration into the rolling history as a side effect. */
  finish(now = Date.now()): void {
    if (this.finishedAt !== null) return;
    this.finishedAt = now;
    recordDuration(this.method, now - this.startedAt);
  }

  /** Marks the load over WITHOUT polluting the median - for a failed request,
   *  whose duration says nothing about how long a successful one takes. */
  abandon(now = Date.now()): void {
    if (this.finishedAt === null) this.finishedAt = now;
  }

  snapshot(now = Date.now()): LoadSnapshot {
    const elapsedMs = now - this.startedAt;
    const base = {
      receivedBytes: this.received,
      totalBytes: this.total,
      elapsedMs,
    };

    if (this.finishedAt !== null) {
      return { ...base, phase: "done", fraction: 1, etaMs: 0 };
    }

    // Body streaming with a real denominator: the only branch whose percentage
    // is measured rather than predicted.
    if (this.firstByteAt !== null && this.total !== null) {
      const done = Math.min(1, this.received / this.total);
      return {
        ...base,
        phase: "streaming",
        fraction: HANDOFF + done * (1 - HANDOFF),
        etaMs: this.downloadEtaMs(now, done),
      };
    }

    // Past the estimate with nothing measurable to show: stop counting down and
    // let the bar asymptote, so it keeps moving without ever claiming to finish.
    //
    // The curve starts wherever the load actually was when it crossed the
    // estimate, not at a fixed point. A body already streaming without a
    // Content-Length has been climbing on time alone and sits at the branch
    // below's ceiling; anchoring this at HANDOFF instead would snap it from 90%
    // back to 12% in a single frame, which is the exact backward step the whole
    // handoff design exists to prevent.
    if (elapsedMs > this.estimate) {
      const over = (elapsedMs - this.estimate) / 1000;
      const from = this.firstByteAt !== null ? OVERDUE_CEILING : HANDOFF;
      return {
        ...base,
        phase: "overdue",
        fraction: OVERDUE_CEILING - (OVERDUE_CEILING - from) * Math.exp(-over / OVERDUE_TAU_S),
        etaMs: null,
      };
    }

    // Streaming, but chunked with no Content-Length: time is all there is, so
    // it climbs to OVERDUE_CEILING rather than CEILING - landing exactly where
    // the overdue branch above picks up, which is what makes that crossing
    // continuous.
    if (this.firstByteAt !== null) {
      return {
        ...base,
        phase: "streaming",
        fraction: Math.min(OVERDUE_CEILING, elapsedMs / this.estimate),
        etaMs: Math.max(0, this.estimate - elapsedMs),
      };
    }

    return {
      ...base,
      phase: "waiting",
      fraction: null,
      etaMs: Math.max(0, this.estimate - elapsedMs),
    };
  }

  /** Remaining time from the observed transfer rate, falling back to the
   *  method's median until enough of the body has landed for the rate to mean
   *  anything (a 2-byte sample would predict wildly). */
  private downloadEtaMs(now: number, done: number): number {
    const downloadMs = now - (this.firstByteAt ?? now);
    if (downloadMs < 120 || done <= 0.02) {
      return Math.max(0, this.estimate - (now - this.startedAt));
    }
    return Math.max(0, downloadMs / done - downloadMs);
  }
}

// ── Active-load registry ───────────────────────────────────────────────────

const active = new Map<string, LoadTracker>();

/** Newest tracker for `method`, or `null` if one was never started. A finished
 *  load stays readable (phase `done`) so a poller can tell "already finished"
 *  apart from "not started yet". */
export function activeLoad(method: string): LoadTracker | null {
  return active.get(method) ?? null;
}

export function beginLoad(method: string): LoadTracker {
  const tracker = new LoadTracker(method);
  active.set(method, tracker);
  return tracker;
}

/** Test seam: forget every tracked load. */
export function resetActiveLoads(): void {
  active.clear();
}

/**
 * Collapse several parallel loads into one snapshot, for a surface that waits
 * on all of them (cold boot fires its fetches simultaneously and is not usable
 * until every one settles).
 *
 * A method with no tracker yet counts as 0 rather than being skipped, so the
 * aggregate cannot read as nearly-finished just because the only leg that has
 * started happens to be nearly finished.
 */
export function aggregateSnapshot(methods: string[], now = Date.now()): LoadSnapshot {
  if (!methods.length) {
    return { phase: "done", fraction: 1, etaMs: 0, receivedBytes: 0, totalBytes: null, elapsedMs: 0 };
  }

  const legs = methods.map((m) => ({ method: m, snap: active.get(m)?.snapshot(now) ?? null }));

  let fractionSum = 0;
  let receivedBytes = 0;
  let totalBytes = 0;
  let sawTotal = false;
  let elapsedMs = 0;
  let etaMs = 0;
  let anyOverdue = false;
  let anyStreaming = false;
  let anyMeasured = false;
  let allDone = true;

  for (const { method, snap } of legs) {
    if (!snap) {
      allDone = false;
      // Not started: its whole estimated duration is still ahead of us.
      etaMs = Math.max(etaMs, estimateMs(method));
      continue;
    }
    if (snap.phase !== "done") allDone = false;
    if (snap.phase === "overdue") anyOverdue = true;
    if (snap.phase === "streaming") anyStreaming = true;
    if (snap.phase === "done" || snap.fraction !== null) anyMeasured = true;
    fractionSum += snap.phase === "done" ? 1 : (snap.fraction ?? 0);
    receivedBytes += snap.receivedBytes;
    if (snap.totalBytes !== null) {
      totalBytes += snap.totalBytes;
      sawTotal = true;
    }
    elapsedMs = Math.max(elapsedMs, snap.elapsedMs);
    if (snap.etaMs !== null) etaMs = Math.max(etaMs, snap.etaMs);
  }

  const phase: LoadPhase = allDone ? "done" : anyOverdue ? "overdue" : anyStreaming ? "streaming" : "waiting";
  return {
    phase,
    fraction: allDone ? 1 : anyMeasured ? fractionSum / legs.length : null,
    etaMs: anyOverdue ? null : etaMs,
    receivedBytes,
    totalBytes: sawTotal ? totalBytes : null,
    elapsedMs,
  };
}

// ── Response body instrumentation ──────────────────────────────────────────

/**
 * Parse `res` as JSON while feeding byte counts to `tracker`.
 *
 * Only a readable stream can report progress, so the body is drained chunk by
 * chunk when one is available and read whole otherwise. The degraded paths
 * (`text()`, then `json()`) still return the right value with no intermediate
 * percentage, which keeps this a drop-in for a plain `res.json()` - an
 * environment without streams, such as an older WebView or a test double, loses
 * the dial but never the data.
 */
export async function readTrackedJson<T>(
  res: Response,
  tracker: LoadTracker,
  onChunk?: () => void,
): Promise<T> {
  const header = res.headers?.get?.("Content-Length");
  const total = header !== null && header !== undefined ? Number(header) : NaN;
  tracker.onHead(Number.isFinite(total) ? total : null);

  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    if (typeof res.text === "function") return JSON.parse(await res.text()) as T;
    return (await res.json()) as T;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      tracker.onChunk(value.byteLength);
      onChunk?.();
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged)) as T;
}
