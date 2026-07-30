// Shared custom views for tool chips, used by BOTH the in-chat per-turn chip
// panels (turn-collapse.ts) and the statusline tally popover (session-tally.ts)
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
import { renderMarkdown } from "./chat-transforms";
import { canonicalTool } from "./tool-meta";
import { escapeHtml } from "../escape-html";
import { basename } from "../path-utils";
import { asObj, strField } from "../obj-utils";

// Canonical tool keys whose chip renders a custom aggregated view instead of the
// generic stack of raw tool rows / target list.
export const CUSTOM_VIEW_TOOLS = new Set(["Read", "Edit", "Skill", "AskUserQuestion"]);

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
): string {
  const byPath = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId) continue;
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
export function renderSkillsView(messages: RenderedMessage[], start: number, end: number): string {
  const bySkill = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId || m.tool !== "Skill") continue;
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
  let pendingQ: string | null = null;
  let pendingA: string[] | null = null;
  const flush = () => {
    if (pendingQ !== null && pendingA !== null) {
      map.set(pendingQ, pendingA.join("\n").trim());
    }
    pendingQ = null;
    pendingA = null;
  };
  for (const line of lines) {
    if (line.startsWith("Q: ")) {
      flush();
      pendingQ = line.slice(3).trim();
    } else if (line.startsWith("A: ") && pendingQ !== null) {
      pendingA = [line.slice(3)];
    } else if (pendingA !== null) {
      pendingA.push(line);
    }
  }
  flush();
  return map;
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

/**
 * For each AskUserQuestion call in range, show every question (with its short
 * header) paired with the answer the user gave. Answers come from the matching
 * tool_result; while one is still pending the answer reads "awaiting answer".
 */
export function renderQuestionsView(messages: RenderedMessage[], start: number, end: number): string {
  // tool_use id -> parsed answers, harvested from each call's tool_result.
  const answersById = new Map<string, Map<string, string>>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (m?.kind === "tool_result" && m.tool_use_id) {
      const t = resultText(m);
      if (t) answersById.set(m.tool_use_id, parseAnswers(t));
    }
  }
  const cards: string[] = [];
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId || m.tool !== "AskUserQuestion") continue;
    const questions = extractAskQuestions(m.input);
    const answers = (m.id && answersById.get(m.id)) || null;
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
  // Detect resolution from the absorbed tool_result text produced by the Rust
  // format_answers fn: "dismissed" = skipped, "timed out" = timeout, else parse Q/A.
  let resolution: "pending" | "answered" | "skipped" | "timed-out" = "pending";
  let answers: Map<string, string> | null = null;
  if (m.text !== undefined) {
    if (m.text.includes("timed out")) {
      resolution = "timed-out";
    } else if (m.text.includes("dismissed")) {
      resolution = "skipped";
    } else {
      answers = parseAnswers(m.text);
      if (answers.size > 0) resolution = "answered";
    }
  }
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
  const truncated = firstLabel.length > 55 ? firstLabel.slice(0, 53) + "…" : firstLabel;
  const badge = questions.length > 1 ? `<span class="question-card-badge">${questions.length}</span>` : "";
  const summary = `<summary class="question-card-summary"><i class="ph ph-chat-circle-dots"></i><span class="question-card-label">${escapeHtml(truncated)}</span>${badge}<i class="ph ph-caret-down question-card-chevron"></i></summary>`;
  return `<details class="question-card-collapsible" open>${summary}${cards}</details>`;
}

/**
 * Render a custom tool's view for `tool` (a canonical key) over [start, end), or
 * null when the tool has no custom view. "" means "custom view, but nothing to
 * show in this range" - callers can render their own empty state.
 */
export function renderCustomToolView(
  tool: string,
  messages: RenderedMessage[],
  start: number,
  end: number,
): string | null {
  switch (tool) {
    case "Read": return renderFilesView(messages, start, end, "Read");
    case "Edit": return renderFilesView(messages, start, end, "Edit");
    case "Skill": return renderSkillsView(messages, start, end);
    case "AskUserQuestion": return renderQuestionsView(messages, start, end);
    default: return null;
  }
}
