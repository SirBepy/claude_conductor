import type { ChatEvent } from "../../types/ipc.generated";
import { invoke } from "../ipc";
import { sessionEvents } from "./event-store";
import { RenderedMessage, renderBlocks } from "./chat-transforms";
import { armLazyDiffEnhance } from "./diff-enhancer";
import { type FileEditView } from "./file-edits";
import { type ToolTally } from "./tool-meta";
import { ToolTallyState } from "./tool-tally-state";
import { handleCopyClick, handleSlashClick, handleAttachmentClick, handlePastedLogClick, handleAuqAnswerClick, handleTableFullscreen, handlePrPreviewClick } from "./chat-click-handlers";
import { openFileViewer } from "./file-viewer";
import { getScreenshotRowShots } from "./screenshot-row";
import { collectChatImages } from "./chat-image-gallery-data";
import { openChatImageGallery } from "./chat-image-gallery";
import { openLightbox } from "./lightbox";
import { clampUserMessages } from "./turn-collapse";
import type { ToolGroup } from "./tool-strip";
import { renderCustomToolView } from "./tool-views";
import { ChatPaginator } from "./chat-pagination";
import { TurnFooterRegistry, type TurnChipKey, type TurnUsageTotals } from "./turn-chips";
import { buildMessageEl, foldClosedRange, revealTranscript } from "./chat-dom-renderer";
import { onTranscriptTail } from "./chat-resync";
import { flushRenderNow } from "./flush-scheduler";
import { handleChatEvent, type HandleEventOpts } from "./chat-event-handler";
import { bulkLoadEvents, type BulkLoadOpts } from "./chat-event-bulk-load";
import { getCta } from "./cta-registry";

export interface SessionMeta {
  model: string | null;
  /** Full context window input for the latest completed turn (input + cache_creation + cache_read). */
  inputTokens: number;
  hasThinking: boolean;
  /** Accumulated cost estimate across all turns (local API-rate estimate, not actual charge). */
  totalCostUsd: number;
  /** True once any TurnUsage event has been received this session. */
  hasUsage: boolean;
}

export interface CumulativeUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  turns: number;
  costUsd: number;
}

/** Best-effort: a fetch failure just means no skip fold this load, not a
 *  broken history load (mirrors sessionEvents.loadInitial's own tolerance). */
async function fetchSkipMarks(sessionId: string): Promise<number[]> {
  try {
    const marks = await invoke<number[]>("get_skipped_question_marks", { sessionId });
    return Array.isArray(marks) ? marks : [];
  } catch {
    return [];
  }
}

/**
 * Owns the per-session render state and wires the live/history event feeds to
 * the DOM. The heavy lifting lives in two sibling modules that operate on this
 * instance's state (ai_todo 123): `chat-event-handler.ts` (the event→state
 * dispatch) and `chat-dom-renderer.ts` (DOM build + turn-fold/close machinery).
 *
 * Those modules read and mutate the fields below directly, so the fields are
 * public-but-internal: they are the contract between this orchestrator and its
 * two render modules, not a surface for outside callers. Outside code uses only
 * the lifecycle methods, getters, and `on*` callbacks.
 */
export class ChatRenderer {
  container: HTMLElement;
  messages: RenderedMessage[] = [];
  messageEls: HTMLElement[] = [];
  dirtyIndices = new Set<number>();
  unsubscribe: (() => void) | null = null;
  /** Paired with `unsubscribe` - the post-reconcile staleness check. */
  private unsubscribeTail: (() => void) | null = null;
  /** Guards against the 15s heartbeat stacking a second rebuild. Owned by
   *  chat-resync.ts, same public-but-internal contract as `liveBuffer`. */
  _resyncing = false;
  /** Missing-sig set a rebuild already failed to recover; retrying it would
   *  repaint on every heartbeat forever. */
  _resyncFailedFor: string | null = null;
  streamingIndex: number | null = null;
  liveBuffer: ChatEvent[] | null = null;
  // True while the retained pane cache holds this renderer off-screen (see
  // pauseLiveRender). Distinct from `liveBuffer !== null`, which a bulk load
  // also sets - the flag is what tells bulkLoadEvents to re-park on finish.
  _liveParked = false;
  // Pending trailing-edge flush timer for scheduleFlush's throttle (ai_todo
  // streaming-render O(n^2) fix, Fix 2). Non-null while a coalescing window
  // is open; cleared by flushRenderNow or by detach() so a stray timer never
  // fires flushRender() against a renderer reused for a different session.
  _flushTimer: ReturnType<typeof setTimeout> | null = null;
  sessionId: string | null = null;
  _bulkGen = 0;
  meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  _cumulative: CumulativeUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
  activeTurnStart: number | null = null;
  // Silent-streak merge: index of the current chain's first meta-turn chip
  // (see classifyMetaTurn), and how many turns have folded into it so far. Null/0 when
  // the open turn isn't (yet) part of a merged streak. See
  // turnProducedVisibleContent in chat-event-handler.ts.
  silentStreakBoundaryIndex: number | null = null;
  silentStreakCount = 0;
  // Per-renderer footer registry (instance state - chip keys are a local
  // sequence, a shared registry would collide across renderer instances).
  turnFooters = new TurnFooterRegistry();
  // Key for the current turn's footer (created on user_message, frozen on
  // close). Null when no turn is in progress.
  activeTurnChipKey: TurnChipKey | null = null;
  // Monotonically-increasing counter for chip keys. Using a counter instead of
  // Date.now() ensures uniqueness even when tests freeze system time.
  _chipKeySeq = 0;
  // Accumulated streamed assistant text for the current turn (for live token
  // estimate). Reset at each new turn.
  activeTurnStreamedText = "";
  // Turn-scoping marker for the TodoWrite-driven checklist: null = no
  // checklist active for the current turn yet. Reset at each turn boundary.
  turnTodosBaseline: { content: string; status: string }[] | null = null;
  // Running tracker of the full todos array as of the last TodoWrite call.
  // NEVER reset at turn boundaries - only ever overwritten.
  lastTodosSnapshot: { content: string; status: string }[] | null = null;
  // In-flight TodoWrite tool_use ids, so the paired tool_result can be
  // silently absorbed instead of rendered as a raw tool_result row.
  _todoWriteToolUseIds = new Set<string>();
  // update_message acks: absorbed silently, same as TodoWrite's.
  _updateMsgToolUseIds = new Set<string>();
  // Wall-clock ms when the active turn's user message arrived. Drives the
  // live elapsed display (NEVER derive elapsed from the key - it's a counter).
  activeTurnStartedAtMs = 0;
  /** Ordinal counter for compaction events; incremented each time a compact user_message is seen. */
  compactionCount = 0;
  // Combined usage for the active turn. History replays one turn_usage per
  // assistant line, so output/cache/cost SUM across events; input is the
  // latest (context-size semantics); durationMs is the max seen (live's
  // single result event carries the real one, history carries none).
  activeTurnUsage: TurnUsageTotals | null = null;
  // First/last real event timestamps of the active turn - the duration
  // fallback for history, where duration_ms is absent. Live events all carry
  // timestamp 0, so the span stays 0 there (live has real duration_ms).
  activeTurnFirstTs = 0;
  activeTurnLastTs = 0;
  // Per-type tool-group elements for the turn in progress (key = canonical tool
  // name). Cleared at each turn end; re-populated by groupToolRange each flush.
  activeToolGroups = new Map<string, ToolGroup>();
  closeTurnQueue: {
    start: number;
    end: number;
    chipKey: TurnChipKey | null;
    usage: TurnUsageTotals | null;
    tsSpanMs: number;
  }[] = [];
  fileEdits: FileEditView[] = [];
  lastActivity: string | null = null;
  // True once the tool `lastActivity` describes has RETURNED - the label
  // stays on screen (no blank-to-generic-"Thinking" flash) but the bar
  // suffixes it to show the model is past that step. False while the tool
  // is still in flight, or once a new activity/turn boundary overwrites it.
  activityIdle = false;
  // Canonical tool of the CURRENT activity (the most recent tool_use, the one
  // `lastActivity` describes, e.g. "Editing api.ts" -> "Edit"). Drives the
  // single working-chip highlight so only the chip for what the AI is doing
  // right now pulses - not every tool that has an in-flight call. Cleared on
  // turn boundary / reset, same lifecycle as lastActivity.
  activityToolCanon: string | null = null;
  // In-flight tool_use ids from handleToolUseEvent's generic path. Activity
  // clears to null only once this drains empty, so back-to-back tool calls
  // don't blank the bar between one result and the next use. Cleared at
  // turn-close so a stale id can't block the next turn.
  outstandingActivityToolIds = new Set<string>();
  // Set when an AUQ tool_use closes the streaming slot via enqueueTurnClose,
  // so the result line's finalizing AssistantMessage (which carries the
  // already-rendered pre-AUQ text) doesn't create a duplicate bubble.
  // auqPreContent records what the streaming slot contained at the moment AUQ
  // fired, so the suppression branch can distinguish the protocol re-emit
  // (same content → suppress) from genuine post-AUQ output (different content
  // → render). Without this, a file-watcher delivery of real post-AUQ content
  // while auqPendingResult is still true silently drops the message.
  auqPendingResult = false;
  auqPreContent: string | null = null;
  // By-type cumulative tool tally state (counts + per-target details, dedup by
  // tool_use id). Owns the data behind the statusline `Read x4 · ...` tally.
  tallyState = new ToolTallyState();
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;
  public onFileEditsChanged: ((edits: FileEditView[]) => void) | null = null;
  public onToolTally: ((t: ToolTally) => void) | null = null;
  public onActivityUpdate: ((activity: string | null, idle?: boolean) => void) | null = null;
  public onProgressUpdate: ((n: number, m: number) => void) | null = null;
  public onTodoActivityUpdate: ((activeForm: string | null) => void) | null = null;
  public onSendText: ((text: string) => void) | null = null;
  /** Fired when a next-ai-prompt skill turn completes. Active-session wires this to show the pickup CTA. */
  public onNextAiPromptDone: (() => void) | null = null;
  /** Set by chat-event-handler when a Skill tool_use for "next-ai-prompt" is seen in a live turn. */
  _nextAiPromptPending = false;
  turnStatus: "done" | "question" | "waiting" | "working" | null = null;
  // True only while bulkLoadEvents replays HISTORY on open. During replay the
  // per-event onActivityUpdate / onFileEditsChanged callbacks are suppressed so
  // the header changes-badge doesn't visibly count up and the thinking bar
  // doesn't flip through every past activity; the final state is delivered once
  // when replay finishes. Live events (after hydration) animate normally.
  hydrating = false;
  paginator: ChatPaginator;
  // Pauses `.rainbow-keyword`'s animation off-screen (todo 185). The Mutation-
  // Observer auto-observes each new `.msg`, so no call site needs to know.
  private animObserver: IntersectionObserver | null = null;
  private animMutationObserver: MutationObserver | null = null;

  setTurnStatus(s: "done" | "question" | "waiting" | "working" | null): void {
    if (this.turnStatus === s) return;
    this.turnStatus = s;
    if (s !== null && this._nextAiPromptPending && !this.hydrating) {
      this._nextAiPromptPending = false;
      this.onNextAiPromptDone?.();
    }
  }

  setActivity(a: string | null, opts: { keepChip?: boolean; idle?: boolean } = {}): void {
    // keepChip skips the highlight clear for the "turn's tools resolved" case
    // (thinking-bar text goes idle, chip keeps pulsing till the turn closes).
    if (a === null && !opts.keepChip) this.activityToolCanon = null;
    const idle = !!opts.idle;
    if (this.lastActivity === a && this.activityIdle === idle) return;
    this.lastActivity = a;
    this.activityIdle = idle;
    // Suppressed during history replay; the final activity is fired once when
    // bulkLoadEvents finishes (see `hydrating`).
    if (!this.hydrating) this.onActivityUpdate?.(a, idle);
  }

  /** Clear all per-turn meta tracking (key, usage, timestamps, streamed text). */
  resetActiveTurnMeta(): void {
    this.activeTurnChipKey = null;
    this.activeTurnStreamedText = "";
    this.activeTurnStartedAtMs = 0;
    this.activeTurnUsage = null;
    this.activeTurnFirstTs = 0;
    this.activeTurnLastTs = 0;
    this.silentStreakBoundaryIndex = null;
    this.silentStreakCount = 0;
  }

  /** The ONE place that enumerates every index-typed field. Callers supply the
   *  mapping (prepend: `i => i + n`; splice: `i => i > from ? i - 1 : i`) plus,
   *  optionally, indices to drop from `dirtyIndices` before remapping. A new
   *  index field belongs here, never in a caller. */
  remapIndices(fn: (i: number) => number, drop?: Set<number>): void {
    const mapOrNull = (i: number | null): number | null => (i === null ? null : fn(i));
    this.streamingIndex = mapOrNull(this.streamingIndex);
    this.activeTurnStart = mapOrNull(this.activeTurnStart);
    this.silentStreakBoundaryIndex = mapOrNull(this.silentStreakBoundaryIndex);
    if (this.dirtyIndices.size > 0) {
      const remapped = new Set<number>();
      for (const idx of this.dirtyIndices) {
        if (!drop?.has(idx)) remapped.add(fn(idx));
      }
      this.dirtyIndices = remapped;
    }
    if (this.closeTurnQueue.length > 0) {
      this.closeTurnQueue = this.closeTurnQueue.map((entry) => ({
        ...entry,
        start: fn(entry.start),
        end: fn(entry.end),
      }));
    }
  }

  get cumulativeUsage(): CumulativeUsage {
    return { ...this._cumulative };
  }

  constructor(container: HTMLElement) {
    this.container = container;
    // Edit windows are default-collapsed; their diffs enhance on first open.
    armLazyDiffEnhance(this.container);
    this.container.addEventListener("click", handleCopyClick);
    this.container.addEventListener("click", handleSlashClick);
    this.container.addEventListener("click", handleAttachmentClick);
    this.container.addEventListener("click", this.handleBlockImageClick);
    this.container.addEventListener("click", this.handleScreenshotThumbClick);
    this.container.addEventListener("click", handlePastedLogClick);
    this.container.addEventListener("click", handleAuqAnswerClick);
    this.container.addEventListener("click", handleTableFullscreen);
    this.container.addEventListener("click", handlePrPreviewClick);
    this.container.addEventListener("click", this.handleToolChipClick);
    this.container.addEventListener("click", this.handleToolFileClick);
    this.container.addEventListener("click", this.handleToolResultLoadFullClick);
    this.container.addEventListener("click", this.handleRetryClick);
    this.container.addEventListener("click", this.handleCtaClick);
    this.installAnimObserver();
    this.paginator = new ChatPaginator(container, {
      getSessionId: () => this.sessionId,
      getMessages: () => this.messages,
      getMessageEls: () => this.messageEls,
      setMessages: (m) => { this.messages = m; },
      setMessageEls: (els) => { this.messageEls = els; },
      buildMessageEl: (m) => buildMessageEl(m),
      clampUserMessages: () => clampUserMessages(this.messages, this.messageEls),
      foldClosedRange: (start, end, usage, tsSpanMs) => foldClosedRange(this, start, end, usage, tsSpanMs),
      // Prepend: every tracked index moves down the transcript by n.
      onShift: (n) => this.remapIndices((i) => i + n),
    });
  }

  async attach(sessionId: string): Promise<void> {
    this.detach();
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this._liveParked = false;
    this.liveBuffer = null;
    this.meta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
    this._cumulative = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
    this.fileEdits = [];
    this.lastActivity = null;
    this.activityIdle = false;
    this.activityToolCanon = null;
    this.outstandingActivityToolIds.clear();
    this.activeToolGroups.clear();
    this.tallyState.reset();
    this.onFileEditsChanged?.([]);
    this.onToolTally?.(this.tallyState.build());
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";
    this.activeTurnStart = null;
    this.resetActiveTurnMeta();
    this.turnFooters.clear();
    this.closeTurnQueue = [];
    this.installAnimObserver();
    this._resubscribe(sessionId);
  }

  /** (Re-)arm the off-screen animation pause (todo 185). One IntersectionObserver
   *  toggles `.anim-paused` on each `.msg`'s `.rainbow-keyword` spans; a sibling
   *  MutationObserver auto-observes/-unobserves `.msg` children as they're
   *  added/removed by streaming, dirty-replace, or pagination. */
  private installAnimObserver(): void {
    this.removeAnimObserver();
    // Test/harness environments may lack these (jsdom has no IntersectionObserver
    // at all; some test setups don't stub MutationObserver either) - skip quietly,
    // real browsers always have both.
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
    const anim = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const paused = !entry.isIntersecting;
          for (const kw of (entry.target as HTMLElement).querySelectorAll<HTMLElement>(".rainbow-keyword")) {
            kw.classList.toggle("anim-paused", paused);
          }
        }
      },
      // Implicit root ignores ancestor overflow: nothing would ever pause.
      { root: this.scrollRoot() },
    );
    this.animObserver = anim;
    this.animMutationObserver = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("msg")) anim.observe(node);
        }
        for (const node of rec.removedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("msg")) anim.unobserve(node);
        }
      }
    });
    this.animMutationObserver.observe(this.container, { childList: true });
  }

  /** Nearest scrollable ancestor, null = viewport. Ignores content size, unlike
   *  the paginator's `findScroller`, so it resolves before the chat overflows. */
  private scrollRoot(): HTMLElement | null {
    if (typeof getComputedStyle === "undefined") return null;
    let n: HTMLElement | null = this.container;
    while (n) {
      const o = getComputedStyle(n).overflowY;
      if (o === "auto" || o === "scroll") return n;
      n = n.parentElement;
    }
    return null;
  }

  private removeAnimObserver(): void {
    try { this.animObserver?.disconnect(); } catch { /* ignore */ }
    try { this.animMutationObserver?.disconnect(); } catch { /* ignore */ }
    this.animObserver = null;
    this.animMutationObserver = null;
  }

  private handleLive(ev: ChatEvent): void {
    if (this.liveBuffer !== null) {
      this.liveBuffer.push(ev);
    } else {
      handleChatEvent(this, ev);
    }
  }

  /** Park incoming live events instead of rendering them (retained pane cache,
   *  chat off-screen). Staying subscribed keeps the transcript complete without
   *  a re-fetch, at the cost of an array push instead of a detached DOM build. */
  pauseLiveRender(): void {
    if (this._liveParked) return;
    this._liveParked = true;
    if (this.liveBuffer === null) this.liveBuffer = [];
  }

  /** Render everything parked since {@link pauseLiveRender}, in arrival order. */
  resumeLiveRender(): void {
    if (!this._liveParked) return;
    this._liveParked = false;
    const buffered = this.liveBuffer ?? [];
    this.liveBuffer = null;
    for (const ev of buffered) handleChatEvent(this, ev);
  }

  /** How many live events are waiting for a resume. */
  get parkedEventCount(): number {
    return this._liveParked ? (this.liveBuffer?.length ?? 0) : 0;
  }

  /** Feed a single event through the renderer (live or test-driven). */
  handleEvent(ev: ChatEvent, opts: HandleEventOpts = {}): void {
    handleChatEvent(this, ev, opts);
  }

  async loadFromStore(cwd?: string, opts: BulkLoadOpts = {}): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.paginator.cwdHint = cwd;
    // Skip marks (todo 661) fetched once per hydrate, alongside the history
    // page, and cached on the paginator so both the bulk-load fold and the
    // older-page fold read the same list.
    const [events, marks] = await Promise.all([sessionEvents.loadInitial(sid, cwd), fetchSkipMarks(sid)]);
    if (this.sessionId !== sid) return;
    this.paginator.skipMarks = marks;
    await bulkLoadEvents(this, [...events], opts);
    if (this.sessionId !== sid) return;
    this.paginator.install();
  }

  detach(): void {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    if (this.unsubscribeTail) {
      try { this.unsubscribeTail(); } catch { /* ignore */ }
      this.unsubscribeTail = null;
    }
    this.paginator.remove();
    this.paginator.resetTurnCarry();
    this.removeAnimObserver();
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.streamingIndex = null;
    this.dirtyIndices.clear();
    this._liveParked = false;
    this.liveBuffer = null;
    this.activeTurnStart = null;
    this.resetActiveTurnMeta();
    this.turnFooters.clear();
    this.activeToolGroups.clear();
    this.closeTurnQueue = [];
    this.setActivity(null);
    this.sessionId = null;
    // A load aborted mid-flight (detach before its settle reveal) must never
    // leave the transcript stuck at opacity 0 when the container is reused.
    revealTranscript(this);
  }

  /** Shared unsubscribe-then-subscribe tail for attach/ensureSubscribed/
   *  swapSubscription. `sessionId`/`unsubscribe` are assigned ONLY here, so
   *  the pair is always written together - no other writer to grep for. */
  private _resubscribe(sessionId: string): void {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    if (this.unsubscribeTail) {
      try { this.unsubscribeTail(); } catch { /* ignore */ }
      this.unsubscribeTail = null;
    }
    this.sessionId = sessionId;
    this._resyncFailedFor = null;
    this.unsubscribe = sessionEvents.subscribe(sessionId, (ev) => {
      this.handleLive(ev);
    });
    this.unsubscribeTail = sessionEvents.subscribeTranscriptTail(sessionId, (sigs) => {
      this.onTranscriptTail(sigs);
    });
  }

  /** Delegates to chat-resync.ts. Kept as a method so tests can drive the
   *  tail check without reaching into the event store. */
  onTranscriptTail(sigs: string[]): void {
    onTranscriptTail(this, sigs);
  }

  /** Idempotent (re-)subscribe. `sessionId`/`unsubscribe` are only ever set
   *  together by attach/swapSubscription/detach, so the pair alone proves
   *  membership. Self-heals a retained renderer whose subscription was severed
   *  by a path that moved its pane-cache slot without repointing it. */
  ensureSubscribed(sessionId: string): void {
    if (this.sessionId === sessionId && this.unsubscribe !== null) return;
    this._resubscribe(sessionId);
  }

  async swapSubscription(newSessionId: string): Promise<void> {
    if (this.sessionId === newSessionId) return;
    const oldId = this.sessionId;
    if (oldId) {
      // Unsubscribe (without clearing the field - _resubscribe's own guard
      // handles that) BEFORE the swap, so its subscriber-set merge never
      // copies this renderer's own listener into the target and duplicates it.
      try { this.unsubscribe?.(); } catch { /* ignore */ }
      await sessionEvents.swap(oldId, newSessionId);
    }
    this._resubscribe(newSessionId);
  }

  /** Exposed for tests that drive pagination without a real IntersectionObserver. */
  fetchOlder(): Promise<void> {
    return this.paginator.fetchOlder();
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getFileEdits(): FileEditView[] {
    return [...this.fileEdits];
  }

  /** Mirror the floating AUQ prompt card's live per-question progress into
   *  this session's still-pending question card in the transcript. No-op if
   *  the prompt isn't in this session's loaded range, is already resolved
   *  (its tool_result landed), or progress is unchanged - avoids replacing
   *  the message's DOM node on every keystroke for no visible change. */
  updateQuestionProgress(promptId: string, liveAnswered: boolean[]): void {
    const idx = this.messages.findIndex((m) => m.kind === "question" && m.id === promptId);
    if (idx < 0) return;
    const m = this.messages[idx]!;
    if (m.text !== undefined) return;
    if (m.liveAnswered && m.liveAnswered.length === liveAnswered.length && m.liveAnswered.every((v, i) => v === liveAnswered[i])) return;
    this.messages[idx] = { ...m, liveAnswered };
    this.dirtyIndices.add(idx);
    flushRenderNow(this);
  }

  /** Clone of the by-type tool tally (no internal refs leaked). */
  get toolTally(): ToolTally {
    return this.tallyState.build();
  }

  /**
   * Rendered custom-view HTML for a tool over ALL loaded messages, or null when
   * the tool has no custom view. Lets the statusline tally popover reuse the
   * exact same Read/File-Changes/Skills/Questions views as the in-chat chips.
   */
  customToolView(tool: string): string | null {
    return renderCustomToolView(tool, this.messages, 0, this.messages.length);
  }

  async loadHistory(events: ChatEvent[], opts: BulkLoadOpts = {}): Promise<void> {
    await bulkLoadEvents(this, events, opts);
  }

  /** Tapping an inline rendered image block (screenshots, image tool results)
   *  opens the chat-wide gallery at that image, matched by content since the
   *  collection is recomputed fresh each click. */
  private handleBlockImageClick = (e: MouseEvent): void => {
    const img = (e.target as Element).closest<HTMLImageElement>("img.block.image");
    if (!img) return;
    const match = /^data:([^;]+);base64,(.+)$/.exec(img.src);
    const mime = match?.[1];
    const base64 = match?.[2];
    if (!mime || !base64) return;
    const collection = collectChatImages(this.messages, this.messageEls);
    const foundIndex = collection.images.findIndex((ci) => ci.kind === "screenshot" && ci.data === base64 && ci.mime === mime);
    if (foundIndex >= 0) openChatImageGallery(collection, foundIndex);
    else openLightbox({ type: "image", mime, base64 });
  };

  /** Tapping a screenshot-row thumbnail (turn-collapse.ts's screenshot-block)
   *  opens the chat-wide gallery, starting at the clicked shot. The shot is
   *  resolved via screenshot-row.ts's WeakMap, then matched by content into
   *  the freshly-collected gallery collection. */
  private handleScreenshotThumbClick = (e: MouseEvent): void => {
    const thumb = (e.target as Element).closest<HTMLElement>(".screenshot-thumb");
    if (!thumb) return;
    const row = thumb.closest<HTMLElement>(".screenshot-row");
    if (!row) return;
    const shots = getScreenshotRowShots(row);
    if (!shots) return;
    const shotIdx = Number(thumb.dataset.shotIndex);
    if (!Number.isFinite(shotIdx)) return;
    const shot = shots[shotIdx];
    if (!shot) return;
    const collection = collectChatImages(this.messages, this.messageEls);
    const foundIndex = collection.images.findIndex((ci) => ci.kind === "screenshot" && ci.data === shot.data && ci.mime === shot.mime);
    if (foundIndex >= 0) openChatImageGallery(collection, foundIndex);
    else openLightbox({ type: "image", mime: shot.mime, base64: shot.data });
  };

  // Custom chip-panel file rows (Read / File Changes) open their target in the
  // in-app file viewer (ai_todo 95). The external-editor jump is preserved via
  // the "Open in VS Code" button in the viewer header.
  private handleToolFileClick = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tool-file-row[data-path]");
    if (!row) return;
    const path = row.dataset.path;
    if (path) openFileViewer(path);
  };

  /** A page-truncated tool_result row's "Load full output" button (ai_todo
   *  json-cache): fetches the untruncated content on demand instead of
   *  shipping every large Bash/Read/Grep dump on every page load. */
  private handleToolResultLoadFullClick = (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".tool-result-load-full");
    if (!btn || !this.sessionId) return;
    const toolUseId = btn.dataset.toolUseId;
    const seq = Number(btn.dataset.seq);
    if (!toolUseId || !Number.isFinite(seq)) return;
    const card = btn.nextElementSibling as HTMLElement | null;
    btn.disabled = true;
    btn.innerHTML = `<i class="ph ph-spinner tool-result-load-spin"></i>Loading…`;
    void invoke<ChatEvent>("load_event_detail", {
      sessionId: this.sessionId,
      cwd: this.paginator.cwdHint,
      seq,
      toolUseId,
    })
      .then((ev) => {
        if (ev.type !== "tool_result") throw new Error("unexpected event type");
        card?.remove();
        btn.outerHTML = renderBlocks([ev.output]);
      })
      .catch((err) => {
        console.error("[chat-renderer] load_event_detail failed", err);
        btn.disabled = false;
        btn.innerHTML = `<i class="ph ph-warning"></i>Failed to load - retry`;
      });
  };

  private handleRetryClick = (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".api-retry-btn");
    if (!btn || !this.onSendText) return;
    btn.disabled = true;
    this.onSendText("continue");
  };

  private handleCtaClick = (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".msg-cta-btn");
    if (!btn) return;
    const id = btn.dataset.ctaId;
    if (!id) return;
    const action = getCta(id);
    if (!action) return;
    btn.closest<HTMLElement>(".msg-cta")?.remove();
    void action.handler();
  };

  /** Append an action button to the last assistant message bubble. */
  injectCta(actionId: string): void {
    const action = getCta(actionId);
    if (!action) return;
    const last = [...this.container.querySelectorAll<HTMLElement>(".msg.assistant")].at(-1);
    if (!last) return;
    if (last.querySelector(`.msg-cta[data-cta-id="${actionId}"]`)) return;

    const wrap = document.createElement("div");
    wrap.className = "msg-cta";
    wrap.dataset.ctaId = actionId;

    const btn = document.createElement("button");
    btn.className = "msg-cta-btn";
    btn.dataset.ctaId = actionId;
    if (action.icon) {
      const icon = document.createElement("i");
      icon.className = `ph ph-${action.icon}`;
      btn.appendChild(icon);
    }
    btn.appendChild(document.createTextNode(action.label));
    wrap.appendChild(btn);
    last.appendChild(wrap);
  }

  private handleToolChipClick = (e: MouseEvent): void => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".tool-chip");
    if (!chip) return;
    let strip = chip.closest<HTMLElement>(".tool-strip");
    if (!strip) {
      // Chip relocated into a screenshot-block's header (turn-collapse.ts's
      // mountScreenshotBlock, for a tool with image results): resolve the
      // shared top-level .tool-strip via the block's host instead - there is
      // exactly one main strip+panel pair per turn footer / stripHost.
      const block = chip.closest<HTMLElement>(".screenshot-block");
      strip = block?.parentElement?.querySelector<HTMLElement>(":scope > .tool-strip") ?? null;
    }
    const panel = strip?.nextElementSibling as HTMLElement | null;
    if (!strip || !panel?.classList.contains("tool-strip-panel")) return;

    const tool = chip.dataset.tool;
    const wasActive = chip.classList.contains("tool-chip--active");

    // Scope to DIRECT-child chips/groups so a click at one nesting level never
    // toggles a deeper level's chips/buckets (3-level: Subagent > subagent >
    // tool). A relocated screenshot-block chip isn't a .tool-strip child, so
    // it's cleared via the block's own host lookup alongside the strip's chips.
    strip.querySelectorAll<HTMLElement>(":scope > .tool-chip").forEach(c => c.classList.remove("tool-chip--active"));
    strip.parentElement
      ?.querySelectorAll<HTMLElement>(":scope > .screenshot-block > .screenshot-block-header > .tool-chip")
      .forEach(c => c.classList.remove("tool-chip--active"));
    for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
      grp.hidden = true;
    }

    if (!wasActive && tool) {
      chip.classList.add("tool-chip--active");
      for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
        grp.hidden = grp.dataset.tool !== tool;
      }
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  };
}
