// A question card that can no longer be answered must not stay under Waiting on
// you. The transcript only says a card is open until an answer or a Skip lands in
// it, so a card whose request died with nothing writing either (an app restart
// from before the daemon dropped such cards, a turn the daemon never heard
// ended) read "awaiting answer" for good, and clicking it only toasted "This
// question can no longer be reopened" (Joe, 2026-11-21).
//
// Only a card Joe cannot bring back is judged: a card in the loaded page can be
// rebuilt from the transcript and answered even after a daemon restart (resurface.ts
// reopenPendingPrompt), so it stays. A card above the loaded page has no such way,
// and the daemon's list of held prompts is the one thing left that knows it is
// answerable: held, it stays; held by nothing, it is dead and is settled as a Skip
// would settle it, so the mark survives a reload.

import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import { cardQuestionTexts, questionTextsOf, sameQuestions } from "../../../shared/chat/question-texts";
import { rowMs } from "../../../shared/chat/dashboard/dashboard-model";
import { getTransport } from "../../../shared/transport";
import { findPendingPromptsForSession } from "../permission-modal/remote-prompt-poll";
import type { QuestionRequestedPayload } from "../permission-modal/types";

/** Announced on `window` once a card was settled outside the dashboard (a click
 *  on one that cannot be reopened), so the dashboard stops listing it at once. */
export const QUESTION_SETTLED_EVENT = "question-settled";

/** A card this young may be one the daemon has not registered yet (the tool call
 *  reaches the daemon after the transcript line is written), so it is left alone. */
export const LIVENESS_GRACE_MS = 120_000;

/** The open `cards` no held prompt answers for. A prompt matches its card by id,
 *  or by what it asks (a prompt keyed by a random daemon id: from before the ids
 *  matched, or when Claude Code sent no tool_use id); each prompt covers one
 *  card, and a doubtful match keeps the card, never settles it. A card younger than the grace (`since`
 *  gives when each was first known, for a row with no stamp) is never dead. */
export function deadQuestionCards(
  cards: readonly RenderedMessage[],
  held: readonly Pick<QuestionRequestedPayload, "id" | "questions">[],
  now: number,
  since: ReadonlyMap<string, number> = new Map(),
): RenderedMessage[] {
  let rest = [...held];
  const covered = new Set<RenderedMessage>();
  // By id for every card first: a dead card asking the same thing as a live one
  // must not take the live card's prompt.
  for (const card of cards) {
    const byId = rest.find((p) => p.id === card.id);
    if (!byId) continue;
    rest = rest.filter((p) => p !== byId);
    covered.add(card);
  }
  // Then by what each asks, newest card first: a prompt the daemon still holds is
  // the latest ask of its questions (an older card asking the same thing was
  // asked again and left behind), so the dead one must not be the newer.
  const dead: RenderedMessage[] = [];
  for (const card of [...cards].reverse()) {
    if (!card.id || covered.has(card)) continue;
    const asked = cardQuestionTexts(card);
    const prompt = rest.find((p) => sameQuestions(asked, questionTextsOf(p.questions)));
    if (prompt) {
      rest = rest.filter((p) => p !== prompt);
      continue;
    }
    if (now - cardStart(card, since) >= LIVENESS_GRACE_MS) dead.push(card);
  }
  return cards.filter((c) => dead.includes(c));
}

function cardStart(card: RenderedMessage, since: ReadonlyMap<string, number>): number {
  const ts = rowMs(card);
  return ts > 0 ? ts : since.get(card.id ?? "") ?? Number.POSITIVE_INFINITY;
}

export interface LivenessOptions {
  /** The chat this pane shows, null before it is attached. */
  sessionId: () => string | null;
  /** The chat lives on a paired machine: its daemon is not this one, so its prompts cannot be read here. */
  mirrored: () => boolean;
  /** Settles one dead card (writes its Skip mark and clears its parked slot). */
  settle: (card: RenderedMessage) => Promise<void>;
  /** Something changed: draw again. */
  changed: () => void;
  /** The card on screen in the answer popover: always live, never read as dead. */
  onScreenId: () => string | null;
}

/** Watches one chat's open question cards against the daemon's held prompts. */
export class QuestionLiveness {
  /** Cards already settled here: left out of what the dashboard derives at once, before a reload re-reads their mark. */
  readonly settled = new Set<string>();
  private readonly since = new Map<string, number>();
  private checkedSig = "";
  /** The cards of the latest check, judged or not. */
  private latest: readonly RenderedMessage[] = [];
  private busy = false;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly o: LivenessOptions) {}

  /** The rows with every card this view settled marked skipped. Same array when none was. */
  apply(messages: readonly RenderedMessage[], skippedText: string): readonly RenderedMessage[] {
    if (this.settled.size === 0) return messages;
    let hit = false;
    const out = messages.map((m) => {
      if (m.kind !== "question" || m.text !== undefined || !m.id || !this.settled.has(m.id)) return m;
      hit = true;
      return { ...m, text: skippedText };
    });
    return hit ? out : messages;
  }

  /** Looks at the open cards of the latest derive. Reads the daemon only when the
   *  set of cards old enough to judge changed since the last read. */
  check(openCards: readonly RenderedMessage[], now: number): void {
    if (this.disposed) return;
    const sid = this.o.sessionId();
    const live = new Set(openCards.map((m) => m.id ?? ""));
    for (const id of [...this.since.keys()]) if (!live.has(id)) this.since.delete(id);
    const onScreen = this.o.onScreenId();
    const cards = openCards.filter((m) => !!m.id && m.id !== onScreen && !this.settled.has(m.id));
    for (const m of cards) if (!this.since.has(m.id!)) this.since.set(m.id!, now);
    this.latest = cards;
    if (!sid || this.o.mirrored() || cards.length === 0) {
      this.checkedSig = "";
      return;
    }
    const old = cards.filter((m) => now - cardStart(m, this.since) >= LIVENESS_GRACE_MS);
    const young = cards.filter((m) => !old.includes(m));
    if (young.length > 0 && this.recheck === null) {
      const wait = Math.min(...young.map((m) => LIVENESS_GRACE_MS - (now - cardStart(m, this.since))));
      this.recheck = setTimeout(() => {
        this.recheck = null;
        this.o.changed();
      }, Math.max(wait, 1_000));
    }
    const sig = old.map((m) => m.id).join(",");
    if (old.length === 0 || sig === this.checkedSig || this.busy) return;
    this.busy = true;
    void this.read(sid, old, sig);
  }

  private async read(sid: string, cards: readonly RenderedMessage[], sig: string): Promise<void> {
    try {
      let held: QuestionRequestedPayload[];
      try {
        held = findPendingPromptsForSession(await getTransport().call("list_pending_prompts"), sid)
          .filter((p) => p.kind === "question")
          .map((p) => p.payload as QuestionRequestedPayload);
      } catch (e) {
        // Without the daemon's list nothing is known dead: the cards stay, and the next draw reads again.
        console.warn("[question-liveness] list_pending_prompts failed:", e);
        return;
      }
      if (this.disposed || this.o.sessionId() !== sid) return;
      this.checkedSig = sig;
      const dead = deadQuestionCards(cards, held, Date.now(), this.since);
      if (dead.length === 0) return;
      for (const card of dead) this.settled.add(card.id!);
      this.o.changed();
      for (const card of dead) {
        try {
          await this.o.settle(card);
        } catch (e) {
          console.warn("[question-liveness] settling a dead card failed:", e);
        }
      }
      this.o.changed();
    } finally {
      this.busy = false;
      // A card that grew old while the daemon was being read was left out of this read (and its
      // own redraw bounced off `busy`): draw again so the next check reads for it.
      if (!this.disposed && this.o.sessionId() === sid && this.agedSince(sig)) this.o.changed();
    }
  }

  /** Whether the cards old enough to judge now are not the ones the read `sig` covered. */
  private agedSince(sig: string): boolean {
    const now = Date.now();
    const old = this.latest.filter((m) => !this.settled.has(m.id!) && now - cardStart(m, this.since) >= LIVENESS_GRACE_MS);
    return old.length > 0 && old.map((m) => m.id).join(",") !== sig;
  }

  dispose(): void {
    this.disposed = true;
    if (this.recheck !== null) clearTimeout(this.recheck);
    this.recheck = null;
  }
}
