import type { ChatEvent } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-transforms";
import { eventToRenderedMessage, isBoundaryMessage, cleanUserBlocks, extractAuqAnswerText, stripAuqAnswerBlock } from "./chat-transforms";
import { sessionEvents } from "./event-store";
import { highlightCodeBlocks, highlightInlineCode } from "./code-highlighter";
import { isAskQuestionTool } from "./tool-meta";
import type { TurnUsageTotals } from "./turn-chips";

export interface PaginatorCallbacks {
  getSessionId(): string | null;
  getMessages(): RenderedMessage[];
  getMessageEls(): HTMLElement[];
  setMessages(m: RenderedMessage[]): void;
  setMessageEls(els: HTMLElement[]): void;
  buildMessageEl(m: RenderedMessage): HTMLElement;
  clampUserMessages(): void;
  /** Called after a prepend with the number of rows inserted at the front. */
  onShift(n: number): void;
  /**
   * Fold a closed turn range [start, end) into its footer (tool chip strip +
   * meta row settled from `usage`). Implemented by ChatRenderer; the paginator
   * computes the ranges and per-turn usage out of the raw prepended events.
   */
  foldClosedRange(start: number, end: number, usage: TurnUsageTotals | null, tsSpanMs: number): void;
}

function emptyTotals(): TurnUsageTotals {
  return { durationMs: 0, outputTokens: 0, inputTokens: 0, cacheCreate: 0, cacheRead: 0, costUsd: 0, awaiting: null };
}

/** Combine two partial usage accumulations of the SAME turn (batch straddle).
 *  `b` is chronologically later (see prependEvents' carry comments), so its
 *  status marker wins the last-non-null fold when present. */
function mergeTotals(a: TurnUsageTotals | null, b: TurnUsageTotals | null): TurnUsageTotals | null {
  if (!a) return b;
  if (!b) return a;
  return {
    durationMs: Math.max(a.durationMs, b.durationMs),
    outputTokens: a.outputTokens + b.outputTokens,
    inputTokens: b.inputTokens || a.inputTokens,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd,
    awaiting: b.awaiting ?? a.awaiting ?? null,
  };
}

/** Resolve the 1-based `n` a revise/retract call addresses: n=1 is the newest
 *  `kind:"message"` row, -1 when out of the last-two-boundaries window.
 *  Shared by the live path (full history) and this module's prependEvents
 *  (single batch only - cross-batch ordering is out of scope, todo 590). */
export function resolveOrdinalIn(messages: RenderedMessage[], n: number): number {
  if (!Number.isInteger(n) || n < 1) return -1;
  let boundaries = 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isBoundaryMessage(m)) {
      if (++boundaries >= 2) return -1;
      continue;
    }
    if (m.kind === "message" && !m.retracted && ++seen === n) return i;
  }
  return -1;
}

/** Walk up to the direct child of container. Used to find insertion point for prepend. */
function rootChildOf(container: HTMLElement, el: HTMLElement): HTMLElement {
  let n = el;
  while (n.parentElement && n.parentElement !== container) {
    n = n.parentElement as HTMLElement;
  }
  return n;
}

export class ChatPaginator {
  cwdHint: string | undefined;
  private topSentinel: HTMLElement | null = null;
  private topObserver: IntersectionObserver | null = null;
  // Usage + timestamp span carried between prepend batches for the turn that
  // straddles them: its closing boundary (and trailing usage) arrive in one
  // batch, its opening user message only in a LATER (older) one.
  private carryUsage: TurnUsageTotals | null = null;
  private carryFirstTs = 0;
  private carryLastTs = 0;

  constructor(private container: HTMLElement, private cb: PaginatorCallbacks) {}

  install(): void {
    this.remove();
    const sid = this.cb.getSessionId();
    if (!sid || !sessionEvents.hasMore(sid)) return;
    const sentinel = document.createElement("div");
    sentinel.className = "chat-top-sentinel";
    sentinel.innerHTML = '<div class="chat-top-spinner" hidden></div>';
    this.container.prepend(sentinel);
    this.topSentinel = sentinel;
    this.topObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void this.fetchOlder();
      }
    });
    this.topObserver.observe(sentinel);
  }

  remove(): void {
    if (this.topObserver) {
      try { this.topObserver.disconnect(); } catch { /* ignore */ }
      this.topObserver = null;
    }
    if (this.topSentinel && this.topSentinel.parentNode) {
      this.topSentinel.parentNode.removeChild(this.topSentinel);
    }
    this.topSentinel = null;
  }

  /**
   * Forget the cross-batch turn carry. Called on session attach / reload -
   * NOT from remove(), which install() invokes between batches of the same
   * session (that would lose the straddling turn's usage).
   */
  resetTurnCarry(): void {
    this.carryUsage = null;
    this.carryFirstTs = 0;
    this.carryLastTs = 0;
  }

  async fetchOlder(): Promise<void> {
    const sid = this.cb.getSessionId();
    if (!sid) return;
    if (!sessionEvents.hasMore(sid)) {
      this.remove();
      return;
    }
    const spinner = this.topSentinel?.querySelector(".chat-top-spinner") as HTMLElement | null;
    if (spinner) spinner.hidden = false;
    const scroller = this.findScroller();
    const oldScrollTop = scroller ? scroller.scrollTop : 0;
    const oldScrollHeight = scroller ? scroller.scrollHeight : 0;

    const older = await sessionEvents.loadOlder(sid, this.cwdHint);
    if (this.cb.getSessionId() !== sid) return;

    if (!older || older.length === 0) {
      if (spinner) spinner.hidden = true;
      if (!sessionEvents.hasMore(sid)) this.remove();
      return;
    }

    this.prependEvents(older);
    if (this.cb.getSessionId() !== sid) return;

    if (scroller) {
      const newScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    }

    if (sessionEvents.hasMore(sid)) {
      this.install();
    } else {
      this.remove();
    }
  }

  prependEvents(events: ChatEvent[]): void {
    if (events.length === 0) return;

    // A rejected send_message (validation failure) renders as a "Failed to
    // send" ghost, same as the live path - not dropped. Its paired tool_result
    // is absorbed silently either way (see chat-event-handler.ts's tool_result
    // is_error branch).
    const rejectedSendIds = new Set<string>();
    for (const ev of events) {
      if (ev.type !== "tool_result" || !ev.is_error) continue;
      const src = events.find((e) => e.type === "tool_use" && e.id === ev.tool_use_id);
      if (src?.type === "tool_use" && src.tool_name === "mcp__cc_conductor__send_message" && !src.parent_tool_use_id) {
        rejectedSendIds.add(src.id);
      }
    }
    // update_message (revise/retract) never renders its own row - it mutates
    // an earlier kind:"message" entry instead (applied in the loop below).
    // Its tool_result is absorbed silently, same as rejectedSendIds' pairs.
    const updateMsgIds = new Set<string>();
    for (const ev of events) {
      if (ev.type === "tool_use" && ev.tool_name === "mcp__cc_conductor__update_message" && !ev.parent_tool_use_id) {
        updateMsgIds.add(ev.id);
      }
    }
    // A question's tool_result never renders its own row - it resolves the
    // card instead, mirroring chat-event-handler.ts's live absorb. is_error
    // (the fire-and-forget deny handshake) absorbs silently, no answer text.
    const questionAnswerById = new Map<string, string>();
    const questionToolIds = new Set<string>();
    for (const ev of events) {
      if (ev.type === "tool_use" && isAskQuestionTool(ev.tool_name) && !ev.parent_tool_use_id) {
        questionToolIds.add(ev.id);
      }
    }
    for (const ev of events) {
      if (ev.type !== "tool_result" || !questionToolIds.has(ev.tool_use_id)) continue;
      if (!ev.is_error) questionAnswerById.set(ev.tool_use_id, ev.output?.type === "text" ? ev.output.text : "");
    }
    // The real ask channel is fire-and-forget: tool_result above is always the
    // deny handshake, the real answer arrives later as a user_message tagged
    // AUQ_ANSWER_SENTINEL. Pair each with its nearest preceding open question,
    // mirroring chat-event-handler.ts's resolvePendingQuestionCard fold.
    const sentinelAnswerById = new Map<string, string>();
    const foldedUserMsgs = new Set<ChatEvent>();
    {
      let openId: string | null = null;
      for (const ev of events) {
        if (ev.type === "tool_use" && isAskQuestionTool(ev.tool_name) && !ev.parent_tool_use_id) {
          openId = ev.id;
        } else if (ev.type === "tool_result" && ev.tool_use_id === openId && !ev.is_error) {
          openId = null; // delivered in-band - questionAnswerById already covers it
        } else if (ev.type === "user_message" && openId) {
          const answer = extractAuqAnswerText(cleanUserBlocks(ev.content));
          if (answer !== null) {
            sentinelAnswerById.set(openId, answer);
            foldedUserMsgs.add(ev);
            openId = null;
          }
        }
      }
    }
    const filtered = events.filter((ev) =>
      !(ev.type === "tool_result" && (rejectedSendIds.has(ev.tool_use_id) || updateMsgIds.has(ev.tool_use_id) || questionToolIds.has(ev.tool_use_id))));

    const messages = this.cb.getMessages();
    const messageEls = this.cb.getMessageEls();
    const newMessages: RenderedMessage[] = [];
    const newEls: HTMLElement[] = [];
    const frag = document.createDocumentFragment();

    // Per-turn bookkeeping: a boundary row (user message / compaction) CLOSES
    // the turn formed by the rows before it, so the usage and timestamps
    // accumulated up to that point belong to that turn.
    const boundaries: Array<{
      index: number;
      usage: TurnUsageTotals | null;
      firstTs: number;
      lastTs: number;
    }> = [];
    let acc: TurnUsageTotals | null = null;
    let accFirstTs = 0;
    let accLastTs = 0;

    for (const ev of filtered) {
      if (ev.type === "turn_usage") {
        // Usage events render nothing; they sum into the open turn (history
        // replays one per assistant line).
        acc = acc ?? emptyTotals();
        acc.outputTokens += Number(ev.output_tokens) || 0;
        acc.inputTokens = Number(ev.input_tokens) || acc.inputTokens;
        acc.cacheCreate += Number(ev.cache_creation_input_tokens) || 0;
        acc.cacheRead += Number(ev.cache_read_input_tokens) || 0;
        acc.costUsd += Number(ev.total_cost_usd) || 0;
        acc.durationMs = Math.max(acc.durationMs, Number(ev.duration_ms) || 0);
        // Same last-non-null fold as chat-event-handler.ts's live/bulk path.
        if (ev.awaiting) acc.awaiting = ev.awaiting;
        continue;
      }
      if (ev.type === "tool_use" && updateMsgIds.has(ev.id)) {
        const input = (ev.input ?? {}) as { message?: unknown; text?: unknown; retract?: unknown };
        const idx = resolveOrdinalIn(newMessages, typeof input.message === "number" ? input.message : NaN);
        if (idx >= 0) {
          const prev = newMessages[idx]!;
          const updated = input.retract === true
            ? { ...prev, retracted: true, dimmed: false }
            : { ...prev, text: typeof input.text === "string" ? input.text : prev.text, dimmed: false };
          newMessages[idx] = updated;
          const newEl = this.cb.buildMessageEl(updated);
          frag.replaceChild(newEl, newEls[idx]!);
          newEls[idx] = newEl;
        }
        continue;
      }
      if (ev.type === "user_message" && foldedUserMsgs.has(ev)) {
        // Folded into the question card's text (set via sentinelAnswerById
        // below) - only held prose riding the same bundle (held-messages.ts's
        // bundleHeld) still renders, mirroring handleUserMessageEvent's
        // resolvedQuestionCard branch.
        const remainder = stripAuqAnswerBlock(cleanUserBlocks(ev.content));
        if (remainder.length === 0) continue;
        const rMsg: RenderedMessage = { kind: "user", content: remainder, ts: Number(ev.timestamp) };
        boundaries.push({ index: newMessages.length, usage: acc, firstTs: accFirstTs, lastTs: accLastTs });
        acc = null;
        accFirstTs = rMsg.ts > 0 ? rMsg.ts : 0;
        accLastTs = accFirstTs;
        newMessages.push(rMsg);
        const rEl = this.cb.buildMessageEl(rMsg);
        newEls.push(rEl);
        frag.appendChild(rEl);
        continue;
      }
      const msg = eventToRenderedMessage(ev);
      if (!msg) continue;
      if (ev.type === "tool_use" && msg.kind === "message" && rejectedSendIds.has(ev.id)) {
        msg.failed = true;
      }
      if (ev.type === "tool_use" && msg.kind === "question" && (questionAnswerById.has(ev.id) || sentinelAnswerById.has(ev.id))) {
        msg.text = questionAnswerById.get(ev.id) ?? sentinelAnswerById.get(ev.id);
      }
      if (isBoundaryMessage(msg)) {
        boundaries.push({ index: newMessages.length, usage: acc, firstTs: accFirstTs, lastTs: accLastTs });
        acc = null;
        accFirstTs = msg.ts > 0 ? msg.ts : 0;
        accLastTs = accFirstTs;
      } else if (msg.ts > 0) {
        if (accFirstTs === 0) accFirstTs = msg.ts;
        if (msg.ts > accLastTs) accLastTs = msg.ts;
      }
      newMessages.push(msg);
      const el = this.cb.buildMessageEl(msg);
      newEls.push(el);
      frag.appendChild(el);
    }

    if (newMessages.length === 0) {
      // Pure-usage batch: its totals still belong to the straddling turn.
      this.carryUsage = mergeTotals(acc, this.carryUsage);
      return;
    }

    const firstExisting = messageEls[0] ?? null;
    if (firstExisting) {
      this.container.insertBefore(frag, rootChildOf(this.container, firstExisting));
    } else if (this.topSentinel && this.topSentinel.parentNode === this.container) {
      this.container.appendChild(frag);
    } else {
      this.container.prepend(frag);
    }

    const shift = newMessages.length;
    const merged = [...newMessages, ...messages];
    this.cb.setMessages(merged);
    this.cb.setMessageEls([...newEls, ...messageEls]);
    this.cb.onShift(shift);

    // ── Fold the closed turns this prepend completed ──────────────────────
    // Prepended slice indices ARE merged indices (rows go in at the front).
    if (boundaries.length === 0) {
      // No boundary in the slice: the whole batch extends the still-open
      // straddling turn. Pool its usage/span and wait for an older batch to
      // bring the opening user message.
      this.carryUsage = mergeTotals(acc, this.carryUsage);
      if (accFirstTs > 0 && (this.carryFirstTs === 0 || accFirstTs < this.carryFirstTs)) this.carryFirstTs = accFirstTs;
      if (accLastTs > this.carryLastTs) this.carryLastTs = accLastTs;
    } else {
      for (let i = 0; i < boundaries.length; i++) {
        const start = boundaries[i]!.index + 1;
        if (i + 1 < boundaries.length) {
          // Turn fully inside the slice; its usage was recorded when its
          // closing boundary was hit.
          const closer = boundaries[i + 1]!;
          const span = closer.firstTs > 0 && closer.lastTs > closer.firstTs ? closer.lastTs - closer.firstTs : 0;
          this.cb.foldClosedRange(start, closer.index, closer.usage, span);
        } else {
          // Trailing range: closes at the first boundary of PREVIOUSLY
          // rendered content (which may itself have arrived flat - this heals
          // it). Usage = this slice's trailing accumulation + the carry from
          // newer batches of the same turn.
          let end = merged.length;
          for (let j = shift; j < merged.length; j++) {
            if (isBoundaryMessage(merged[j]!)) { end = j; break; }
          }
          const usage = mergeTotals(acc, this.carryUsage);
          const firstTs = accFirstTs > 0 ? accFirstTs : this.carryFirstTs;
          const lastTs = Math.max(accLastTs, this.carryLastTs);
          const span = firstTs > 0 && lastTs > firstTs ? lastTs - firstTs : 0;
          this.cb.foldClosedRange(start, end, usage, span);
        }
      }
      // The slice's leading partial segment (rows before its first boundary)
      // belongs to a turn an OLDER batch will close: its usage was recorded
      // at this slice's first boundary. Carry it forward.
      const first = boundaries[0]!;
      this.carryUsage = first.usage;
      this.carryFirstTs = first.firstTs;
      this.carryLastTs = first.lastTs;
    }

    void highlightCodeBlocks(this.container);
    highlightInlineCode(this.container);
    this.cb.clampUserMessages();
  }

  findScroller(): HTMLElement | null {
    let n: HTMLElement | null = this.container;
    while (n) {
      const overflowY = getComputedStyle(n).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && n.scrollHeight > n.clientHeight) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }
}
