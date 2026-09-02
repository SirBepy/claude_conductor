// Shared custom views for tool chips, used by BOTH the in-chat per-turn chip
// panels (tool-strip.ts) and the statusline tally popover (session-tally.ts)
// so the two never drift. Each renderer takes the chat's message list and a
// range ([0, len] for the whole session, a turn's bounds for one turn) and
// returns an HTML string:
//   Read / Edit  -> one row per file with a repeat-count badge (click opens it)
//   Skill        -> the list of skills used
//   AskUserQuestion -> each question paired with the answer the user gave
//
// CSS for the produced markup lives in chat.css (loaded app-wide by the sessions
// + history views), so the body-appended statusline popover styles it too.

import type { RenderedMessage } from "./chat-transforms";
import { renderMarkdown, truncateForSummary } from "./chat-transforms";
import { canonicalTool, isAskQuestionTool } from "./tool-meta";
import { escapeHtml } from "../escape-html";
import { basename } from "../path-utils";
import { asObj, strField } from "../obj-utils";

// Canonical tool keys whose chip renders a custom aggregated view instead of the
// generic stack of raw tool rows / target list.
export const CUSTOM_VIEW_TOOLS = new Set(["Read", "Edit", "Skill", "AskUserQuestion"]);

/** Messages a chip's view covers: top-level calls in [start, end) UNION the ids
 *  the strip folded into this chip. It folds an orphan subagent child into the
 *  MAIN strip and bumps the chip, so range-only rendered "Read x3" over
 *  nothing. */
function scopedIndices(
  messages: RenderedMessage[],
  start: number,
  end: number,
  ids?: ReadonlySet<string>,
  isEligible: (m: RenderedMessage) => boolean = (m) => !m.parentToolUseId,
  matchesId: (m: RenderedMessage, ids: ReadonlySet<string>) => boolean = (m, ids) =>
    !!m.id && ids.has(m.id),
): number[] {
  const picked = new Set<number>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || !isEligible(m)) continue;
    picked.add(i);
  }
  if (ids && ids.size > 0) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && matchesId(m, ids)) picked.add(i);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** Edit/Write/MultiEdit/NotebookEdit + Read all target a single path. */
function filePathOf(input: unknown): string {
  const o = asObj(input);
  return strField(o, "file_path") || strField(o, "notebook_path");
}

/** Parent-directory tail of a path (everything before the basename), or "". */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/**
 * Aggregate Read or File-Changes calls in range into one row per file, first-seen
 * order, with a repeat-count badge. Rows open the file in the editor on click
 * (delegated handler in chat-renderer / session-tally). `kind` selects the badge
 * wording: "N×" reads vs "N changes".
 */
export function renderFilesView(
  messages: RenderedMessage[],
  start: number,
  end: number,
  kind: "Read" | "Edit",
  ids?: ReadonlySet<string>,
): string {
  const byPath = new Map<string, number>();
  for (const i of scopedIndices(messages, start, end, ids)) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use") continue;
    if (canonicalTool(m.tool ?? "") !== kind) continue;
    const path = filePathOf(m.input);
    if (!path) continue;
    byPath.set(path, (byPath.get(path) ?? 0) + 1);
  }
  if (byPath.size === 0) return "";
  return [...byPath].map(([path, n]) => {
    const pathEsc = escapeHtml(path);
    const nameEsc = escapeHtml(basename(path));
    const dirEsc = escapeHtml(dirOf(path));
    const badge = kind === "Read"
      ? (n > 1 ? `<span class="tool-file-count">${n}×</span>` : "")
      : `<span class="tool-file-count">${n} ${n === 1 ? "change" : "changes"}</span>`;
    return `<button type="button" class="tool-file-row" data-path="${pathEsc}" title="${pathEsc}"><i class="ph ph-file"></i><span class="tool-file-name">${nameEsc}</span><span class="tool-file-path">${dirEsc}</span>${badge}</button>`;
  }).join("");
}

/** One clean row per skill used in range, with a repeat-count badge. */
export function renderSkillsView(
  messages: RenderedMessage[],
  start: number,
  end: number,
  ids?: ReadonlySet<string>,
): string {
  const bySkill = new Map<string, number>();
  for (const i of scopedIndices(messages, start, end, ids)) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.tool !== "Skill") continue;
    const name = strField(asObj(m.input), "skill") || "(skill)";
    bySkill.set(name, (bySkill.get(name) ?? 0) + 1);
  }
  if (bySkill.size === 0) return "";
  return [...bySkill].map(([name, n]) => {
    const badge = n > 1 ? `<span class="tool-file-count">x${n}</span>` : "";
    return `<div class="tool-skill-row"><i class="ph ph-sparkle"></i><span class="tool-skill-name">${escapeHtml(name)}</span>${badge}</div>`;
  }).join("");
}

/** Pull plain text out of a tool_result output block (else ""). */
function resultText(m: RenderedMessage): string {
  const out = m.output;
  if (out && out.type === "text" && typeof out.text === "string") return out.text;
  return "";
}

/**
 * Parse the answer message the app feeds back to claude (built by
 * permission-modal/question-ui::formatAnswersAsMessage) into a question->answer
 * map. Shape: "User answered the question(s):\nQ: <q>\nA: <a>\n...".
 */
function parseAnswers(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let pendingQ: string[] | null = null;
  let pendingA: string[] | null = null;
  const flush = () => {
    if (pendingQ !== null && pendingA !== null) {
      map.set(pendingQ.join("\n").trim(), pendingA.join("\n").trim());
    }
    pendingQ = null;
    pendingA = null;
  };
  for (const line of lines) {
    if (line.startsWith("Q: ")) {
      flush();
      pendingQ = [line.slice(3)];
    } else if (line.startsWith("A: ") && pendingQ !== null) {
      pendingA = [line.slice(3)];
    } else if (pendingA !== null) {
      pendingA.push(line);
    } else if (pendingQ !== null) {
      // formatAnswersAsMessage writes `Q: <question>` verbatim, so a multi-line
      // question keeps going until `A: ` - the key must be rebuilt whole or it
      // never matches the card's own question text and the answer stays hidden.
      pendingQ.push(line);
    }
  }
  flush();
  return map;
}

export interface QuestionResolution {
  verdict: "answered" | "skipped" | "timed-out";
  /** Parsed Q->A pairs, empty for skipped/timed-out. */
  answers: Map<string, string>;
}

/** The one place that decides what a question tool_result's text means, so the
 *  "does this resolve?" gate and the "how did it resolve?" branch can't drift.
 *  null = unresolved: the MCP ask channel is fire-and-forget, so its
 *  `{"acknowledged":true}` receipt must not strand the card on "awaiting answer". */
export function resolveQuestionText(text: string): QuestionResolution | null {
  if (text.includes("timed out")) return { verdict: "timed-out", answers: new Map() };
  if (text.includes("dismissed")) return { verdict: "skipped", answers: new Map() };
  const answers = parseAnswers(text);
  return answers.size > 0 ? { verdict: "answered", answers } : null;
}

/** Whether a question tool_result really resolves the card. */
export function isQuestionResolutionText(text: string): boolean {
  return resolveQuestionText(text) !== null;
}

interface AskQuestion { question: string; header?: string }

function extractAskQuestions(input: unknown): AskQuestion[] {
  const raw = asObj(input).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const it of raw) {
    const q = asObj(it);
    const question = strField(q, "question");
    if (!question) continue;
    out.push({ question, header: strField(q, "header") || undefined });
  }
  return out;
}

/** Pairs each question with its answer. Top-level asks are kind:"question"
 *  (answer in `m.text`); nested ones stay kind:"tool_use" with a tool_result. */
export function renderQuestionsView(
  messages: RenderedMessage[],
  start: number,
  end: number,
  ids?: ReadonlySet<string>,
): string {
  // Range keeps every message (question CARDS carry no tool_use id to match
  // on), plus folded ids matched on either m.id or a tool_result's tool_use_id
  // (the answer arrives as a later, separate message).
  const order = scopedIndices(messages, start, end, ids, () => true, (m, idSet) =>
    (!!m.id && idSet.has(m.id))
    || (m.kind === "tool_result" && !!m.tool_use_id && idSet.has(m.tool_use_id)));
  // tool_use id -> parsed answers, harvested from each call's tool_result.
  const answersById = new Map<string, Map<string, string>>();
  for (const i of order) {
    const m = messages[i];
    if (m?.kind === "tool_result" && m.tool_use_id) {
      const resolved = resolveQuestionText(resultText(m));
      if (resolved) answersById.set(m.tool_use_id, resolved.answers);
    }
  }
  const cards: string[] = [];
  for (const i of order) {
    const m = messages[i];
    if (!m) continue;
    const isTopLevel = m.kind === "question";
    const folded = !!m.id && !!ids?.has(m.id);
    const isNestedToolUse = m.kind === "tool_use"
      && (!m.parentToolUseId || folded)
      && isAskQuestionTool(m.tool ?? "");
    if (!isTopLevel && !isNestedToolUse) continue;
    const questions = extractAskQuestions(m.input);
    const answers = isTopLevel
      ? resolveQuestionText(m.text ?? "")?.answers ?? null
      : (m.id && answersById.get(m.id)) || null;
    for (const q of questions) {
      const header = q.header ? `<div class="tool-qa-header">${escapeHtml(q.header)}</div>` : "";
      const ans = answers?.get(q.question);
      const answerHtml = ans
        ? `<div class="tool-qa-a"><i class="ph ph-arrow-bend-down-right"></i><span>${escapeHtml(ans)}</span></div>`
        : `<div class="tool-qa-a tool-qa-a--pending"><i class="ph ph-clock"></i><span>awaiting answer</span></div>`;
      cards.push(`<div class="tool-qa">${header}<div class="tool-qa-q">${renderMarkdown(q.question)}</div>${answerHtml}</div>`);
    }
  }
  return cards.join("");
}

/** Answer chips (answered) or a status pill (skipped/timed-out) inside the
 *  collapsed `<summary>` - visible at a glance, no click needed. */
function summaryResolutionHtml(
  resolution: "pending" | "answered" | "skipped" | "timed-out",
  answers: Map<string, string> | null,
  questions: AskQuestion[],
  extraText?: string,
): string {
  const parts: string[] = [];
  if (resolution === "answered" && answers) {
    for (const q of questions) {
      const ans = answers.get(q.question);
      if (ans) parts.push(`<span class="question-card-answer-chip">${escapeHtml(truncateForSummary(ans, 40))}</span>`);
    }
  } else if (resolution === "skipped") {
    parts.push(`<span class="question-card-status-pill question-card-status-pill--skipped">Skipped</span>`);
  } else if (resolution === "timed-out") {
    parts.push(`<span class="question-card-status-pill question-card-status-pill--timed-out">Timed out</span>`);
  }
  // A resolved card can carry a note independent of resolution kind. Full
  // text passed through - CSS truncates via the nested span's ellipsis.
  if (extraText) {
    parts.push(`<span class="question-card-extra-chip"><i class="ph ph-pencil-simple"></i><span class="question-card-extra-chip-text">${escapeHtml(extraText)}</span></span>`);
  }
  return parts.join("");
}

/**
 * Render a standalone AUQ question card for a kind:"question" message.
 * The message carries the raw AUQ input in `m.input` and the answer text
 * in `m.text` once the tool_result has been absorbed. Called directly from
 * buildMessageEl in chat-renderer, bypassing renderMessage entirely.
 */
export function renderQuestionCardHtml(m: RenderedMessage): string {
  const questions = extractAskQuestions(m.input);
  if (questions.length === 0) {
    return `<div class="tool-qa"><div class="tool-qa-a tool-qa-a--pending"><i class="ph ph-clock"></i><span>awaiting answer</span></div></div>`;
  }
  const resolved = m.text !== undefined ? resolveQuestionText(m.text) : null;
  const resolution: "pending" | "answered" | "skipped" | "timed-out" = resolved?.verdict ?? "pending";
  const answers = resolved?.verdict === "answered" ? resolved.answers : null;
  const cards = questions.map((q, qi) => {
    const header = q.header
      ? `<div class="tool-qa-header">${escapeHtml(q.header)}</div>`
      : "";
    let answerHtml: string;
    if (resolution === "answered" && answers) {
      const ans = answers.get(q.question);
      answerHtml = ans
        ? `<div class="tool-qa-a"><i class="ph ph-arrow-bend-down-right"></i><span>${escapeHtml(ans)}</span></div>`
        : `<div class="tool-qa-a tool-qa-a--pending"><i class="ph ph-clock"></i><span>awaiting answer</span></div>`;
    } else if (resolution === "skipped") {
      answerHtml = `<div class="tool-qa-a tool-qa-a--skipped"><i class="ph ph-x-circle"></i><span>Skipped</span></div>`;
    } else if (resolution === "timed-out") {
      answerHtml = `<div class="tool-qa-a tool-qa-a--timed-out"><i class="ph ph-timer"></i><span>Timed out</span></div>`;
    } else if (m.liveAnswered?.[qi]) {
      // Still pending overall, but the floating card reports THIS question as
      // answered - mirror that progress without leaking the typed/selected
      // text itself (still --pending so the click-to-reopen affordance below
      // keeps working while the card is up).
      answerHtml = `<div class="tool-qa-a tool-qa-a--pending tool-qa-a--live-answered"><i class="ph ph-check-circle"></i><span>Answered</span></div>`;
    } else {
      answerHtml = `<div class="tool-qa-a tool-qa-a--pending"><i class="ph ph-clock"></i><span>awaiting answer</span></div>`;
    }
    return `<div class="tool-qa">${header}<div class="tool-qa-q">${renderMarkdown(q.question)}</div>${answerHtml}</div>`;
  }).join("");
  const firstLabel = questions[0]?.header || questions[0]?.question || "";
  const truncated = truncateForSummary(firstLabel, 55);
  const badge = questions.length > 1 ? `<span class="question-card-badge">${questions.length}</span>` : "";
  // Only a still-actionable question stays expanded.
  const isOpen = resolution === "pending" ? " open" : "";
  const resolutionInner = summaryResolutionHtml(resolution, answers, questions, m.extraText);
  // Omitted entirely (not just empty) so a pending card's summary keeps its
  // single-line layout instead of an empty wrapper row underneath it.
  const resolutionHtml = resolutionInner ? `<span class="question-card-summary-resolution">${resolutionInner}</span>` : "";
  // No degraded-builtin badge here: the daemon stamps it on the prompt payload,
  // not the tool_use input this renders from. The live card carries it instead.
  const summary = `<summary class="question-card-summary"><i class="ph ph-chat-circle-dots"></i><span class="question-card-label">${escapeHtml(truncated)}</span>${badge}<i class="ph ph-caret-down question-card-chevron"></i>${resolutionHtml}</summary>`;
  // Shown only when expanded (inside <details>) - escapeHtml not
  // renderMarkdown, since this is user-typed prose, not Claude's markdown.
  const extraHtml = m.extraText
    ? `<div class="question-card-extra"><div class="question-card-extra-label"><i class="ph ph-pencil-simple"></i>also wrote</div><div class="question-card-extra-text">${escapeHtml(m.extraText)}</div></div>`
    : "";
  return `<details class="question-card-collapsible" data-resolution="${resolution}"${isOpen}>${summary}${cards}${extraHtml}</details>`;
}

/**
 * Render a custom tool's view for `tool` (a canonical key) over [start, end)
 * plus `ids` (calls the chip folded from outside that range), or null when the
 * tool has no custom view. "" means "custom view, but nothing to show".
 */
export function renderCustomToolView(
  tool: string,
  messages: RenderedMessage[],
  start: number,
  end: number,
  ids?: ReadonlySet<string>,
): string | null {
  switch (tool) {
    case "Read": return renderFilesView(messages, start, end, "Read", ids);
    case "Edit": return renderFilesView(messages, start, end, "Edit", ids);
    case "Skill": return renderSkillsView(messages, start, end, ids);
    case "AskUserQuestion": return renderQuestionsView(messages, start, end, ids);
    default: return null;
  }
}
