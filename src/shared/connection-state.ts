/**
 * Phone-to-PC link health, fed by the HTTP transport and the global stream and
 * read by the reconnect strip (reconnect-strip.ts). Remote-only by
 * construction: only the phone's transport ever reports into it.
 *
 * Two failure shapes matter after the phone resumes, and they look different:
 *  - the live stream dropped, or requests are erroring/timing out: the link is
 *    down and the strip says it is reconnecting;
 *  - the link looks fine but a request has been in flight for a while: that
 *    request's own progress is shown, so a slow load never looks like a hang.
 */

import type { LoadSnapshot, LoadTracker } from "./load-progress";

/** How long a request may run before the strip mentions it. Warm requests
 *  finish well inside this, so the strip stays out of normal use. */
export const SLOW_REQUEST_MS = 4_000;

/** Reads the phone issues on a timer or on resume with nobody waiting on the
 *  answer. They still report failures, but a slow one must never raise the
 *  "Waiting for your PC" strip: only a read the user is waiting on may. */
export const BACKGROUND_READS: ReadonlySet<string> = new Set([
  // 700ms prompt poll (views/sessions/permission-modal/index.ts)
  "list_pending_prompts",
  // degrade poll while the global stream is down (shared/global-stream.ts)
  "list_instances",
  // refetch on every visibilitychange to visible (views/sessions/hidden-sessions-sync.ts)
  "get_hidden_chats",
  // usage header re-render on a timer and on visibilitychange (views/sessions/usage-dials.ts)
  "get_usage_map",
  "list_accounts",
  // live cross-device sync of an open question card (views/sessions/permission-modal/question-ui.ts)
  "get_session_drafts",
  // servers chip poll every 8s (views/sessions/statusbar-data.ts, servers-popover.ts)
  "list_project_servers",
]);

/** How long the link must stay ok before a still-pending chat load is called
 *  stalled. Counted only while the link is ok: a down or slow link already has
 *  the strip as its message. */
export const LOAD_STALL_MS = 8_000;

export type LinkSnapshot =
  | { kind: "ok" }
  | { kind: "reconnecting"; elapsedMs: number }
  | { kind: "slow"; elapsedMs: number; method: string; load: LoadSnapshot };

let everLive = false;
let liveDown = false;
let failing = false;
let downSince: number | null = null;
const inFlight = new Set<{ method: string; tracker: LoadTracker; startedAt: number }>();

function refreshDownSince(now: number): void {
  const down = (liveDown && everLive) || failing;
  if (down && downSince === null) downSince = now;
  if (!down) downSince = null;
}

/** The global stream opened (or a frame arrived on it). */
export function markLiveUp(now = Date.now()): void {
  everLive = true;
  liveDown = false;
  refreshDownSince(now);
}

/** The global stream closed or went stale. Ignored until it has been up once,
 *  so the cold-boot overlay is never doubled by a "reconnecting" strip. */
export function markLiveDown(now = Date.now()): void {
  liveDown = true;
  refreshDownSince(now);
}

/** A request failed at the network level (no HTTP response, or it timed out). */
export function reportRequestFailure(now = Date.now()): void {
  failing = true;
  refreshDownSince(now);
}

/** Any HTTP response at all proves the PC is reachable again. */
export function reportRequestSuccess(now = Date.now()): void {
  failing = false;
  refreshDownSince(now);
}

/** The page became visible again. Time spent hidden says nothing about the
 *  link (timers were frozen, the strip's tick was paused), so every running
 *  clock restarts from now. */
export function noteResumed(now = Date.now()): void {
  if (downSince !== null) downSince = now;
  for (const entry of inFlight) entry.startedAt = now;
}

/** True once the link has been ok for LOAD_STALL_MS in a row; feed it from a
 *  timer. Any non-ok reading restarts the count. */
export function createStallClock(start = Date.now()): (now?: number) => boolean {
  let okSince: number | null = linkSnapshot(start).kind === "ok" ? start : null;
  return (now = Date.now()) => {
    if (linkSnapshot(now).kind !== "ok") {
      okSince = null;
      return false;
    }
    okSince ??= now;
    return now - okSince >= LOAD_STALL_MS;
  };
}

/** Registers an in-flight request; call the returned function when it settles. */
export function trackRequest(method: string, tracker: LoadTracker, now = Date.now()): () => void {
  const entry = { method, tracker, startedAt: now };
  inFlight.add(entry);
  return () => { inFlight.delete(entry); };
}

export function linkSnapshot(now = Date.now()): LinkSnapshot {
  if (downSince !== null) return { kind: "reconnecting", elapsedMs: now - downSince };
  let oldest: { method: string; tracker: LoadTracker; startedAt: number } | null = null;
  for (const entry of inFlight) {
    if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
  }
  if (!oldest || now - oldest.startedAt < SLOW_REQUEST_MS) return { kind: "ok" };
  return { kind: "slow", elapsedMs: now - oldest.startedAt, method: oldest.method, load: oldest.tracker.snapshot(now) };
}

/** Test seam. */
export function resetConnectionState(): void {
  everLive = false;
  liveDown = false;
  failing = false;
  downSince = null;
  inFlight.clear();
}
