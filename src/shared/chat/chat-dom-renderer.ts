// DOM-node construction for ChatRenderer (ai_todo 123; turn-fold/close-queue
// machinery split out to chat-turn-fold.ts, ai_todo 837).
// These are free functions taking the renderer `r` rather than methods, because
// the dispatch (chat-event-handler.ts) and these renderers share the same ~25
// pieces of instance state and TS has no partial classes. `r`'s members are the
// internal contract; behavior is byte-identical to the pre-split methods.

import { wrapBlockquotes, RenderedMessage, renderMessage } from "./chat-transforms";
import { highlightCodeBlocks, highlightInlineCode } from "./code-highlighter";
import { hydrateAttachments } from "./attachment-hydrator";
import { toolSummary } from "./tool-meta";
import { groupToolRange } from "./tool-strip";
import { clampUserMessages } from "./turn-collapse";
import { renderQuestionCardHtml } from "./tool-views";
import { renderPreviewCardHtml, mountPreviewFrame } from "./chat-preview-card";
import type { ChatRenderer } from "./chat-renderer";
import { ensureActiveTurnFooter, applyRunningHighlight, processTurnCloseQueue } from "./chat-turn-fold";

// Re-exported for callers still importing scroll helpers from here (ai_todo 598
// moved their implementation to chat-scroll.ts).
export { isElNearBottom, isNearBottom, scrollToBottom, beginRevealHold, revealTranscript, scrollToBottomWhenSettled } from "./chat-scroll";
// Re-exported for callers still importing turn-fold helpers from here (ai_todo
// 837 moved their implementation to chat-turn-fold.ts).
export {
  activeTurnTsSpan,
  ensureActiveTurnFooter,
  foldLeadingPartialTurn,
  foldClosedRange,
  enqueueTurnClose,
  clearRunningHighlight,
} from "./chat-turn-fold";

export function describeActivity(toolName: string, input: unknown): string {
  const { target } = toolSummary(toolName, input);
  let s: string;
  switch (toolName) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s = `Editing ${target}`;
      break;
    case "Write":
      s = `Writing ${target}`;
      break;
    case "Read":
      s = `Reading ${target}`;
      break;
    case "Bash":
    case "PowerShell":
      s = `Running: ${target}`;
      break;
    case "Grep":
      s = `Grepping ${target}`;
      break;
    case "Glob":
      s = `Searching ${target}`;
      break;
    default:
      s = `${toolName}…`;
  }
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

export function flushRender(r: ChatRenderer): void {
  // Elements actually added or replaced THIS call - the highlight/wrap
  // passes below only ever need to look inside these, not the whole
  // container (ai_todo streaming-render O(n^2) fix, Fix 3). `appendedAny`
  // additionally gates clampUserMessages, which only ever has new work when
  // a message was appended (a dirty-replaced element is always the
  // streaming/question slot, never `kind: "user"`).
  const touchedEls: HTMLElement[] = [];
  let appendedAny = false;
  if (r.dirtyIndices.size > 0) {
    for (const idx of r.dirtyIndices) {
      if (idx < r.messageEls.length) {
        const newEl = buildMessageEl(r.messages[idx]!);
        const oldEl = r.messageEls[idx]!;
        oldEl.replaceWith(newEl);
        r.messageEls[idx] = newEl;
        touchedEls.push(newEl);
      }
    }
    r.dirtyIndices.clear();
  }
  if (r.messageEls.length < r.messages.length) {
    appendedAny = true;
    const frag = document.createDocumentFragment();
    while (r.messageEls.length < r.messages.length) {
      const idx = r.messageEls.length;
      const el = buildMessageEl(r.messages[idx]!);
      frag.appendChild(el);
      r.messageEls.push(el);
      touchedEls.push(el);
    }
    r.container.appendChild(frag);
  }
  processTurnCloseQueue(r);
  ensureActiveTurnFooter(r);
  if (r.activeTurnStart !== null) {
    const footer = r.activeTurnChipKey !== null ? r.turnFooters.getOrCreateFooter(r.activeTurnChipKey) : null;
    groupToolRange(r.messages, r.messageEls, r.activeTurnStart, r.messages.length, r.activeToolGroups, footer);
  }
  applyRunningHighlight(r);
  // Nothing rendered this flush (a redundant trailing-throttle tick, or a
  // turn_usage settle with no pending dirty/appended state): the passes
  // below only ever act on new/changed elements, so there is nothing for
  // them to do - skip the whole-container querySelectorAll cost entirely.
  if (touchedEls.length === 0) return;
  for (const el of touchedEls) {
    void highlightCodeBlocks(el);
    wrapBlockquotes(el);
    highlightInlineCode(el);
  }
  if (appendedAny) clampUserMessages(r.messages, r.messageEls);
}

/** Finalize any in-progress streaming bubble in place (else a later boundary
 *  overwrites the wrong slot). Split out of enqueueTurnClose so the
 *  silent-streak merge in chat-event-handler.ts can call just this half. */
export function finalizeStreamingBubble(r: ChatRenderer): void {
  if (r.streamingIndex === null) return;
  const existing = r.messages[r.streamingIndex] as RenderedMessage;
  r.messages[r.streamingIndex] = { ...existing, streaming: false };
  r.dirtyIndices.add(r.streamingIndex);
  r.streamingIndex = null;
}

export function buildMessageEl(m: RenderedMessage): HTMLElement {
  if (m.kind === "question") {
    const el = document.createElement("div");
    el.className = "msg question-card";
    // Click-to-reopen needs to name the card it came from - two open cards
    // are indistinguishable otherwise (see sessions.ts's reopen handler).
    if (m.id) el.dataset.questionId = m.id;
    el.innerHTML = renderQuestionCardHtml(m);
    return el;
  }
  if (m.kind === "preview") {
    const el = document.createElement("div");
    el.className = "msg preview-card open";
    el.innerHTML = renderPreviewCardHtml(m);
    void mountPreviewFrame(el, m);
    return el;
  }
  const wrap = document.createElement("div");
  wrap.innerHTML = renderMessage(m);
  const el = wrap.firstElementChild as HTMLElement;
  // Raw narration (assistant prose, tool calls/results): hidden by default,
  // shown only when the container carries show-raw-chat (see message-filter-pref.ts).
  if (m.kind === "assistant" || m.kind === "tool_use" || m.kind === "tool_result") {
    el.classList.add("chat-narration");
  }
  // Hover-timestamp label. History lines carry a real epoch (parsed from the
  // transcript's RFC3339 string backend-side); live `-p` stream events carry
  // ts=0, so approximate those with the render moment (≈ arrival). Display-only:
  // we deliberately don't write back to m.ts, which stays 0 for live so the
  // turn-span/duration logic keeps using duration_ms instead of a wall span.
  const ms = m.ts ? (m.ts < 1e10 ? m.ts * 1000 : m.ts) : Date.now();
  el.dataset.ts = new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (el.querySelector(".attachment-chip[data-attachment-path]")) {
    void hydrateAttachments(el);
  }
  return el;
}
