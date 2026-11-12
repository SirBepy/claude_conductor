// Builds the dashboard's rows from above the loaded history page
// (shared/chat/dashboard/history-prefix.ts has the why). The window paints its
// newest page first, exactly as before; after that, this asks for the
// transcript's digest above that page (`load_dashboard_digest`, only the events
// the durable cards read) and replays it, followed by the loaded page and every
// live event, through a second ChatRenderer that is never drawn. Replaying the
// loaded page and live events too is what lets an old question answered later,
// or an old card revised later, read as answered or revised.
//
// The transcript renderer stays the source of the loaded rows, so Messages view
// and every live-only state it keeps (answered cards, held sends) are unchanged.

import type { ChatEvent } from "../../../types/ipc.generated";
import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import { handleChatEvent } from "../../../shared/chat/chat-event-handler";
import { applySkipMarks } from "../../../shared/chat/chat-question-card";
import { CHAIN_DIVIDER_KIND } from "../../../shared/chat/chat-classifiers";
import { mergeSubCards } from "../../../shared/chat/subchat-cards";
import { sessionEvents } from "../../../shared/chat/event-store";
import { MCP_WRITE_PLAN_TOOL } from "../../../shared/chat/tool-meta";
import { invoke } from "../../../shared/ipc";
import { joinHistoryPrefix, type DashboardRows, type HistoryPrefix } from "../../../shared/chat/dashboard/history-prefix";

/** Predecessors (a `/respawn` chain) followed above the loaded page, the same
 *  bound the transcript's own older-page walk uses. */
const MAX_HOPS = 8;
/** Events replayed between yields, so a long digest never holds the window. */
const CHUNK = 256;
const SILENT = { silent: true, skipScroll: true } as const;
/** Tries after a failed digest read, each waiting RETRY_MS longer than the last. */
const MAX_RETRIES = 3;
const RETRY_MS = 3000;

interface DigestReply {
  events: ChatEvent[];
  continues_from?: string | null;
}

type Cursor = NonNullable<ReturnType<typeof sessionEvents.pageCursor>>;

interface Built {
  /** The chat it was built for: a pane renderer moved to another chat must
   *  never show this one's rows. */
  sid: string;
  /** The undrawn renderer: its first `rows` rows are the prefix. */
  shadow: ChatRenderer;
  rows: number;
  /** The tool_use ids of the write_plan calls above the page. */
  planIds: Set<string>;
  stopLive: () => void;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The row the transcript's older-page walk puts under a predecessor's events. */
function chainDivider(predecessorId: string): ChatEvent {
  return { type: "notification", kind: CHAIN_DIVIDER_KIND, body: predecessorId };
}

/** A predecessor's events carry where they came from, as the older-page walk
 *  tags them, so "Load full output" on one reads that transcript. */
function tagOrigin(events: ChatEvent[], from: string, sessionId: string): ChatEvent[] {
  if (from !== sessionId) for (const ev of events) (ev as { originSessionId?: string }).originSessionId = from;
  return events;
}

function cursorKey(sessionId: string, c: Cursor | null): string {
  return c ? `${sessionId}|${c.pageSessionId}|${c.oldestSeq}|${c.pageHasMore}|${c.chainNextId}` : `${sessionId}|none`;
}

export class HistoryPrefixSource {
  /** What the built prefix (or the build in flight) was made for. */
  private key: string | null = null;
  private built: Built | null = null;
  /** The current build's number (dispose takes one too): a build holding an
   *  older number stops at its next await. */
  private gen = 0;
  /** Failed digest reads since the last built prefix. */
  private retries = 0;

  constructor(private readonly renderer: ChatRenderer, private readonly changed: () => void) {}

  /** The rows and plans the dashboard derives from: the prefix once it is
   *  built, then the transcript renderer's own. Starts a build when the loaded
   *  page moved. */
  rows(): DashboardRows {
    const loaded: DashboardRows = { messages: this.renderer.messages, plans: this.renderer.dashPlans };
    this.sync();
    return joinHistoryPrefix(this.prefix(), loaded);
  }

  dispose(): void {
    this.gen++;
    this.key = null;
    this.drop();
  }

  private prefix(): HistoryPrefix | null {
    const b = this.built;
    if (!b || b.sid !== this.renderer.sessionId || this.renderer.hydrating) return null;
    const plans = b.shadow.dashPlans.filter((p) => b.planIds.has(p.id));
    // The loaded page's first plan was folded into the last plan from above the
    // page when the undrawn replay made no plan of its own for that call.
    const first = this.renderer.dashPlans[0];
    const continued = plans.length > 0 && !!first && !b.shadow.dashPlans.some((p) => p.id === first.id);
    return { messages: b.shadow.messages.slice(0, b.rows), plans, continued };
  }

  private drop(): void {
    const b = this.built;
    this.built = null;
    if (!b) return;
    b.stopLive();
    b.shadow.detach();
  }

  private sync(): void {
    const sid = this.renderer.sessionId;
    // A replay in progress holds half the page; its last flush syncs again.
    if (!sid || this.renderer.hydrating) return;
    const cursor = sessionEvents.hasMore(sid) ? sessionEvents.pageCursor(sid) : null;
    // Late Skip marks and stored sub cards no loaded row placed both land in
    // the prefix, so either changing means a rebuild.
    const unplaced = this.renderer.subCardPool.filter((c) => !this.renderer.subCardsPlaced.has(c.id)).length;
    const key = `${cursorKey(sid, cursor)}|${this.renderer.paginator.skipMarks.length}|${unplaced}`;
    if (key === this.key) return;
    this.key = key;
    const gen = ++this.gen;
    // Rows from the old prefix would overlap a page that grew upward.
    if (this.built) {
      this.drop();
      this.changed();
    }
    if (cursor) void this.build(sid, cursor, gen);
  }

  private async digest(sessionId: string, beforeSeq: number | null): Promise<DigestReply> {
    const args: Record<string, unknown> = { sessionId };
    const cwd = this.renderer.paginator.cwdHint;
    if (cwd) args.cwd = cwd;
    if (beforeSeq !== null) args.beforeSeq = beforeSeq;
    return invoke<DigestReply>("load_dashboard_digest", args);
  }

  private async feed(shadow: ChatRenderer, events: readonly ChatEvent[], gen: number): Promise<boolean> {
    for (let i = 0; i < events.length; i += CHUNK) {
      if (gen !== this.gen) return false;
      for (let j = i; j < Math.min(i + CHUNK, events.length); j++) handleChatEvent(shadow, events[j]!, SILENT);
      if (i + CHUNK < events.length) await yieldToMain();
    }
    return gen === this.gen;
  }

  private async build(sid: string, cursor: Cursor, gen: number): Promise<void> {
    const parts: ChatEvent[][] = [];
    try {
      let next: string | null = cursor.chainNextId;
      if (cursor.pageHasMore && cursor.oldestSeq !== null) {
        const d = await this.digest(cursor.pageSessionId, cursor.oldestSeq);
        parts.unshift(tagOrigin(d.events, cursor.pageSessionId, sid));
        next = d.continues_from ?? null;
      }
      for (let hops = 0; next && hops < MAX_HOPS && gen === this.gen; hops++) {
        const d = await this.digest(next, null);
        if (d.events.length > 0) parts.unshift([...tagOrigin(d.events, next, sid), chainDivider(next)]);
        next = d.continues_from ?? null;
      }
    } catch {
      // No digest (a paired machine's chat, a transcript gone): the zones keep
      // reading the loaded page, as they always did. A daemon not up yet or a
      // transcript mid-write can pass, so a few later tries follow.
      if (gen === this.gen && this.retries < MAX_RETRIES) {
        this.retries++;
        setTimeout(() => {
          if (gen !== this.gen) return;
          this.key = null;
          this.changed();
        }, RETRY_MS * this.retries);
      }
      return;
    }
    // The page grew upward while the digest loaded: the next sync builds again.
    if (gen !== this.gen || cursorKey(sid, sessionEvents.pageCursor(sid)) !== cursorKey(sid, cursor)) return;
    const above = mergeSubCards(parts.flat(), this.renderer.subCardPool, new Set(this.renderer.subCardsPlaced), false);
    const planIds = new Set<string>();
    for (const ev of above) if (ev.type === "tool_use" && ev.tool_name === MCP_WRITE_PLAN_TOOL) planIds.add(ev.id);
    // The renderer's own class, not an import: chat-renderer pulls in the whole
    // transcript, which already depends on this view.
    const Renderer = this.renderer.constructor as new (el: HTMLElement) => ChatRenderer;
    const shadow = new Renderer(document.createElement("div"));
    shadow.hydrating = true;
    // Live events that arrive while the loaded page replays wait their turn.
    const waiting: ChatEvent[] = [];
    let live = false;
    const loaded = sessionEvents.events(sid);
    const stopLive = sessionEvents.subscribe(sid, (ev) => {
      if (!live) {
        waiting.push(ev);
        return;
      }
      handleChatEvent(shadow, ev, SILENT);
      this.changed();
    });
    let installed = false;
    try {
      if (!(await this.feed(shadow, above, gen))) return;
      const rows = shadow.messages.length;
      if (!(await this.feed(shadow, loaded, gen))) return;
      for (const ev of waiting) handleChatEvent(shadow, ev, SILENT);
      live = true;
      applySkipMarks(shadow, this.renderer.paginator.skipMarks);
      this.drop();
      this.built = { sid, shadow, rows, planIds, stopLive };
      this.retries = 0;
      installed = true;
      this.changed();
    } finally {
      // Superseded, or a replay that threw: nothing may keep listening.
      if (!installed) {
        stopLive();
        shadow.detach();
      }
    }
  }
}
