// Held messages: while Claude is busy on a turn, follow-up messages are not
// sent immediately. They're "held" (staged) per session, shown as an inline
// chip on the working bar, and flushed as ONE bundled user message either when
// Claude finishes cleanly or when the user forces it via "Send now".
//
// This controller owns the per-session held set and renders the chip + a
// floating dropdown of editable rows. It is a singleton (stored on
// `state.heldMessages`); the active pane re-`attach()`es it on every mount so
// the held set survives session switches, and is ALSO mirrored to localStorage
// (held-messages-persistence.ts) so it survives a full reload too. See
// docs/superpowers/specs/2026-06-13-held-messages-while-busy-design.md.

import type { ContentBlock } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";
import { AUQ_ANSWER_SENTINEL } from "./chat-transforms";
import { loadAllHeld, saveAllHeld } from "./held-messages-persistence";
import { HeldMessagesRender } from "./held-messages-render";
import "./held-messages.css";

export interface HeldItem {
  id: number;
  blocks: ContentBlock[];
}

// Poll cadence for a deferred auto-flush. Sits just past the composer's 2000ms
// isComposing() keystroke window so a "staged then waited" message flushes on
// its own one tick after the user stops typing.
const DEFER_RETRY_MS = 2100;

/** Everything the controller needs from the currently-mounted pane/composer.
 * Re-supplied on every `attach()` because the pane DOM and the per-session
 * send/interrupt closures are rebuilt on each session switch. */
export interface HeldAttach {
  sessionId: string;
  /** Right-hand slot inside `.session-thinking` where the chip renders. */
  chipSlot: HTMLElement;
  /** `.session-thinking` (position: relative) — anchors the floating dropdown. */
  anchor: HTMLElement;
  /** Bundled send for THIS session (same path as the composer's onSend). */
  send: (blocks: ContentBlock[]) => Promise<void> | void;
  /** Interrupt the in-flight turn for THIS session (cancel_turn). */
  interrupt: () => Promise<void> | void;
  getDraftBlocks: () => ContentBlock[];
  isDraftEmpty: () => boolean;
  isComposing: () => boolean;
  clearComposer: () => void;
  getIsBusy: () => boolean;
  /** Re-evaluate the working-bar visibility + chip (-> updateThinkingBar). */
  onChange: () => void;
}


/** Join held items (+ optional trailing draft) into a single text block:
 * each message's text on its own, separated by a blank line. Non-text blocks
 * (none today — images become `<file:…>` text in the composer) are appended
 * after, preserving order.
 *
 * A group that IS an AUQ answer (see chat-transforms.ts's AUQ_ANSWER_SENTINEL,
 * sent as the sole content of the draft by permission-modal/index.ts onSubmit)
 * is kept as its OWN block instead of being joined into the merged prose text:
 * joining it would bury the sentinel mid-string and pollute the folded
 * question-card answer with unrelated held prose (extractAuqAnswerText below
 * finds it regardless of position in the output array). */
export function bundleHeld(items: ContentBlock[][], draftBlocks: ContentBlock[] = []): ContentBlock[] {
  const groups = draftBlocks.length ? [...items, draftBlocks] : items;
  const texts: string[] = [];
  const extras: ContentBlock[] = [];
  for (const g of groups) {
    if (g.length === 1 && g[0]?.type === "text" && g[0].text.startsWith(AUQ_ANSWER_SENTINEL)) {
      extras.push(g[0]);
      continue;
    }
    const t = blocksToText(g).trim();
    if (t) texts.push(t);
    for (const b of g) if (b && b.type !== "text") extras.push(b);
  }
  const out: ContentBlock[] = [];
  if (texts.length) out.push({ type: "text", text: texts.join("\n\n") });
  out.push(...extras);
  return out;
}

export class HeldMessages {
  private map: Map<string, HeldItem[]>;
  private attached: HeldAttach | null = null;
  private deferredSid: string | null = null;
  private deferRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private render = new HeldMessagesRender(this);

  // Rehydrate any queue a prior reload would otherwise have dropped. nextId
  // continues past the highest restored id so a fresh stage() can't collide.
  constructor() {
    this.map = loadAllHeld();
    for (const items of this.map.values()) {
      for (const item of items) if (item.id >= this.nextId) this.nextId = item.id + 1;
    }
  }

  private persist(): void {
    saveAllHeld(this.map);
  }

  /** Point the controller at the freshly-mounted active pane. */
  attach(opts: HeldAttach): void {
    this.render.reset();
    this.clearDeferRetry();
    this.attached = opts;
    opts.onChange();
  }

  /** Migrate a held set when a pending placeholder id becomes the real session
   * id, so staged items + the active-session matching (chip render, completion
   * auto-flush) follow the session across the rename. */
  renameSession(from: string, to: string): void {
    if (from === to) return;
    const items = this.map.get(from);
    if (items && items.length) {
      const existing = this.map.get(to) ?? [];
      this.map.set(to, [...existing, ...items]);
    }
    this.map.delete(from);
    this.persist();
    if (this.attached && this.attached.sessionId === from) {
      this.attached.sessionId = to;
      this.render.renderChip();
    }
  }

  private get sid(): string | null {
    return this.attached?.sessionId ?? null;
  }

  /** HeldRenderHost. */
  itemsForActive(): HeldItem[] {
    const sid = this.sid;
    if (!sid) return [];
    return this.map.get(sid) ?? [];
  }

  /** HeldRenderHost. */
  getAttached(): HeldAttach | null {
    return this.attached;
  }

  hasItemsForActive(): boolean {
    return this.itemsForActive().length > 0;
  }

  /** Whether ANY session (attached or backgrounded) has staged items. */
  hasItemsFor(sid: string): boolean {
    return (this.map.get(sid) ?? []).length > 0;
  }

  /** Stage a message for the active session (called by the composer while busy). */
  stage(blocks: ContentBlock[]): void {
    const sid = this.sid;
    if (!sid) return;
    const list = this.map.get(sid) ?? [];
    list.push({ id: this.nextId++, blocks });
    this.map.set(sid, list);
    this.persist();
    this.attached?.onChange();
  }

  // ---- flush paths -------------------------------------------------------

  private async flush(includeDraft: boolean): Promise<void> {
    const a = this.attached;
    const sid = this.sid;
    if (!a || !sid) return;
    const items = this.itemsForActive();
    const draftBlocks = includeDraft && !a.isDraftEmpty() ? a.getDraftBlocks() : [];
    if (items.length === 0 && draftBlocks.length === 0) return;
    const bundle = bundleHeld(items.map((i) => i.blocks), draftBlocks);
    // Clear state BEFORE sending so a re-render mid-send can't double-fire.
    this.map.set(sid, []);
    this.persist();
    this.deferredSid = null;
    this.clearDeferRetry();
    this.render.reset();
    if (includeDraft && draftBlocks.length) a.clearComposer();
    a.onChange();
    if (bundle.length === 0) return;
    await a.send(bundle);
  }

  /** Explicit "Send now": interrupt the turn, then send held + draft as one. */
  async sendNow(): Promise<void> {
    const a = this.attached;
    if (!a) return;
    try {
      await a.interrupt();
    } catch {
      /* best-effort: cancel_turn may no-op if the turn already ended */
    }
    await this.flush(true);
  }

  /** Composer routed a normal (not-busy) send here because held items exist:
   * bundle the existing held set with this draft into one message. The composer
   * clears itself after calling. */
  async flushHeldWithDraft(draftBlocks: ContentBlock[]): Promise<void> {
    const a = this.attached;
    const sid = this.sid;
    if (!a || !sid) return;
    const items = this.itemsForActive();
    const bundle = bundleHeld(items.map((i) => i.blocks), draftBlocks);
    this.map.set(sid, []);
    this.persist();
    this.deferredSid = null;
    this.clearDeferRetry();
    this.render.reset();
    a.onChange();
    if (bundle.length === 0) return;
    await a.send(bundle);
  }

  /** Flush the held set of a BACKGROUNDED (not-attached) session. The mounted
   * pane's HeldAttach.send closure only covers the attached session, so the
   * caller injects a session-agnostic sender (a raw send_message invoke) here.
   * No draft/composer semantics apply: nothing is mounted for this session.
   * The caller gates on the question-hold check, same as onCompletion's
   * isQuestion. Idempotent against the reselect-flush path: the held set is
   * cleared BEFORE the async send, so an attach() + onCompletion() landing
   * mid-send finds an empty set and no-ops. */
  async flushBackground(sid: string, send: (blocks: ContentBlock[]) => Promise<void> | void): Promise<void> {
    // If the session is actually mounted (e.g. the user switched to it between
    // the caller's snapshot and now), the attached path owns it: it respects
    // the composing defer and bundles the draft. Never send around it.
    if (this.attached && this.attached.sessionId === sid) {
      this.onCompletion(sid, false);
      return;
    }
    const items = this.map.get(sid) ?? [];
    if (items.length === 0) return;
    const bundle = bundleHeld(items.map((i) => i.blocks));
    // Clear state BEFORE sending so a concurrent flush path can't double-fire.
    this.map.set(sid, []);
    this.persist();
    if (this.deferredSid === sid) this.deferredSid = null;
    if (bundle.length === 0) return;
    try {
      await send(bundle);
    } catch (err) {
      console.error("[held] background flush send failed", err);
    }
  }

  /** Busy went true->false for the active session. Auto-flush unless Claude is
   * asking a question (hold for the answer) or the user is mid-compose. When we
   * defer for composing, a self-retry timer keeps trying so the flush still
   * fires if the user simply WAITS (the input/blur-driven notifyDraftActivity
   * never fires when they don't touch the composer). */
  onCompletion(sid: string, isQuestion: boolean): void {
    if (sid !== this.sid) return;
    if (this.itemsForActive().length === 0) return;
    if (isQuestion) return;
    if (this.attached?.isComposing()) {
      this.deferredSid = sid;
      this.scheduleDeferRetry();
      return;
    }
    void this.flush(false);
  }

  /** The composer's draft changed (input/blur). Retry a deferred auto-flush
   * once the user has stopped composing and the session is idle. */
  notifyDraftActivity(): void {
    const a = this.attached;
    if (!a) return;
    if (this.deferredSid && this.deferredSid === this.sid && !a.isComposing() && !a.getIsBusy()) {
      this.deferredSid = null;
      this.clearDeferRetry();
      void this.flush(false);
    }
  }

  /** Poll until a deferred flush can fire on its own: once the user stops
   * composing (the 2s keystroke window lapses) and the session is idle, send.
   * If they're still actively typing or the session is busy again, keep waiting
   * — this never force-interrupts an in-progress draft, it only covers the
   * "staged a message and walked away" case the blur/input path missed. */
  private scheduleDeferRetry(): void {
    if (this.deferRetryTimer !== null) return; // already polling
    this.deferRetryTimer = setTimeout(() => {
      this.deferRetryTimer = null;
      const a = this.attached;
      if (!this.deferredSid || this.deferredSid !== this.sid) return;
      if (!a || this.itemsForActive().length === 0) { this.deferredSid = null; return; }
      if (a.isComposing() || a.getIsBusy()) {
        this.scheduleDeferRetry(); // still typing / busy — check again shortly
        return;
      }
      this.deferredSid = null;
      void this.flush(false);
    }, DEFER_RETRY_MS);
  }

  private clearDeferRetry(): void {
    if (this.deferRetryTimer !== null) {
      clearTimeout(this.deferRetryTimer);
      this.deferRetryTimer = null;
    }
  }

  // ---- rendering (delegated to HeldMessagesRender; this class is its host) -

  renderChip(): void {
    this.render.renderChip();
  }

  /** HeldRenderHost: drop one staged item (dropdown row emptied/removed). */
  removeItem(id: number): void {
    const sid = this.sid;
    if (!sid) return;
    this.map.set(sid, (this.map.get(sid) ?? []).filter((i) => i.id !== id));
    this.persist();
  }

  /** HeldRenderHost: live text edit of a staged row (caret-preserving, no re-render). */
  editItem(id: number, text: string): void {
    const item = this.itemsForActive().find((i) => i.id === id);
    if (!item) return;
    item.blocks = [{ type: "text", text }];
    this.persist();
  }
}
