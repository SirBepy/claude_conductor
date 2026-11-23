// A project's main chat can be put away (pc-1806): closed, its subs paused, nothing deleted. The
// daemon marks the OPEN row with `hidden_at` (daemon/subchats/put_away.rs) and leaves the row and its
// subs out of every list it hands a client (`put_away::without_family`), so a put-away chat is in no
// sidebar, head, palette, count or card. The one way back is a reopen: the project dashboard's "Open
// main chat" and a new chat's "Reopens ..." line read the hidden rows through `readPutAway` and
// `withPutAway`, and nothing else does.
//
// The helpers below read `hidden_at` themselves for a row that still arrives in a list (an older
// daemon that does not filter), so the heads, the palette, the chat menu and the pane never disagree
// about what "put away" means.
//
// Not the hand-hide list (`loadHiddenSessions`, hidden-chats.json): that is Joe's own "Hide chat"
// and pauses nothing.

import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import type { Instance } from "../../types/ipc.generated";
import { loadHiddenSessions } from "./sessions-helpers";

/** The put-away main chats and their subs, for the reopen doors. Empty on the phone (it cannot
 *  reopen) and whenever the daemon has none or the read fails: a missing door is better than a
 *  broken list. */
export async function readPutAway(background = true): Promise<Instance[]> {
  if (isRemote()) return [];
  try {
    return (await invoke<Instance[]>("list_put_away", undefined, { background })) ?? [];
  } catch {
    return [];
  }
}

/** The listing plus the put-away family the daemon keeps out of it: what the reopen doors search.
 *  A row in both (a daemon that does not filter) counts once. */
export function withPutAway(sessions: readonly Instance[], putAway: readonly Instance[]): Instance[] {
  if (putAway.length === 0) return sessions as Instance[];
  const seen = new Set(sessions.map((s) => s.session_id));
  return [...sessions, ...putAway.filter((s) => !seen.has(s.session_id))];
}

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
