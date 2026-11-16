// A sub's `blocker` card that only states a fact is not a blocker. The daemon draws
// none now (a landing, a clean move and a leftover build folder go to the app log,
// and a sub's own blocker never keeps tone "good"), but logs written by older builds
// still hold them, red in Waiting on you with nothing for Joe to do: "Merged / Its
// commits are now in master." (tone good), "Moved with its worktree" and "Build
// folder left". A blocker is red by kind (chat-message-card.ts), so "good" can only
// mean the card was never one.

import type { SubCardEntry } from "../subchat-cards";

/** Verdicts older daemons put on a blocker card that was only a notice. "Worktree kept"
 *  is not here: it still means work Joe could lose. */
const NOTICE_VERDICTS: ReadonlySet<string> = new Set(["Moved with its worktree", "Build folder left"]);

/** The card says something went well or only informs, so no one is waiting on it. */
export function isGoodNews(card: Pick<SubCardEntry, "kind" | "tone" | "verdict">): boolean {
  return card.kind === "blocker" && (card.tone === "good" || NOTICE_VERDICTS.has(card.verdict));
}
