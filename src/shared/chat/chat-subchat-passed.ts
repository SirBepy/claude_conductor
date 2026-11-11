// The "Passed to X" row: a quiet one-liner in a main chat's timeline where the
// main agent called `subchat` with action "send". Joe's follow-up goes to the
// sub word for word (the daemon copies it), so this row is how he sees WHICH
// sub got it and can correct a wrong match. It is drawn from the tool_use in
// the main chat's own transcript, the way send_message cards are, so it comes
// back in order after a reload and on older pages.
//
// `list`, `status` and `log` calls draw nothing here: they stay ordinary quiet
// tool rows. The sub's reply arrives as its own card (subchat-cards.ts).

import { escapeHtml } from "../escape-html";
import type { ContentBlock } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-classifiers";

export const SUBCHAT_TOOL = "mcp__cc_conductor__subchat";

interface SendInput {
  action?: unknown;
  sub?: unknown;
  all?: unknown;
  question?: unknown;
}

const asInput = (input: unknown): SendInput => (input && typeof input === "object" ? (input as SendInput) : {});

/** A `subchat` call that passes a message on. */
export function isSubchatSend(toolName: string, input: unknown, parentToolUseId?: string | null): boolean {
  return toolName === SUBCHAT_TOOL && !parentToolUseId && asInput(input).action === "send";
}

/** The row painted from the tool_use alone, before the daemon answers. */
export function passedRowFromToolUse(id: string, input: unknown, ts: number): RenderedMessage {
  const i = asInput(input);
  const all = i.all === true;
  const sub = typeof i.sub === "string" ? i.sub.trim() : "";
  const question = typeof i.question === "string" ? i.question.replace(/\s+/g, " ").trim() : "";
  return { kind: "passed", id, ts, parentToolUseId: null, passedAll: all, passedTo: all ? "" : sub, ...(question ? { passedQuestion: question } : {}) };
}

function outputText(output: ContentBlock | undefined): string {
  return output && output.type === "text" ? output.text : "";
}

/** Folds the tool_result in: the daemon names who really got it (an exact
 *  match of whatever the agent typed), and a refusal turns the row into a
 *  "could not pass" line instead of a claim that did not happen. */
export function applyPassedResult(row: RenderedMessage, output: ContentBlock | undefined, isError: boolean): RenderedMessage {
  if (isError) return { ...row, failed: true };
  let parsed: { ok?: unknown; passed_to?: unknown; held_for?: unknown; sub_ids?: unknown } | null = null;
  try {
    parsed = JSON.parse(outputText(output));
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.ok === false) return { ...row, failed: true };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((n): n is string => typeof n === "string" && n.length > 0);
  const names = [...strings(parsed.passed_to), ...strings(parsed.held_for)];
  const reached = { passedSubIds: strings(parsed.sub_ids) };
  if (row.passedAll) return { ...row, ...reached, passedTo: names.join(", ") };
  return names.length > 0 ? { ...row, ...reached, passedTo: names.join(", ") } : { ...row, ...reached };
}

/** One quiet line. No card chrome, no buttons: a row Joe glances at. */
export function renderPassedRow(m: RenderedMessage): string {
  const failed = m.failed === true;
  const verb = failed ? "Could not pass to" : "Passed to";
  const target = m.passedAll
    ? "all running subs"
    : m.passedTo
      ? `<b>${escapeHtml(m.passedTo)}</b>`
      : "a sub";
  return `<div class="msg passed-row${failed ? " passed-row--failed" : ""}"><i class="ph ph-arrow-bend-down-right" aria-hidden="true"></i>${verb} ${target}</div>`;
}
