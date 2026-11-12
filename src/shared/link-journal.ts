/**
 * The phone's own record of what its connection did, uploaded to the PC.
 *
 * The daemon's log only shows connections that succeeded, so a "the phone keeps
 * disconnecting" report could not be diagnosed from the PC alone. The page notes
 * its stream and visibility events here; on the Android shell the tunnel's own
 * journal (read from the shell's dedicated journal port, the page's own port + 1) is merged in; both go
 * to the daemon through `report_link_journal`, which writes them into its log.
 *
 * Phone only: every export is a no-op unless `isRemote()`. Events carry kinds
 * and short details, never tokens, full session ids, message text or URLs.
 */

import { getTransport, isRemote } from "./transport";
import { isAndroidShell } from "./mobile/android-shell";
import { readShellVersion } from "./shell-version";

interface JournalEvent {
  t: number;
  k: string;
  d: string;
}

/** `s` numbers page events so the upload mark survives the ring dropping the oldest. */
interface StoredEvent extends JournalEvent {
  s: number;
}

interface Stored {
  events: StoredEvent[];
  nextSeq: number;
  /** Highest page event `s` the daemon already has. */
  upSeq: number;
  /** Newest tunnel event time the daemon already has. */
  upTunnelT: number;
}

/** Holds the ring and what was already uploaded, so the events leading up to a
 *  WebView reload or an Android process kill, which are exactly the ones worth
 *  reporting, are still there to upload after the page comes back. In memory
 *  alone they would be gone before any upload could carry them. */
const STORAGE_KEY = "conductor_link_journal";
const RING_MAX = 200;
const PERSIST_MIN_GAP_MS = 2_000;
/** The daemon drops a second call inside 5s from one device; 6s keeps clear of it. */
const FLUSH_MIN_GAP_MS = 6_000;
const FLUSH_BATCH = 50;
const TUNNEL_FETCH_TIMEOUT_MS = 3_000;
const LINE_MAX = 300;
const AFTER_STREAM_OPEN_MS = 3_000;
const VISIBLE_TICK_MS = 60_000;

let loaded = false;
let events: StoredEvent[] = [];
let nextSeq = 1;
let upSeq = 0;
let upTunnelT = 0;

let lastWriteAt = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let lastFlushAt = Number.NEGATIVE_INFINITY;
let flushing = false;
let mounted = false;
let afterOpenTimer: ReturnType<typeof setTimeout> | undefined;
/** When each socket opened, so its close or stale event can say how old it was. */
const openedAt = new Map<string, number>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Stored> | null;
    if (!parsed || !Array.isArray(parsed.events)) return;
    events = parsed.events
      .filter((e) => e && typeof e.t === "number" && typeof e.k === "string" && typeof e.s === "number")
      .map((e) => ({ t: e.t, k: e.k, d: typeof e.d === "string" ? e.d : "", s: e.s }))
      .slice(-RING_MAX);
    const top = events.reduce((m, e) => Math.max(m, e.s), 0);
    nextSeq = Math.max(typeof parsed.nextSeq === "number" ? parsed.nextSeq : 1, top + 1);
    upSeq = typeof parsed.upSeq === "number" ? parsed.upSeq : 0;
    upTunnelT = typeof parsed.upTunnelT === "number" ? parsed.upTunnelT : 0;
  } catch {
    events = [];
  }
}

function writeNow(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  lastWriteAt = Date.now();
  try {
    const record: Stored = { events, nextSeq, upSeq, upTunnelT };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage full or unavailable: the journal just stays in memory */
  }
}

function schedulePersist(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(writeNow, Math.max(0, PERSIST_MIN_GAP_MS - (Date.now() - lastWriteAt)));
}

/** Writes the mirror at once (pagehide, and tests). */
export function persistLinkJournalNow(): void {
  if (!isRemote()) return;
  ensureLoaded();
  writeNow();
}

function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

/** The socket an event belongs to: the one global stream, or a chat by its short id. */
function socketKey(kind: string, detail: string): string | null {
  if (kind.startsWith("gws_")) return "gws";
  if (kind.startsWith("cws_")) return `cws|${detail.split(" ")[0]}`;
  return null;
}

/** Records one page event. */
export function note(kind: string, detail = ""): void {
  if (!isRemote()) return;
  ensureLoaded();
  const now = Date.now();
  let d = detail;
  const key = socketKey(kind, detail);
  if (key) {
    if (kind.endsWith("_open")) {
      openedAt.set(key, now);
    } else if (kind.endsWith("_close") || kind.endsWith("_stale")) {
      const since = openedAt.get(key);
      if (since !== undefined) d = `${d ? `${d} ` : ""}age=${Math.round((now - since) / 1000)}s`;
      if (kind.endsWith("_close")) openedAt.delete(key);
    }
  }
  events.push({ t: now, k: clean(kind), d: clean(d), s: nextSeq++ });
  if (events.length > RING_MAX) events.splice(0, events.length - RING_MAX);
  schedulePersist();
  if (kind === "gws_open") scheduleFlushAfterStreamOpen();
}

/** A request that ended with no answer from the PC (fetch error or the silence timeout). */
export function noteRequestFailure(method: string, silence: boolean): void {
  note("req_fail", `${method} ${silence ? "silence" : "fetch"}`);
}

/** Test seam: the ring as it stands. */
export function journalEvents(): JournalEvent[] {
  ensureLoaded();
  return events.map(({ t, k, d }) => ({ t, k, d }));
}

interface Line {
  t: number;
  src: "p" | "t";
  kind: string;
  detail: string;
  s: number;
}

/** The tunnel's journal listener is the page's own port + 1. A same-origin fetch
 *  would travel on one of the WebView's reused keep-alive connections, which are
 *  already spliced to the PC, so the tunnel never sees it as a first request. */
function tunnelJournalUrl(): string | null {
  if (typeof location === "undefined" || location.hostname !== "127.0.0.1") return null;
  const port = Number(location.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65535) return null;
  return `http://127.0.0.1:${port + 1}/`;
}

/** What the Android shell's tunnel recorded, or nothing: an older shell has no
 *  journal port, so the fetch is refused at once (or, if something else holds that
 *  port, fails the content check). The short timeout keeps a stuck port from
 *  holding the upload. */
async function fetchTunnelEvents(): Promise<Line[]> {
  if (!isAndroidShell()) return [];
  const url = tunnelJournalUrl();
  if (!url) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TUNNEL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: abort.signal });
    if (!res.ok) return [];
    if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) return [];
    const body = (await res.json()) as { v?: unknown; events?: unknown };
    if (body?.v !== 1 || !Array.isArray(body.events)) return [];
    const out: Line[] = [];
    for (const e of body.events as Partial<JournalEvent>[]) {
      if (!e || typeof e.t !== "number" || typeof e.k !== "string" || e.t <= upTunnelT) continue;
      out.push({ t: e.t, src: "t", kind: clean(e.k), detail: typeof e.d === "string" ? clean(e.d) : "", s: 0 });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function formatLine(l: Line): string {
  const text = `${new Date(l.t).toISOString()} ${l.src} ${l.kind}${l.detail ? ` ${l.detail}` : ""}`;
  return text.slice(0, LINE_MAX);
}

/** Uploads what the daemon does not have yet, oldest first, one batch per call. */
export async function flush(): Promise<void> {
  if (!isRemote() || flushing) return;
  ensureLoaded();
  if (Date.now() - lastFlushAt < FLUSH_MIN_GAP_MS) return;
  flushing = true;
  try {
    const tunnel = await fetchTunnelEvents();
    const page: Line[] = events
      .filter((e) => e.s > upSeq)
      .map((e) => ({ t: e.t, src: "p", kind: e.k, detail: e.d, s: e.s }));
    // Array.sort is stable, so equal times keep the page's events first.
    const batch = [...page, ...tunnel].sort((a, b) => a.t - b.t).slice(0, FLUSH_BATCH);
    if (batch.length === 0) return;
    lastFlushAt = Date.now();
    try {
      const answer = await getTransport().call("report_link_journal", { lines: batch.map(formatLine) });
      // The PC answers a call inside its 5s per-device window with kept 0. An
      // answer without a numeric `kept` is an older PC, which keeps everything.
      const kept = (answer as { kept?: unknown } | null | undefined)?.kept;
      if (typeof kept === "number" && kept === 0) return;
    } catch {
      return; // silent: the same events go with the next flush
    }
    for (const l of batch) {
      if (l.src === "p") upSeq = Math.max(upSeq, l.s);
      else upTunnelT = Math.max(upTunnelT, l.t);
    }
    schedulePersist();
  } finally {
    flushing = false;
  }
}

function hasPageEventsWaiting(): boolean {
  return events.some((e) => e.s > upSeq);
}

function scheduleFlushAfterStreamOpen(): void {
  // A reconnect just succeeded: the moment the daemon can be reached again.
  if (!mounted || afterOpenTimer !== undefined) return;
  afterOpenTimer = setTimeout(() => {
    afterOpenTimer = undefined;
    void flush();
  }, AFTER_STREAM_OPEN_MS);
}

/** Wires the page listeners and timers; call once at phone boot. */
export function mountLinkJournal(): () => void {
  if (!isRemote() || typeof window === "undefined" || typeof document === "undefined") return () => {};
  ensureLoaded();
  mounted = true;
  const shell = readShellVersion();
  note("boot", `android=${isAndroidShell() ? 1 : 0}${shell ? ` shell=${shell}` : ""}`);

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      note("visible");
      void flush();
    } else {
      note("hidden");
      // A hidden page may be killed without another event.
      writeNow();
    }
  };
  const onOnline = (): void => note("online");
  const onOffline = (): void => note("offline");
  const onPageHide = (): void => writeNow();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pagehide", onPageHide);
  const tick = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    // The shell's tunnel keeps its own events, so on Android a flush always has something to ask.
    if (hasPageEventsWaiting() || isAndroidShell()) void flush();
  }, VISIBLE_TICK_MS);

  return () => {
    mounted = false;
    clearInterval(tick);
    if (afterOpenTimer !== undefined) {
      clearTimeout(afterOpenTimer);
      afterOpenTimer = undefined;
    }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pagehide", onPageHide);
  };
}
