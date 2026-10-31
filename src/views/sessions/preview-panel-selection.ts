// Which preview page the Preview tab shows, and why: the list for the active
// chat, the page in view (latest or an archived version), the fetched-page
// cache, and the "newer page pushed" dots. PreviewTab keeps only the DOM, RPC
// wiring and menus and is told what changed through `SelectionView`.
//
// Live updates arrive two ways, per `project_daemon_notifier_broadcast_lossy`:
// a `preview` broadcast (fast, droppable under backpressure) AND an explicit
// `list_previews` refetch on open/focus (authoritative, never skipped).

import { invoke } from "../../shared/ipc";
import type { PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";
import { PREVIEW_SOURCE_CHAT_CARD } from "../../shared/chat/chat-preview-card";
import { versionsOf } from "./preview-panel-history";
import type { RailTabDeps } from "./rail-panel";

/** What the selection asks the tab to draw. */
export interface SelectionView {
  /** The header (names, version label, dots) from the current selection. */
  renderHeader(): void;
  /** The iframe for the current selection. */
  renderPage(): void;
  /** Header and canvas for "no preview in view". */
  renderEmpty(): void;
}

export class PreviewSelection {
  snapshots: PreviewMeta[] = [];
  selected: PreviewSnapshot | null = null;
  /** The archived version in view, or null while the latest page is. */
  selectedVersion: number | null = null;
  /** Previews that got a push while another one, or an older version of the
   *  same one, was in view: the push never moves the view (see onLivePush), so
   *  the pickers carry a dot until the pushed page is opened. */
  readonly unseenIds = new Set<string>();
  /** Only previews pushed with this session_id are shown. Set by
   *  state.ts's setActiveSession on every chat switch; null before any
   *  chat is selected. */
  sessionId: string | null = null;
  /** Full-html snapshots already fetched this session, keyed by id and version
   *  (`cacheKey`), so revisiting a chat (or a window-focus refetch) never
   *  re-invokes get_preview or rebuilds the iframe for content already seen.
   *  Pruned in refreshList to the ids and versions the daemon's list still
   *  reports, so it can never outgrow the daemon-side caps. */
  private snapshotCache = new Map<string, PreviewSnapshot>();
  /** Ids already shown (or baselined) this window session - see
   *  `checkForUnseen`'s doc for why this exists. In-memory only, same
   *  don't-resurface-what-was-already-surfaced shape as main.ts's
   *  `seenMissedIds`. */
  private seenIds = new Set<string>();

  constructor(private deps: RailTabDeps, private view: SelectionView) {}

  /** Points the selection at another chat. The caller then refreshes, or
   *  `clear`s when the tab is not on screen. */
  switchTo(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.unseenIds.clear();
  }

  /** Drops the stale cross-chat state so a later open() never flashes the
   *  previous chat's snapshots before the fresh fetch lands. */
  clear(): void {
    this.snapshots = [];
    this.selected = null;
    this.selectedVersion = null;
  }

  /** Authoritative fallback for the lossy `preview` broadcast (see module
   *  docs): a dropped packet must never swallow a push for the active chat.
   *  Runs on window focus while closed, and with `allowOpen: false` on every
   *  scope change purely to baseline `seenIds` against pre-existing history. */
  async checkForUnseen(opts: { allowOpen: boolean } = { allowOpen: true }): Promise<void> {
    if (!this.sessionId) return;
    let all: PreviewMeta[];
    try {
      all = await invoke<PreviewMeta[]>("list_previews", { sessionId: this.sessionId });
    } catch (err) {
      console.error("[preview-panel] checkForUnseen failed", err);
      return;
    }
    const scoped = (Array.isArray(all) ? all : []).filter((m) => m.session_id === this.sessionId);
    const unseen = scoped.filter((m) => !this.seenIds.has(m.id));
    scoped.forEach((m) => this.seenIds.add(m.id));
    // Same carve-out as onLivePush: a show_preview push is already on screen
    // as a card, so it must not force the rail open on the next focus either.
    const mostRecentUnseen = unseen.filter((m) => m.source !== PREVIEW_SOURCE_CHAT_CARD).pop();
    if (opts.allowOpen && mostRecentUnseen && !this.deps.isOpen()) {
      this.deps.requestOpen(mostRecentUnseen.id);
    }
  }

  async refreshList(opts: { selectId?: string } = {}): Promise<void> {
    try {
      // The session id routes the read: a chat mirrored from a paired machine
      // keeps its previews on that machine, and the daemon forwards there.
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId: this.sessionId });
      const all = Array.isArray(list) ? list : [];
      this.snapshots = all.filter((m) => m.session_id === this.sessionId);
      this.snapshots.forEach((s) => this.seenIds.add(s.id));
      // The list now covers only this chat, so only this chat's cached
      // snapshots can be judged gone; another chat's stay until it is revisited.
      const listed = new Map(all.map((m) => [m.id, m]));
      for (const [key, cached] of this.snapshotCache) {
        if (cached.session_id !== this.sessionId) continue;
        const meta = listed.get(cached.id);
        const archived = meta && versionsOf(meta).some((v) => v.version === cached.version);
        if (!meta || (cached.version !== meta.version && !archived)) this.snapshotCache.delete(key);
      }
    } catch (err) {
      console.error("[preview-panel] list_previews failed", err);
    }
    const first = this.snapshots[0];
    if (!first) {
      this.selected = null;
      this.selectedVersion = null;
      this.view.renderEmpty();
      return;
    }
    const targetId = opts.selectId ?? this.selected?.id ?? first.id;
    const target = this.snapshots.find((s) => s.id === targetId);
    // A refetch keeps an archived version in view while it is still kept; a
    // push naming a preview (selectId) always lands on that preview's latest.
    const keepVersion = !opts.selectId && target?.id === this.selected?.id && target && versionsOf(target).some((v) => v.version === this.selectedVersion);
    await this.selectSnapshot(target ? targetId : first.id, keepVersion ? this.selectedVersion : null);
  }

  private cacheKey(id: string, version: number | null): string {
    return `${id}@${version ?? "latest"}`;
  }

  /** Shows `id`'s page: its latest when `version` is null, otherwise that
   *  archived version. */
  async selectSnapshot(id: string, version: number | null = null): Promise<void> {
    const meta = this.snapshots.find((s) => s.id === id);
    // Already the exact page on screen: a window-focus refetch or a re-scope
    // back to a chat whose top snapshot hasn't changed. Skip the round-trip and
    // the iframe rebuild entirely so switching chats doesn't re-execute the
    // previewed HTML's scripts. An archived version never changes; the latest
    // is the same page only while its version number is.
    if (this.selected?.id === id && this.selectedVersion === version
      && (version !== null || !meta || meta.version === this.selected.version)) {
      // Only the latest page being open clears the dot: a refocus or a re-click
      // of the archived version already open never shows the newer push.
      if (version === null) this.unseenIds.delete(id);
      this.view.renderHeader();
      return;
    }
    const key = this.cacheKey(id, version);
    const cached = this.snapshotCache.get(key);
    let next: PreviewSnapshot;
    if (cached && (version !== null || (meta && cached.version === meta.version))) {
      next = cached;
    } else {
      try {
        next = await invoke<PreviewSnapshot>("get_preview", {
          id,
          sessionId: this.sessionId,
          ...(version !== null ? { version } : {}),
        });
      } catch (err) {
        console.error("[preview-panel] get_preview failed", err);
        // The archived version was dropped between listing and fetching.
        if (version !== null) await this.selectSnapshot(id, null);
        return;
      }
      this.snapshotCache.set(key, next);
    }
    this.selected = next;
    this.selectedVersion = version;
    if (version === null) this.unseenIds.delete(id);
    this.view.renderHeader();
    this.view.renderPage();
  }

  /** `preview` notifier broadcast handler. A push for the active chat opens the
   * panel while it is closed (Joe, 2026-07-20: no opt-out on auto-refresh),
   * EXCEPT a `show_preview` push, which already rendered as a card in the
   * transcript. Once open, the view only follows a push while it shows the
   * latest page of the preview being pushed (Joe, 2026-10-30): a push for
   * another preview, or while an older version is in view, leaves the view
   * alone and dots the picker that would reach it. A background chat's push
   * never switches the view (Joe, 2026-08-03). */
  onLivePush(meta: PreviewMeta | undefined): void {
    if (!meta) return;
    if (meta.session_id !== this.sessionId) {
      if (meta.session_id && meta.source !== PREVIEW_SOURCE_CHAT_CARD) this.deps.markOpenFor(meta.session_id);
      return;
    }
    this.seenIds.add(meta.id);

    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    const known = idx >= 0 ? this.snapshots[idx] : undefined;
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    // A publish re-broadcasts the same id + version with only `published`
    // changed: not a new page, so it neither moves the view nor earns a dot.
    if (known && known.version === meta.version) {
      if (this.selected?.id === meta.id && this.selectedVersion === null) this.selected.published = meta.published;
      return;
    }

    if (!this.deps.isOpen()) {
      if (meta.source !== PREVIEW_SOURCE_CHAT_CARD) this.deps.requestOpen(meta.id);
      return;
    }
    const following = !this.selected || (this.selected.id === meta.id && this.selectedVersion === null);
    if (following) {
      void this.selectSnapshot(meta.id);
      return;
    }
    this.unseenIds.add(meta.id);
    this.view.renderHeader();
  }
}
