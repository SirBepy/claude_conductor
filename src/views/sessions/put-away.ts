// A project's main chat can be put away (pc-1806): hidden, its subs paused, nothing deleted. The
// daemon marks the OPEN row with `hidden_at` (daemon/subchats/put_away.rs), so every list reads
// that one field. This file is the front end's only reader of it, so the heads, the palette, the
// chat menu and the pane never disagree about what "put away" means.
//
// Not the hand-hide list (`loadHiddenSessions`, hidden-chats.json): that is Joe's own "Hide chat"
// and pauses nothing. A put-away chat sits in the same Hidden stack but cannot be unhidden by hand:
// only a reopen brings it back.

import type { Instance } from "../../types/ipc.generated";
import { loadHiddenSessions } from "./sessions-helpers";

/** The chat is a main chat the daemon put away (an open row carrying `hidden_at`). */
export function isPutAway(s: Pick<Instance, "hidden_at" | "ended_at"> | undefined | null): boolean {
  return !!s && !!s.hidden_at && !s.ended_at;
}

/** The put-away main chat `s` belongs to: itself, or the main chat of a sub it hides. */
export function putAwayMainOf(s: Instance, sessions: readonly Instance[]): Instance | null {
  if (isPutAway(s) && !s.subchat_of) return s;
  if (!s.subchat_of) return null;
  const main = sessions.find((x) => x.session_id === s.subchat_of);
  return main && isPutAway(main) ? main : null;
}

/** The chat is the put-away main chat or one of its subs: both leave the stack for the Hidden view. */
export function inPutAwayFamily(s: Instance, sessions: readonly Instance[]): boolean {
  return putAwayMainOf(s, sessions) !== null;
}

/** Subs of a put-away main chat that the pause froze: the ones with work left. A finished or
 *  ended sub has nothing to resume, so it is not "paused". */
export function pausedSubs(mainId: string, sessions: readonly Instance[]): Instance[] {
  return sessions.filter((s) => s.subchat_of === mainId && !s.ended_at && !s.subchat_finished);
}

/** "Put away, 3 subs paused" for a main chat; "Paused" for one of its subs. */
export function putAwayLine(main: Instance, sessions: readonly Instance[]): string {
  const n = pausedSubs(main.session_id, sessions).length;
  if (n === 0) return "Put away, nothing to resume";
  return `Put away, ${n} ${n === 1 ? "sub" : "subs"} paused`;
}

/** Every id the Hidden view lists: Joe's own hidden chats plus every put-away chat and its pinned
 *  subs. One set so the stack, the eye's count, the palette and the menus read the same thing. */
export function hiddenIdsOf(sessions: readonly Instance[]): Set<string> {
  const out = loadHiddenSessions();
  for (const s of sessions) if (inPutAwayFamily(s, sessions)) out.add(s.session_id);
  return out;
}
