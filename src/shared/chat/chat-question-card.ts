// The AUQ question-card concern, lifted out of chat-event-handler.ts (todo 697).
// A question card is the one message kind that is created by one event, resolved
// by a later unrelated one, and then re-anchored to the end of the transcript, so
// its logic was smeared across four dispatch sites. Behavior is unchanged.

import type { ChatEvent } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";
import { AUQ_SKIPPED_TEXT, RenderedMessage, extractAuqAnswerText } from "./chat-transforms";
import type { SkipMark } from "./skip-marks";
import { isAskQuestionTool } from "./tool-meta";
import { isQuestionResolutionText } from "./tool-views";
import { enqueueTurnClose } from "./chat-dom-renderer";
import type { ChatRenderer } from "./chat-renderer";

/** Index of the last unresolved question card - only one AUQ is ever open. */
export function findOpenQuestionIndex(messages: readonly RenderedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "question" && m.text === undefined) return i;
  }
  return -1;
}

/** Index of the most recent question card, resolved or not - the extra-message
 *  note can arrive after the card already answered (only one AUQ in flight). */
export function findLastQuestionIndex(messages: readonly RenderedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === "question") return i;
  }
  return -1;
}

/** Batch-replay twin of findOpenQuestionIndex, keyed on id (no
 *  RenderedMessage array exists yet at fold time in chat-pagination.ts). */
export function findNearestOpenQuestionId(cards: { id: string }[], resolved: Set<string>): string | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const id = cards[i]!.id;
    if (resolved.has(id)) break;
    return id;
  }
  return null;
}

/** Batch-replay twin of findLastQuestionIndex - the extra-message fold has no
 *  "still open" gating (unlike findNearestOpenQuestionId above), since a note
 *  can attach to an already-answered card. */
export function findLastQuestionId(cards: { id: string }[]): string | null {
  return cards.length > 0 ? cards[cards.length - 1]!.id : null;
}

/** An already-rendered plain bubble whose sentinel-tagged ask hadn't loaded
 *  yet when ITS OWN page folded. `rendered` (cb.getMessages()) is chronologically ascending, so the earliest match is nearest. */
export function findStrandedSentinelAnswer(rendered: readonly RenderedMessage[]): string | null {
  for (const m of rendered) {
    if (m.kind !== "user" || !m.content) continue;
    const answer = extractAuqAnswerText(m.content);
    if (answer !== null) return answer;
  }
  return null;
}

/** Fold a fire-and-forget AUQ answer message back into the question card it
 *  answers (see permission-modal/index.ts onSubmit), so the transcript shows
 *  the card resolved with the real answers instead of stuck on "awaiting
 *  answer" plus a separate bubble. `cardId` names the card exactly; without it
 *  - pre-id history - the newest unresolved one wins. False if none matched. */
export function resolvePendingQuestionCard(r: ChatRenderer, answerText: string, cardId?: string | null): boolean {
  const byId = cardId
    ? r.messages.findIndex((m) => m.kind === "question" && m.id === cardId && m.text === undefined)
    : -1;
  const i = byId >= 0 ? byId : findOpenQuestionIndex(r.messages);
  if (i < 0) return false;
  r.messages[i] = { ...r.messages[i]!, text: answerText };
  r.dirtyIndices.add(i);
  moveMessageToEnd(r, i);
  return true;
}

/** Folds a fire-and-forget AUQ extra-message note into its card so it renders
 *  inside it, not a separate bubble. Matches ANY card, resolved or not. */
export function resolvePendingQuestionExtra(r: ChatRenderer, extraText: string): boolean {
  const i = findLastQuestionIndex(r.messages);
  if (i < 0) return false;
  r.messages[i] = { ...r.messages[i]!, extraText };
  r.dirtyIndices.add(i);
  return true;
}

/** Re-anchor the row at `from` as the LAST row - a card answered long after the
 *  ask belongs there. Its element is dropped; flushRender's append pass rebuilds it. */
export function moveMessageToEnd(r: ChatRenderer, from: number): void {
  if (from < 0 || from >= r.messages.length - 1) return;
  const [msg] = r.messages.splice(from, 1);
  r.messages.push(msg!);
  if (from < r.messageEls.length) r.messageEls.splice(from, 1)[0]?.remove();
  // Both arrays lost the same slot, so every tracked index past it shifts down.
  r.remapIndices((i) => (i > from ? i - 1 : i), new Set([from]));
}

/** tool_use pre-pass: true once the event was consumed as a question card, so
 *  the dispatcher skips its generic chip paths. */
export function tryHandleQuestionToolUse(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_use" }>,
  ts: number,
): boolean {
  // AUQ becomes a visual turn-splitter (question card) instead of a chip.
  // Only top-level AUQ calls get the card treatment; nested subagent calls
  // fall through to the normal chip path. Recognises both the builtin and
  // the app's real MCP ask channel (see isAskQuestionTool).
  if (!isAskQuestionTool(ev.tool_name) || ev.parent_tool_use_id) return false;
  r.auqPendingResult = true;
  // Save the streaming slot's current text before enqueueTurnClose zeros
  // it. The suppression branch uses this to tell apart the protocol
  // re-emit (same text → suppress) from real post-AUQ content delivered
  // by the file watcher while auqPendingResult is still true.
  if (r.streamingIndex !== null) {
    const existing = r.messages[r.streamingIndex] as RenderedMessage;
    r.auqPreContent = blocksToText(existing.content ?? []);
  } else {
    r.auqPreContent = null;
  }
  enqueueTurnClose(r, { allowMetaMerge: false });
  r.messages.push({
    kind: "question",
    tool: ev.tool_name,
    input: ev.input,
    id: ev.id,
    ts,
    parentToolUseId: null,
  });
  // Open a fresh sub-turn for post-question chips.
  r.activeTurnChipKey = ++r._chipKeySeq;
  r.activeTurnStart = r.messages.length;
  r.activeTurnStreamedText = "";
  r.activeTurnStartedAtMs = ts > 0 ? ts : Date.now();
  r.activeTurnUsage = null;
  r.activeTurnFirstTs = ts > 0 ? ts : 0;
  r.activeTurnLastTs = r.activeTurnFirstTs;
  r.turnTodosBaseline = null;
  r.activityToolCanon = null;
  r.setActivity("Waiting for your answer…");
  return true;
}

/** tool_result pre-pass: true once the result was absorbed by a question card. */
export function tryHandleQuestionResult(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "tool_result" }>,
): boolean {
  // An AUQ result never renders a row. Only one that CARRIES the resolution may
  // set `.text`: the fire-and-forget channel answers with a receipt (deny
  // handshake, `{"acknowledged":true}`), which strands the card and blocks the fold.
  const qIdx = r.messages.findIndex(
    (m) => m.kind === "question" && m.id === ev.tool_use_id,
  );
  if (qIdx < 0) return false;
  const ansText = !ev.is_error && ev.output?.type === "text" ? ev.output.text : "";
  if (isQuestionResolutionText(ansText)) {
    r.messages[qIdx] = { ...r.messages[qIdx]!, text: ansText };
    r.dirtyIndices.add(qIdx);
    moveMessageToEnd(r, qIdx);
  }
  r.onToolTally?.(r.tallyState.build());
  return true;
}

/** notification pre-pass: true once a question_skipped notice was consumed. */
export function tryHandleQuestionSkipped(
  r: ChatRenderer,
  ev: Extract<ChatEvent, { type: "notification" }>,
): boolean {
  if (ev.kind !== "question_skipped") return false;
  // Fire-and-forget Skip: no real tool_use_id to key off, so resolve the
  // same heuristic way a real answer does - the last still-open card.
  resolvePendingQuestionCard(r, AUQ_SKIPPED_TEXT);
  return true;
}

/** Pair each durable skip mark with the card it dismissed. A v4+ mark names its
 *  `questionId`; pre-v4 rows use the nearest preceding open card instead. */
export function matchSkipMarks(
  cards: { id: string; ts: number }[],
  marks: SkipMark[],
  resolved: Set<string>,
): Set<string> {
  const skipped = new Set<string>();
  const known = new Set(cards.map((c) => c.id));
  for (const mark of marks) {
    if (mark.questionId) {
      if (known.has(mark.questionId) && !resolved.has(mark.questionId)) skipped.add(mark.questionId);
      continue;
    }
    if (!Number.isFinite(mark.timestamp)) continue;
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i]!;
      if (card.ts <= 0 || card.ts > mark.timestamp) continue;
      // The nearest preceding card being answered means this mark belongs to a
      // card on another page, not to an older one here.
      if (!resolved.has(card.id) && !skipped.has(card.id)) skipped.add(card.id);
      break;
    }
  }
  return skipped;
}

/** Bulk-load fold (todo 661): after full history replay, resolve any question
 *  card still open as Skipped if a durable mark matches it - the counterpart
 *  to prependEvents' older-page fold, which the initial hydrate never runs
 *  through. No move-to-end: the card's element isn't built yet. */
export function applySkipMarks(r: ChatRenderer, marks: SkipMark[]): void {
  if (marks.length === 0) return;
  const cards: { id: string; ts: number }[] = [];
  const resolved = new Set<string>();
  for (const m of r.messages) {
    if (m.kind !== "question" || !m.id) continue;
    cards.push({ id: m.id, ts: m.ts });
    if (m.text !== undefined) resolved.add(m.id);
  }
  const skipped = matchSkipMarks(cards, marks, resolved);
  if (skipped.size === 0) return;
  for (let i = 0; i < r.messages.length; i++) {
    const m = r.messages[i]!;
    if (m.kind === "question" && m.id && skipped.has(m.id)) {
      r.messages[i] = { ...m, text: AUQ_SKIPPED_TEXT };
      r.dirtyIndices.add(i);
    }
  }
}
