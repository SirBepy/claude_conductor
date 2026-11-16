// A sub's `blocker` card that states a success is not a blocker. Nothing draws one
// now (a landing goes to the app log, a retired blocker is retracted), but logs
// written by older builds still hold "Merged" cards with tone "good" that sat in
// Waiting on you in red with nothing for Joe to do. A blocker is red by kind
// (chat-message-card.ts), so "good" can only mean the card was never one.

import type { SubCardEntry } from "../subchat-cards";

/** The card says something went well, so no one is waiting on it. */
export function isGoodNews(card: Pick<SubCardEntry, "kind" | "tone">): boolean {
  return card.kind === "blocker" && card.tone === "good";
}
