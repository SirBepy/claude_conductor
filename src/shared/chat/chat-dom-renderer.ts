// DOM rendering + turn-fold/close machinery for ChatRenderer (ai_todo 123).
// Split out of chat-renderer.ts so the orchestrator stays a thin state owner.
// These are free functions taking the renderer `r` rather than methods, because
// the dispatch (chat-event-handler.ts) and these renderers share the same ~25
// pieces of instance state and TS has no partial classes. `r`'s members are the
// internal contract; behavior is byte-identical to the pre-split methods.

import { wrapBlockquotes, RenderedMessage, renderMessage, isBoundaryMessage } from "./chat-transforms";
import { highlightCodeBlocks, highlightInlineCode } from "./code-highlighter";
import { hydrateAttachments } from "./attachment-hydrator";
import { toolSummary } from "./tool-meta";
import { applyTurnCollapse, groupToolRange } from "./tool-strip";
import { clampUserMessages } from "./turn-collapse";
import { renderQuestionCardHtml } from "./tool-views";
import { renderPreviewCardHtml, mountPreviewFrame } from "./chat-preview-card";
import { type TurnUsageTotals } from "./turn-chips";
import type { ChatRenderer } from "./chat-renderer";

// Re-exported for callers still importing scroll helpers from here (ai_todo 598
// moved their implementation to chat-scroll.ts).
export { isElNearBottom, isNearBottom, scrollToBottom, beginRevealHold, revealTranscript, scrollToBottomWhenSettled } from "./chat-scroll";

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

/** The active turn's history-timestamp span (duration fallback), or 0. */
export function activeTurnTsSpan(r: ChatRenderer): number {
  if (r.activeTurnFirstTs <= 0 || r.activeTurnLastTs <= r.activeTurnFirstTs) return 0;
  const span = r.activeTurnLastTs - r.activeTurnFirstTs;
  // Distrust spans over 24h: mixed/garbage timestamps, hide the chip instead.
  return span <= 24 * 3600 * 1000 ? span : 0;
}

/**
 * Ensure the active turn's footer exists and is the LAST child of the
 * container, so it always sits below everything the turn has rendered.
 * Once the turn closes the footer stays pinned where it is (the next user
 * message renders after it). Live turns also get the ticking meta row;
 * bulk loads skip it (their rows settle from real totals at close).
 */
export function ensureActiveTurnFooter(r: ChatRenderer): void {
  if (r.activeTurnChipKey === null) return;
  const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
  if (footer !== r.container.lastElementChild) {
    r.container.appendChild(footer);
  }
  if (r.liveBuffer === null) {
    r.turnFooters.ensureLiveMetaRow(r.activeTurnChipKey, r.activeTurnStartedAtMs || Date.now());
    r.turnFooters.syncLiveTick(r.activeTurnChipKey);
    if (r.activeTurnStreamedText) {
      r.turnFooters.updateLiveTokenEstimate(r.activeTurnChipKey, r.activeTurnStreamedText);
    }
  }
}

/** True for a real user/compaction boundary OR an is_meta meta-turn row -
 *  both mint their own footer+chip key in handleChatEvent's normal path,
 *  so both end a "no turn open yet" leading segment. */
function opensOwnFooter(m: RenderedMessage): boolean {
  return isBoundaryMessage(m) || (m.kind === "system" && m.metaKind != null);
}

/**
 * Fold the loaded window's LEADING partial turn at initial load.
 *
 * `read_page` cuts the window by assistant-reply count, so it almost always
 * begins MID-turn: the rows before the first real boundary (the turn's
 * opening user message lives below the window) were rendered flat, because no
 * turn was open to group them when they streamed through bulkLoadEvents. That
 * left raw Read/Grep/... cards on screen until the user scrolled up far enough
 * for pagination to prepend the older batch and heal them.
 *
 * Run that same heal once here, at load: fold those leading rows into a chip
 * strip immediately. We have no usage for the turn (its turn_usage events
 * arrived before any turn was open and were dropped), so the meta row stays
 * absent until pagination brings the opening message - strictly better than
 * the flat cards shown before. No-op when the window already starts at a
 * boundary (no leading partial turn) or is empty. Stops at a meta-turn row
 * too (opensOwnFooter), not just a real boundary: unlike a genuine mid-turn
 * page cut, an is_meta row ALWAYS already has its own footer from the normal
 * per-event pass - re-folding it here would mint a duplicate one.
 */
export function foldLeadingPartialTurn(r: ChatRenderer): void {
  if (r.messages.length === 0) return;
  if (opensOwnFooter(r.messages[0]!)) return;
  let end = r.messages.length;
  for (let i = 0; i < r.messages.length; i++) {
    if (opensOwnFooter(r.messages[i]!)) { end = i; break; }
  }
  foldClosedRange(r, 0, end, null, 0);
}

/**
 * Fold a CLOSED turn range that arrived via pagination prepend (or heal the
 * window's leading partial turn once its opening user message arrives).
 * Reuses the turn's existing footer when some of its rows were folded
 * earlier (chunk straddling); otherwise creates one before the range's
 * closing boundary element and settles its meta row from the usage the
 * paginator accumulated out of the raw events.
 */
export function foldClosedRange(
  r: ChatRenderer,
  start: number,
  end: number,
  usage: TurnUsageTotals | null,
  tsSpanMs: number,
): void {
  if (end <= start) return;
  // An existing footer for this turn: rows folded earlier live inside its
  // strip buckets.
  let footer: HTMLElement | null = null;
  for (let i = start; i < end; i++) {
    const f = r.messageEls[i]?.closest<HTMLElement>(".turn-footer");
    if (f) { footer = f; break; }
  }
  const totals = usage
    ? { ...usage, durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs }
    : null;
  // A meta-classified row (peer/fleet/retry/wake) in range surfaces as the
  // inline chip, not the old centered marker (now CSS-hidden) - count
  // occurrences for a "×N" suffix, since pagination doesn't dedup consecutive
  // meta rows into one streak the way the live path's merge does.
  const metaRows = r.messages.slice(start, end).filter((m) => m.kind === "system" && m.metaKind);
  const metaRow = metaRows[0];
  let key: number | null = null;
  if (!footer) {
    // Skip the footer entirely for a turn with nothing to show (no usage,
    // no foldable tool rows, no meta chip) - an empty box helps nobody.
    const hasToolRows = r.messages
      .slice(start, end)
      .some((m) => m.kind === "tool_use" || m.kind === "tool_result"
        || (m.kind === "user" && !!m.authorSessionId));
    if (!totals && !hasToolRows && !metaRow) {
      applyTurnCollapse(r.messages, r.messageEls, start, end, null);
      return;
    }
    key = ++r._chipKeySeq;
    footer = r.turnFooters.getOrCreateFooter(key);
    const anchor = r.messageEls[end] ?? null;
    if (anchor && anchor.parentElement === r.container) {
      r.container.insertBefore(footer, anchor);
    } else {
      const last = r.messageEls[end - 1];
      if (last && last.parentElement === r.container) last.after(footer);
      else r.container.appendChild(footer);
    }
    if (totals) r.turnFooters.settleMetaRow(key, totals);
  } else {
    const existingKey = Number(footer.dataset.turnId);
    key = Number.isFinite(existingKey) ? existingKey : null;
    if (totals && key !== null && !footer.querySelector(".turn-meta-chips")) {
      r.turnFooters.settleMetaRow(key, totals);
    }
  }
  if (metaRow?.metaKind && key !== null) {
    r.turnFooters.ensureMetaChip(key, {
      kind: metaRow.metaKind,
      label: metaRow.text ?? "",
      detail: metaRow.metaDetail ?? "",
      streakCount: metaRows.length,
    });
  }
  applyTurnCollapse(r.messages, r.messageEls, start, end, footer);
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

export function enqueueTurnClose(r: ChatRenderer): void {
  finalizeStreamingBubble(r);
  // The next turn folds into fresh groups; closed-turn rows already carry
  // data-tool-grouped, so processTurnCloseQueue won't re-fold them.
  clearRunningHighlight(r);
  r.activeToolGroups.clear();
  // Drop any id left outstanding by an interrupted/never-resulted tool call,
  // else it permanently blocks the next turn's activity label from clearing.
  r.outstandingActivityToolIds.clear();
  if (r.activeTurnChipKey !== null) {
    const turnStart = r.activeTurnStart ?? r.messages.length;
    // Trim trailing noise-tail messages (e.g. "Request interrupted by user")
    // from the turn range so the chips footer lands BEFORE them, keeping the
    // visual order: chips → divider label → next user message.
    let end = r.messages.length;
    while (end > turnStart && r.messages[end - 1]?.noiseLabel) end--;
    r.closeTurnQueue.push({
      start: turnStart,
      end,
      chipKey: r.activeTurnChipKey,
      usage: r.activeTurnUsage,
      tsSpanMs: activeTurnTsSpan(r),
    });
  }
  r.resetActiveTurnMeta();
  r.activeTurnStart = null;
}

/**
 * Drop the "currently working" pulse from a turn's chips and forget its
 * in-flight calls. Called when the turn closes (the next user message) so a
 * tool that never reported a result can't leave its chip pulsing forever.
 */
export function clearRunningHighlight(r: ChatRenderer): void {
  if (r.activeTurnChipKey !== null) {
    const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
    footer.querySelectorAll<HTMLElement>(".tool-chip--running")
      .forEach((c) => c.classList.remove("tool-chip--running"));
  }
  r.activityToolCanon = null;
}

/**
 * Pulse the SINGLE main-strip chip for the AI's current activity (the tool the
 * `lastActivity` line describes, e.g. "Editing api.ts" -> the File-Changes
 * chip). Only that chip pulses - NOT every tool with an in-flight call, which
 * lit up the whole strip during parallel calls / subagent turns. Live only:
 * bulk replay nets every result and the transcript is hidden until it settles,
 * so a pulse there would be both invisible and misleading.
 */
export function applyRunningHighlight(r: ChatRenderer): void {
  if (r.liveBuffer !== null || r.activeTurnChipKey === null) return;
  const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
  // The main strip is a direct child of the footer (subagent strips live
  // deeper inside buckets - we only pulse top-level chips). Walk children
  // directly rather than rely on :scope, which jsdom handles inconsistently.
  const strip = [...footer.children].find(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tool-strip"),
  );
  if (!strip) return;
  const topChips = [...strip.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tool-chip"),
  );
  for (const node of topChips) {
    const tool = node.dataset.tool;
    const running = !!tool && tool === r.activityToolCanon;
    node.classList.toggle("tool-chip--running", running);
  }
}

export function processTurnCloseQueue(r: ChatRenderer): void {
  if (r.closeTurnQueue.length === 0) return;
  for (const { start, end, chipKey, usage, tsSpanMs } of r.closeTurnQueue) {
    let footer: HTMLElement | null = null;
    if (chipKey !== null) {
      footer = r.turnFooters.getOrCreateFooter(chipKey);
      // Pin the footer at the turn's bottom: right before the next turn's
      // first element (always a direct container child), else at the end.
      const anchor = r.messageEls[end] ?? null;
      if (anchor && anchor.parentElement === r.container) {
        r.container.insertBefore(footer, anchor);
      } else if (footer.parentElement !== r.container) {
        r.container.appendChild(footer);
      }
      if (usage) {
        // History turns have no duration_ms; fall back to the ts span.
        r.turnFooters.settleMetaRow(chipKey, {
          ...usage,
          durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs,
        });
      } else {
        // No usage ever arrived (interrupted live turn): freeze the live
        // row at its last elapsed/estimate. No-op when no row exists.
        r.turnFooters.cancelMetaRow(chipKey);
      }
    }
    applyTurnCollapse(r.messages, r.messageEls, start, end, footer);
  }
  r.closeTurnQueue = [];
}

export function buildMessageEl(m: RenderedMessage): HTMLElement {
  if (m.kind === "question") {
    const el = document.createElement("div");
    el.className = "msg question-card";
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
