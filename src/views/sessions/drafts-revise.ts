// The draft editor's "Revise" menu: one-click instructions sent to the chat
// that wrote the draft, so iterating on a message needs no typing. Scoped to
// the highlighted span when there is one, otherwise the whole draft.

import { escapeHtml } from "../../shared/escape-html";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { isCurrentSessionBusy } from "./session-thinking-bar";
import { sendWithFailureRecovery } from "./send-with-failure-recovery";
import { state } from "./state";

export const REVISE_PRESETS = [
  { key: "shorter", icon: "ph-arrows-in-line-horizontal", label: "Shorter", ask: "Make it shorter. Keep every fact that matters." },
  { key: "explain", icon: "ph-lightbulb", label: "Explain better", ask: "Explain it better: clearer for a reader who does not share our context." },
  { key: "casual", icon: "ph-smiley", label: "More casual", ask: "Make it more casual and friendly." },
  { key: "direct", icon: "ph-arrow-right", label: "More direct", ask: "Make it more direct: lead with the point and cut the softening." },
  {
    key: "accuracy",
    icon: "ph-magnifying-glass",
    label: "Check accuracy",
    ask:
      "Check every factual claim in it with subagents against what can actually be verified (code, git history, " +
      "command output, what I said). Fix anything wrong, and drop certainty language from anything you could not " +
      "verify. Tell me what you changed and why.",
  },
] as const;

export interface RevisionTarget {
  topic: string;
  handle: string;
  version: number;
  body: string;
  /** The highlighted span, or "" for the whole draft. */
  selection: string;
}

/** The body rides along in full: the per-turn injection carries only an
 *  excerpt, and the chat's own copy may be compacted away or belong to a
 *  different chat than the one this lands in. */
export function buildRevisionPrompt(t: RevisionTarget, instruction: string): string {
  const lines = [`[re: draft ${t.handle} v${t.version} - ${t.topic}]`, instruction.trim()];
  if (t.selection.trim()) {
    lines.push("", "Only change this part, leave the rest as it is:", quote(t.selection));
  }
  lines.push(
    "",
    `Current text of ${t.handle}:`,
    quote(t.body),
    "",
    `Write the result back with write_draft (action revise, id "${t.handle}") so it lands as a new version.`,
  );
  return lines.join("\n");
}

function quote(text: string): string {
  return text.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

/** Lands on the authoring chat when it is still open, else on the chat the
 *  panel is scoped to - the body is in the prompt, so either can act on it. */
export async function sendRevision(originId: string, fallbackId: string, text: string): Promise<boolean> {
  const inst =
    state.sessions.find((s) => s.session_id === originId) ??
    state.sessions.find((s) => s.session_id === fallbackId);
  if (!inst) {
    showToast("No open chat to send this to.");
    return false;
  }
  const sessionId = inst.session_id;
  const blocks: ContentBlock[] = [{ type: "text", text }];
  const onScreen = state.renderer?.currentSessionId() === sessionId;
  if (onScreen && isCurrentSessionBusy()) {
    state.heldMessages?.stage(blocks);
    return true;
  }
  if (onScreen && state.heldMessages?.hasItemsForActive()) {
    state.heldMessages.flushHeldWithDraft(blocks).catch((err) => {
      console.error("[drafts-revise] flushHeldWithDraft rejected unexpectedly", err);
    });
    return true;
  }
  const optimistic = { type: "user_message", content: blocks, timestamp: BigInt(Date.now()) } as ChatEvent;
  sessionEvents.pushSynthetic(sessionId, optimistic);
  await sendWithFailureRecovery(sessionId, String(inst.cwd ?? "."), blocks, optimistic);
  return true;
}

export function reviseMenuHtml(scoped: boolean): string {
  const items = REVISE_PRESETS.map(
    (p) =>
      `<button type="button" class="dr-rv-item" data-revise-preset="${p.key}">` +
        `<i class="ph ${p.icon}"></i>${escapeHtml(p.label)}</button>`,
  ).join("");
  return (
    `<div class="dr-rv-menu" role="menu">` +
      `<div class="dr-rv-scope">${scoped ? "Highlighted part only" : "Whole draft"}</div>` +
      items +
      `<input type="text" class="dr-rv-input" data-revise-free placeholder="Or tell Claude..." />` +
    `</div>`
  );
}

export function presetAsk(key: string): string | undefined {
  return REVISE_PRESETS.find((p) => p.key === key)?.ask;
}
