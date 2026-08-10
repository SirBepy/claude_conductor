// Non-rendering concerns split out of question-ui.ts (ai_todo 262): payload
// normalization, the module-level "active card" draft registry, and the pure
// answer-completeness check. question-ui.ts re-exports these so existing
// importers (permission-card.ts, permission-modal/index.ts, gating.ts,
// active-session.ts) keep working unchanged.

import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import type { Answers, OptionBadge, Question, QuestionDomain, QuestionDraft, Selection } from "./types";

// Whitelists, because `extractQuestions` normalizes an untrusted payload and
// both values are interpolated straight into a CSS var / class name downstream.
const DOMAINS = new Set(["ux", "arch", "sec", "data", "tooling", "infra", "billing"]);
const BADGES = new Set(["recommended", "long_term", "short_term"]);

/**
 * Pure "is this question answered" check, shared between the floating card's
 * own gating (via a per-index wrapper in question-ui.ts) and external callers
 * - e.g. the chat-transcript live-progress sync - that only have a raw
 * QuestionDraft, not question-ui.ts's closures.
 */
export function isQuestionAnswered(q: Question | undefined, freeText: string, selection: Selection | undefined): boolean {
  if (!q?.options?.length) return true;
  if (freeText.trim()) return true;
  if (q.multiSelect) return (selection instanceof Set ? selection.size : 0) > 0;
  return typeof selection === "string";
}

/**
 * Pure "what did the user answer" computation, shared between the floating
 * card's answerFor/answerPreview (question-ui.ts) so the combine rule has one
 * implementation. multiSelect always returns an array (checked boxes + typed
 * text appended); single-select returns the typed text ALONE only if nothing
 * was picked, the picked label ALONE only if nothing was typed, or both
 * combined as a 2-item array when the user did both - a bare radio pick no
 * longer gets silently discarded just because they also wrote something.
 */
export function computeAnswer(
  q: Question | undefined,
  freeText: string,
  selection: Selection | undefined,
): string | string[] | null {
  const typed = freeText.trim();
  if (q?.multiSelect) {
    const set = Array.from((selection instanceof Set ? selection : new Set<string>()));
    if (typed) set.push(typed);
    return set;
  }
  if (typeof selection === "string" && typed) return [selection, typed];
  if (typed) return typed;
  if (typeof selection === "string") return selection;
  return null;
}

/** Splits a body into context + the final "?"-terminated ask (cut at the
 *  nearest paragraph/sentence break before it), so the card can dim the
 *  former and highlight the latter. No "?", or a negligible context, falls
 *  back to {context: "", ask: whole string} - keeps terse questions as-is. */
export function splitAsk(question: string): { context: string; ask: string } {
  const trimmed = question.trim();
  const lastQ = trimmed.lastIndexOf("?");
  if (lastQ === -1) return { context: "", ask: trimmed };
  const beforeAsk = trimmed.slice(0, lastQ);
  const paraBreak = beforeAsk.lastIndexOf("\n\n");
  const sentenceBreak = beforeAsk.lastIndexOf(". ");
  const cut = Math.max(paraBreak, sentenceBreak);
  const askStart = cut === -1 ? 0 : cut + 2;
  const context = trimmed.slice(0, askStart).trim();
  const ask = trimmed.slice(askStart, lastQ + 1).trim();
  if (!context || ask.length > trimmed.length * 0.85) return { context: "", ask: trimmed };
  return { context, ask };
}

/** Renders a question's body: markdown throughout, plus (when splitAsk finds
 *  a clear final ask) a dimmed context block above a highlighted ask line. */
export function questionTextHtml(question: string): string {
  const { context, ask } = splitAsk(question);
  if (!context) return `<div class="prompt-q__text">${renderMarkdown(question)}</div>`;
  return `
    <div class="prompt-q__context">${renderMarkdown(context)}</div>
    <div class="prompt-q__ask"><i class="ph ph-arrow-bend-down-right"></i>${renderMarkdown(ask)}</div>
  `;
}

/**
 * Format answers as plain text so claude can read them in the permission
 * tool's `deny.message` field. Headless `claude -p` has no native way to
 * receive structured answers from the built-in `AskUserQuestion` tool, but
 * a denied-permission message is surfaced to claude as user feedback.
 */
export function formatAnswersAsMessage(questions: Question[], answers: Answers): string {
  const lines: string[] = ["User answered the question(s):"];
  for (const q of questions) {
    const a = answers[q.question];
    if (a == null) continue;
    const formatted = Array.isArray(a) ? a.join(", ") : a;
    lines.push(`Q: ${q.question}`);
    lines.push(`A: ${formatted}`);
  }
  return lines.join("\n");
}

/**
 * If `input` looks like an AskUserQuestion payload (`{questions: [...]}` with
 * at least one well-formed question), return the normalized array. Otherwise
 * null. Used to route permission requests for question-shaped tools through
 * the question UI instead of a JSON dump + Allow/Deny.
 */
export function extractQuestions(input: unknown): Question[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Question[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string") return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      domain: DOMAINS.has(q.domain as string) ? (q.domain as QuestionDomain) : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as unknown[]).flatMap((o) => {
            if (!o || typeof o !== "object") return [];
            const oo = o as Record<string, unknown>;
            if (typeof oo.label !== "string") return [];
            return [{
              label: oo.label,
              description: typeof oo.description === "string" ? oo.description : undefined,
              badges: Array.isArray(oo.badges)
                ? (oo.badges as unknown[]).filter((b): b is OptionBadge => BADGES.has(b as string))
                : undefined,
            }];
          })
        : undefined,
    });
  }
  return out;
}

// ── Module-level draft registry ─────────────────────────────────────────────
// The currently-shown question card, so a daemon "prompt-resolved" / expiry
// event can dismiss it from outside (e.g. it timed out, or was answered on
// another device). Only one card shows at a time. Owned here; question-ui.ts
// registers/clears it via setActiveCard/clearActiveCardIfCurrent rather than
// touching module state directly.
export interface ActiveQuestionCard {
  id: string;
  sessionId?: string;
  teardown: () => void;
  getDraft: () => QuestionDraft;
}

let activeCard: ActiveQuestionCard | null = null;

/** Register (or clear, with `null`) the live question card. Called by
 * question-ui.ts's renderQuestionUI once the card's teardown/getDraft
 * closures exist. */
export function setActiveCard(card: ActiveQuestionCard | null): void {
  activeCard = card;
}

/** Clear the registry only if it's still pointing at `teardown` - guards
 * against a stale card's own teardown() (e.g. fired after a newer card
 * already replaced it) wiping out that newer card. */
export function clearActiveCardIfCurrent(teardown: () => void): void {
  if (activeCard?.teardown === teardown) activeCard = null;
}

/**
 * Dismiss the live question card if it matches `id` (or unconditionally when no
 * id is given). No-op if nothing matches - safe to call for an already-closed
 * or different card. Does NOT fire onCancel (the prompt already resolved).
 */
export function dismissQuestionCard(id?: string): void {
  if (!activeCard) return;
  if (id && activeCard.id !== id) return;
  activeCard.teardown();
}

/**
 * Return a snapshot of the active card's current answer state if it belongs to
 * the given session, without tearing it down. Returns null if no card is up or
 * the card belongs to a different session.
 */
export function snapshotActiveCardDraft(sessionId: string): QuestionDraft | null {
  if (!activeCard || activeCard.sessionId !== sessionId) return null;
  return activeCard.getDraft();
}
