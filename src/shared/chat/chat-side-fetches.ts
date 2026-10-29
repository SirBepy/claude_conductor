// The two fetches a chat open makes beside the history page: the durable skip
// marks and the repo-channel backlog. Both ride the daemon
// pipe, whose calls have no timeout, so the open gives them a short grace past
// the history page and paints without them if they are slower.

import { invoke } from "../ipc";
import { perfPhase } from "../perf";
import { normalizeSkipMarks, type SkipMark } from "./skip-marks";
import { fetchChannelMessages } from "./peer-channel";
import type { ChannelMessage } from "../../types/ipc.generated";

/** How long a chat open waits on the skip-mark and channel-backlog fetches
 *  after the history page is in. Both answer in under 1ms on a healthy daemon
 *  (measured 2026-10-29), so this only ever fires on a stuck pipe. */
export const SIDE_FETCH_GRACE_MS = 500;

export type SideAnswer = [SkipMark[], ChannelMessage[] | undefined];

/** Best-effort: a fetch failure just means no skip fold this load, not a
 *  broken history load (mirrors sessionEvents.loadInitial's own tolerance). */
export async function fetchSkipMarks(sessionId: string): Promise<SkipMark[]> {
  try {
    return normalizeSkipMarks(await invoke<unknown>("get_skipped_question_marks", { sessionId }));
  } catch {
    return [];
  }
}

/** Timed apart: the two run in parallel, so the slowest one gates first paint
 *  and a single combined phase would not say which. */
export function timedPhase<T>(sid: string, label: string, p: Promise<T>): Promise<T> {
  const done = perfPhase(`chat-open ${label}`, () => `session=${sid}`);
  // Side branch, not `p.finally(...)`: returning a derived promise adds
  // microtask hops to the load, which races-sensitive callers count.
  p.then(done, done);
  return p;
}

export function startSideFetches(sid: string): Promise<SideAnswer> {
  return Promise.all([
    timedPhase(sid, "skip-marks", fetchSkipMarks(sid)),
    timedPhase(sid, "channel-messages", fetchChannelMessages(sid)),
  ]);
}

/** The answer if both fetches land within the grace, else null (the caller
 *  paints without them and applies `sides` in place whenever it resolves). */
export async function raceSideFetches(sides: Promise<SideAnswer>): Promise<SideAnswer | null> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol("late");
  const settled = await Promise.race([
    sides,
    new Promise<typeof late>((resolve) => { graceTimer = setTimeout(() => resolve(late), SIDE_FETCH_GRACE_MS); }),
  ]);
  clearTimeout(graceTimer);
  return settled === late ? null : settled;
}
