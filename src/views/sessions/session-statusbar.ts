import { invoke } from "../../shared/ipc";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { type ChipType, type StaticChipType, isToolChip, STATIC_CHIPS } from "./statusline-catalog";
import { getChatRendererSnapshot } from "../../shared/chat/chat-renderer-bridge";
import { sessionEvents } from "../../shared/chat/event-store";
import { isPendingSessionId } from "../../shared/chat/pending-session-id";
import {
  formatDuration,
  gitInfoCache,
  metaCache,
  countsCache,
  ctxStatusCache,
  drainCache,
  type SessionCounts,
  type StatusbarOptions,
} from "./session-statusbar-helpers";
import { renderChip as renderChipHtml, type ChipRenderCtx } from "./statusbar-chips";
import {
  refreshCounts as fetchCounts,
  refreshContextStatus as fetchContextStatus,
  refreshGitInfo as fetchGitInfoData,
  refreshDirty as fetchDirty,
  resolveLiveCwd,
  startServersPoll as startServersPollData,
} from "./statusbar-data";
import { DrainPopover } from "./drain-popover";
import { AiTodosPopover } from "./ai-todos-popover";
import { ServersPopover } from "./servers-popover";
import { ImagesPopover } from "./images-popover";
import { EffortPopover } from "./effort-popover";
import { ModelPopover } from "./model-popover";
import { BranchPopover, type BranchEntry } from "./branch-popover";
import { CommitsPopover, type CommitSync } from "./commits-popover";
import { loadStatuslineRows as loadRowsForActiveProfile } from "./session-statusbar-helpers";
import { onMobileViewportChange } from "../../shared/mobile-viewport";
export {
  loadStatuslineRows,
  saveStatuslineRows,
  loadStatuslineHideZero,
  saveStatuslineHideZero,
  migrateLegacyFields,
  shortModelName,
  formatDuration,
  fetchGitInfo,
  type StatusbarOptions,
} from "./session-statusbar-helpers";

const EMPTY_META: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };

// Chip HTML builders live in statusbar-chips.ts (todo 748): a per-render
// ChipRenderCtx snapshot plus callback params replace the `this` reads that
// blocked the earlier ai_todo 98 attempt.
export class SessionStatusbar {
  private container: HTMLElement;
  private rows: ChipType[][];
  private meta: SessionMeta = EMPTY_META;
  private gitInfo: GitInfo = { branch: null, repo: null, ahead: null, behind: null, sha: null, insertions: null, deletions: null };
  private gitInfoLoaded = false;
  private metaLoaded = false;
  private counts: SessionCounts | null = null;
  private countsLoaded = false;
  // Daemon-computed context occupancy is the SOLE source of truth for the
  // context chip (ai_todo 31 - the frontend no longer duplicates the
  // window-size heuristic as a fallback; see renderContext). null = not yet
  // fetched or unavailable.
  private ctxStatus: ContextStatus | null = null;
  // Uncommitted-file count for the `dirty` chip (via get_git_dirty IPC, cwd-based).
  private dirtyCount: number | null = null;
  private dirtyLoaded = false;
  private startedAt: string | null;
  private cwd: string | null;
  // Live working dir the git-section chips resolve against. Starts at the spawn
  // `cwd`, then follows the AI into a worktree via `session_live_cwd` (last cwd
  // recorded in the transcript). Kept separate from `cwd` so session-scoped
  // chips (ai_todos, servers) stay pinned to the spawn dir.
  private gitCwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  private onEffortChange: ((effort: string) => void) | null;
  private onModelChange: ((model: string) => void) | null;
  private accountId: string | null;
  private onAccountClick: (() => void) | null;
  // Global hide-at-zero: when true, count/tool chips resolving to 0 are omitted.
  private hideZero: boolean;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private animatedKeys = new Set<string>();
  private toolTally: ToolTally = { byType: [] };
  // Per-tool chips delegate their drill-down popover to this controller.
  private tally: ToolTallyRow;

  // Popover subsystems (each owns its own state, DOM, and event wiring).
  private drainPopover = new DrainPopover();
  private aiTodosPopover = new AiTodosPopover();
  private serversPopover = new ServersPopover();
  // Polls the server_supervisor for this project's running dev servers.
  private serversTimer: ReturnType<typeof setInterval> | null = null;
  private imagesPopover = new ImagesPopover();
  private effortPopover = new EffortPopover();
  private modelPopover = new ModelPopover();
  private branchPopover = new BranchPopover();
  private commitsPopover = new CommitsPopover();
  private mobileUnsub: (() => void) | null = null;

  constructor(container: HTMLElement, startedAt: string | null, rows: ChipType[][], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.rows = rows;
    this.cwd = opts.cwd ?? null;
    this.gitCwd = this.cwd;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.sessionModel = opts.sessionModel ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.onEffortChange = opts.onEffortChange ?? null;
    this.onModelChange = opts.onModelChange ?? null;
    this.accountId = opts.accountId ?? null;
    this.onAccountClick = opts.onAccountClick ?? null;
    this.hideZero = opts.hideZero ?? true;
    this.container.className = "session-statusbar";
    this.tally = new ToolTallyRow(this.container);
    // Opening a tool-chip popover dismisses the statusbar-owned popovers, so at
    // most one popover is ever open.
    this.tally.setBeforeOpen(() => this.closeChipPopovers());
    this.mobileUnsub = onMobileViewportChange(() => void this.reloadRowsForViewport());

    if (this.gitCwd) {
      const cached = gitInfoCache.get(this.gitCwd);
      if (cached) { this.gitInfo = cached; this.gitInfoLoaded = true; }
    } else {
      this.gitInfoLoaded = true;
    }
    if (this.sessionId) {
      const cached = metaCache.get(this.sessionId);
      if (cached) { this.meta = cached; this.metaLoaded = true; }
      const cachedCounts = countsCache.get(this.sessionId);
      if (cachedCounts) { this.counts = cachedCounts; this.countsLoaded = true; }
      const cachedCtx = ctxStatusCache.get(this.sessionId);
      if (cachedCtx) this.ctxStatus = cachedCtx;
      const cachedDrain = drainCache.get(this.sessionId);
      if (cachedDrain) this.drainPopover.drain = cachedDrain;
    }

    this.render();
    if (this.wantsTimer()) this.startTimer();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    // Resolve the live git cwd (may follow the AI into a worktree), then fetch
    // git info + dirty against it. Owns all git fetching for live sessions.
    if (this.wantsGit()) void this.resolveGitCwd();
    if (this.hasChip("ai_todos") && this.cwd) void this.aiTodosPopover.refresh(this.cwd, () => this.render());
    if (this.wantsDrain()) void this.refreshDrain();
    if (this.hasChip("servers") && this.cwd) this.startServersPoll();
  }

  /** Servers are external processes with no event stream, so poll on a light
   *  interval; the popover only re-renders the bar when the list changes. */
  private startServersPoll(): void {
    const cwd = this.cwd;
    if (!cwd) return;
    this.serversTimer = startServersPollData(() => void this.serversPopover.refresh(cwd, () => this.render()));
  }

  private hasChip(type: string): boolean {
    return this.rows.some((r) => r.includes(type as ChipType));
  }
  private wantsCounts(): boolean { return this.hasChip("messages") || this.hasChip("turns"); }
  private wantsContext(): boolean { return this.hasChip("context_pct") || this.hasChip("context_tokens"); }
  private wantsTimer(): boolean { return this.hasChip("duration") || this.hasChip("clock"); }
  private wantsDrain(): boolean { return this.hasChip("drain"); }
  /** True when any git-section chip is present, so it's worth resolving the
   *  live git cwd and fetching git info. */
  private wantsGit(): boolean {
    return this.rows.some((r) =>
      r.some((c) => !isToolChip(c) && STATIC_CHIPS[c as StaticChipType]?.section === "git"),
    );
  }

  /** Resolve the session's live working dir (the AI may have moved into a
   *  worktree) and refresh git info + dirty against it. Falls back to the spawn
   *  cwd when the live lookup is unavailable. */
  private async resolveGitCwd(): Promise<void> {
    const spawn = this.cwd;
    if (!spawn) return;
    const effective = this.sessionId ? await resolveLiveCwd(this.sessionId, spawn) : spawn;
    const changed = effective !== this.gitCwd;
    this.gitCwd = effective;
    // Seed instantly from cache for the new dir (a revisit paints without flicker).
    if (changed) {
      const cached = gitInfoCache.get(effective);
      if (cached) { this.gitInfo = cached; this.gitInfoLoaded = true; this.render(); }
    }
    await this.refreshGitInfo();
    if (this.hasChip("dirty")) await this.refreshDirty();
    // Folder chip renders from gitCwd; repaint if it moved off the spawn dir.
    if (changed) this.render();
  }

  private async refreshCounts(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    await fetchCounts({
      sessionId: sid,
      isCurrent: () => this.sessionId === sid,
      onClear: () => { this.counts = null; this.countsLoaded = false; this.render(); },
      onUpdate: (counts) => { this.counts = counts; this.countsLoaded = true; this.render(); },
    });
  }

  private async refreshContextStatus(allowRetry = true): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    await fetchContextStatus({
      sessionId: sid,
      isCurrent: () => this.sessionId === sid,
      hadUsage: this.meta.hasUsage,
      hasCtxStatus: () => !!this.ctxStatus,
      allowRetry,
      onResult: (r) => { this.ctxStatus = r; this.render(); },
      scheduleRetry: (fn) => setTimeout(fn, 1500),
    });
  }

  private async refreshGitInfo(): Promise<void> {
    const cwd = this.gitCwd;
    if (!cwd) return;
    await fetchGitInfoData({
      cwd,
      isCurrent: () => this.gitCwd === cwd,
      onSuccess: (info) => this.updateGitInfo(info),
      onUnavailable: () => { this.gitInfoLoaded = true; this.render(); },
    });
  }

  private async refreshDirty(): Promise<void> {
    const cwd = this.gitCwd;
    if (!cwd) return;
    await fetchDirty({
      cwd,
      isCurrent: () => this.gitCwd === cwd,
      onSuccess: (count) => { this.dirtyCount = count; this.dirtyLoaded = true; this.render(); },
      onUnavailable: () => { this.dirtyLoaded = true; this.render(); },
    });
  }

  private async refreshDrain(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    await this.drainPopover.refresh(sid, () => this.render(), () => {
      const anchor = this.container.querySelector<HTMLElement>(".sb-drain-btn");
      if (anchor) this.drainPopover.open(anchor);
    });
  }

  updateMeta(meta: SessionMeta): void {
    const turnJustCompleted = !this.meta.hasUsage && meta.hasUsage;
    this.meta = meta;
    this.metaLoaded = true;
    if (this.sessionId) metaCache.set(this.sessionId, meta);
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.wantsDrain()) void this.refreshDrain();
    // Re-resolve the live cwd too: the completed turn may have moved the AI
    // into (or out of) a worktree.
    if (turnJustCompleted && this.cwd) {
      if (this.wantsGit()) void this.resolveGitCwd();
      else void this.refreshGitInfo();
    }
  }

  updateGitInfo(info: GitInfo): void {
    this.gitInfo = info;
    this.gitInfoLoaded = true;
    if (this.gitCwd) gitInfoCache.set(this.gitCwd, info);
    this.render();
    if (this.hasChip("dirty")) void this.refreshDirty();
  }

  updateToolTally(t: ToolTally): void {
    this.toolTally = t;
    this.render();
    this.tally.update(t);
  }

  /** Wire the shared custom-view provider (the chat renderer's message-derived
   *  HTML) so the tool-chip popovers reuse the in-chat Read/File-Changes/Skills/
   *  Questions views. Forwarded to the ToolTallyRow controller. */
  setToolViewProvider(fn: (tool: string) => string | null): void {
    this.tally.setCustomViewProvider(fn);
  }

  /** True when `cwd` still matches the live git cwd (may have moved via
   *  resolveGitCwd since a caller's own fetch for `cwd` started). */
  isCurrentCwd(cwd: string): boolean {
    return this.gitCwd === cwd;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
    this.counts = null;
    this.countsLoaded = false;
    this.ctxStatus = null;
    this.drainPopover.drain = null;
    this.drainPopover.close();
    const cached = countsCache.get(id);
    if (cached) { this.counts = cached; this.countsLoaded = true; }
    const cachedCtx = ctxStatusCache.get(id);
    if (cachedCtx) this.ctxStatus = cachedCtx;
    const cachedDrain = drainCache.get(id);
    if (cachedDrain) this.drainPopover.drain = cachedDrain;
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.wantsDrain()) void this.refreshDrain();
    // Fallback for fast turns that complete before the JS event-store listener
    // is set up (the live turn_usage event is dropped). Re-check after 3 s; by
    // then any fast turn is done and the JSONL is definitely flushed.
    if (this.wantsContext() && id && !isPendingSessionId(id)) {
      setTimeout(() => {
        if (this.sessionId === id && !this.ctxStatus) void this.refreshContextStatus();
      }, 3000);
    }
  }

  /** Repaint the account chip after an in-place account switch. That switch
   *  keeps the session id, so nothing remounts the statusbar for us and the
   *  chip would otherwise keep naming the account the chat just left. */
  setAccountId(id: string | null): void {
    if (this.accountId === id) return;
    this.accountId = id;
    this.render();
  }

  setReadOnlyEffort(readOnly: boolean): void {
    if (this.readOnlyEffort === readOnly) return;
    this.readOnlyEffort = readOnly;
    this.render();
  }

  /** Switches the model chip from draft-local editing to live editing once the
   *  real agent process has spawned (a draft's onModelChange must not survive
   *  into the started session, or picking a model would only update local
   *  state instead of calling set_session_model). */
  disableModelEdit(): void {
    if (!this.onModelChange) return;
    this.onModelChange = null;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    if (this.serversTimer) { clearInterval(this.serversTimer); this.serversTimer = null; }
    if (this.mobileUnsub) { this.mobileUnsub(); this.mobileUnsub = null; }
    this.tally.destroy();
    this.closeChipPopovers();
  }

  /** Desktop and phone hold independent layouts, so crossing the breakpoint
   *  swaps which one is live - a narrowed desktop window counts as a phone. */
  private async reloadRowsForViewport(): Promise<void> {
    this.rows = await loadRowsForActiveProfile();
    this.render();
  }

  private tickTimer(): void {
    if (this.startedAt) {
      const el = this.container.querySelector<HTMLElement>(".sb-duration .sb-duration-text");
      if (el) el.textContent = formatDuration(this.startedAt);
    }
    const clock = this.container.querySelector<HTMLElement>(".sb-clock .sb-clock-text");
    if (clock) clock.textContent = this.clockText();
  }

  private startTimer(): void {
    this.durationTimer = setInterval(() => this.tickTimer(), 1000);
  }

  private clockText(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** Assemble the read-only snapshot + callback params statusbar-chips.ts's
   *  pure renderChip needs, once per render() rather than per chip. */
  private chipRenderCtx(): ChipRenderCtx {
    return {
      meta: this.meta,
      metaLoaded: this.metaLoaded,
      sessionModel: this.sessionModel,
      effort: this.effort,
      readOnlyEffort: this.readOnlyEffort,
      accountId: this.accountId,
      hasAccountClick: !!this.onAccountClick,
      gitInfo: this.gitInfo,
      gitInfoLoaded: this.gitInfoLoaded,
      gitCwd: this.gitCwd,
      counts: this.counts,
      countsLoaded: this.countsLoaded,
      ctxStatus: this.ctxStatus,
      dirtyCount: this.dirtyCount,
      dirtyLoaded: this.dirtyLoaded,
      startedAt: this.startedAt,
      toolTally: this.toolTally,
      hideZero: this.hideZero,
      cwd: this.cwd,
      animatedKeys: this.animatedKeys,
      renderToolChip: (tool, count, hideZero) => this.tally.renderChipFor(tool, count, hideZero),
      renderAiTodosChip: (cwd, animClass) => this.aiTodosPopover.renderChip(cwd, animClass),
      renderDrainChip: (animClass) => this.drainPopover.renderChip(animClass),
      renderServersChip: (cwd, animClass) => this.serversPopover.renderChip(cwd, animClass),
      renderImagesChip: (animClass) => this.imagesPopover.renderChip(animClass),
    };
  }

  private renderChip(type: ChipType, ctx: ChipRenderCtx): string {
    return renderChipHtml(type, ctx);
  }

  /** Recomputed each render from the live renderer's messages/messageEls (a
   *  single linear pass, same cost class as the other per-render chip data) so
   *  the images chip stays in sync with mid-turn attachment/screenshot arrivals
   *  without a dedicated refresh trigger. */
  private refreshImages(): void {
    if (!this.hasChip("images")) return;
    const snapshot = getChatRendererSnapshot();
    if (!snapshot) return;
    const hasMore = snapshot.sessionId ? sessionEvents.hasMore(snapshot.sessionId) : false;
    this.imagesPopover.refresh(snapshot.messages, snapshot.messageEls, hasMore, snapshot.sessionId, snapshot.cwd);
  }

  private render(): void {
    this.refreshImages();
    // .sb-row is overflow-x: auto; innerHTML rebuild below destroys the nodes
    // and resets scrollLeft, so snapshot by row index and restore after.
    const scrollLefts = Array.from(this.container.querySelectorAll<HTMLElement>(".sb-row"), (r) => r.scrollLeft);
    const ctx = this.chipRenderCtx();
    const rowsHtml = this.rows.map((row) => {
      const chips = row.map((t) => this.renderChip(t, ctx)).filter(Boolean).join("");
      return chips ? `<div class="sb-row">${chips}</div>` : "";
    }).filter(Boolean).join("");

    this.container.innerHTML = `
      <div class="sb-rows">${rowsHtml || '<span class="sb-empty">No chips</span>'}</div>
    `;

    this.container.querySelectorAll<HTMLElement>(".sb-row").forEach((row, i) => {
      if (scrollLefts[i]) row.scrollLeft = scrollLefts[i];
    });

    this.container.querySelector<HTMLElement>(".sb-folder-btn")?.addEventListener("click", () => {
      if (this.gitCwd) void invoke<void>("open_in_explorer", { path: this.gitCwd });
    });

    this.container.querySelector<HTMLElement>(".sb-account-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onAccountClick?.();
    });

    this.tally.wireChips();

    this.container.querySelector<HTMLElement>(".sb-model-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.modelPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.modelPopover.open(anchor, {
        model: this.sessionModel ?? this.meta.model ?? "",
        sessionId: this.sessionId,
        onModelChange: this.onModelChange ?? undefined,
        onCommit: (next) => {
          this.sessionModel = next;
          this.modelPopover.close();
          this.render();
        },
      });
    });

    this.container.querySelector<HTMLElement>(".sb-effort-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.readOnlyEffort) return;
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.effortPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.effortPopover.open(anchor, {
        effort: this.effort,
        sessionId: this.sessionId,
        onEffortChange: this.onEffortChange,
        onCommit: (next) => { this.effort = next; this.effortPopover.close(); this.render(); },
      });
    });

    this.container.querySelector<HTMLElement>(".sb-ai-todos-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.aiTodosPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.aiTodosPopover.open(anchor);
    });

    this.container.querySelector<HTMLElement>(".sb-drain-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.drainPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.drainPopover.open(anchor);
    });

    this.container.querySelector<HTMLElement>(".sb-servers-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.serversPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.serversPopover.open(anchor);
    });

    this.container.querySelector<HTMLElement>(".sb-images-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.imagesPopover.isOpen;
      this.closeChipPopovers();
      if (!wasOpen) this.imagesPopover.open(anchor);
    });

    this.container.querySelector<HTMLElement>(".sb-branch-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.branchPopover.isOpen;
      this.closeChipPopovers();
      if (wasOpen || !this.gitCwd) return;
      try {
        const branches = await invoke<BranchEntry[]>("get_recent_branches", { cwd: this.gitCwd });
        this.branchPopover.open(anchor, branches);
      } catch (err) {
        console.error("[session-statusbar] get_recent_branches failed", err);
      }
    });

    this.container.querySelector<HTMLElement>(".sb-commits-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = this.commitsPopover.isOpen;
      this.closeChipPopovers();
      if (wasOpen || !this.gitCwd) return;
      const cwd = this.gitCwd;
      try {
        const sync = await invoke<CommitSync>("get_commit_sync", { cwd });
        // A session switch mid-flight rewrites the pane (anchor detaches) and
        // may leave this.gitCwd unchanged, so both checks are needed - mirrors
        // refreshGitInfo's cwd guard plus a liveness check on the DOM node.
        if (this.gitCwd !== cwd || !anchor.isConnected) return;
        this.commitsPopover.open(anchor, cwd, sync, this.gitInfo.branch, () => void this.refreshGitInfo());
      } catch (err) {
        console.error("[session-statusbar] get_commit_sync failed", err);
      }
    });

    // All popovers are body-appended and survive re-renders, but their anchor
    // chip was just replaced. Re-anchor if open so a background refresh doesn't
    // leave one bound to a detached node. Content that streams (drain, ai_todos)
    // rebuilds in place; static content just repositions.
    this.reanchorIfOpen(this.drainPopover, ".sb-drain-btn", (a) => this.drainPopover.open(a));
    this.reanchorIfOpen(this.aiTodosPopover, ".sb-ai-todos-btn", (a) => this.aiTodosPopover.open(a));
    this.reanchorIfOpen(this.serversPopover, ".sb-servers-btn", (a) => this.serversPopover.open(a));
    this.reanchorIfOpen(this.imagesPopover, ".sb-images-btn", (a) => this.imagesPopover.open(a));
    this.reanchorIfOpen(this.branchPopover, ".sb-branch-btn", (a) => this.branchPopover.reanchor(a));
    this.reanchorIfOpen(this.commitsPopover, ".sb-commits-btn", (a) => this.commitsPopover.reanchor(a));
    this.reanchorIfOpen(this.effortPopover, ".sb-effort-btn", (a) => this.effortPopover.reanchor(a));
    this.reanchorIfOpen(this.modelPopover, ".sb-model-btn", (a) => this.modelPopover.reanchor(a));

    this.updateRowFades();
  }

  /** Toggle scroll-edge fade classes per row (rows rebuild on every render(),
   *  so listeners are re-wired each time). sb-row-scroll gates the CSS fade on
   *  actual overflow; at-start/at-end suppress it at the ends of the scroll. */
  private updateRowFades(): void {
    this.container.querySelectorAll<HTMLElement>(".sb-row").forEach((row) => {
      const sync = () => {
        row.classList.toggle("sb-row-scroll", row.scrollWidth > row.clientWidth + 1);
        row.classList.toggle("sb-row-at-start", row.scrollLeft <= 1);
        row.classList.toggle("sb-row-at-end", row.scrollLeft >= row.scrollWidth - row.clientWidth - 1);
      };
      sync();
      row.addEventListener("scroll", sync, { passive: true });
    });
  }

  /** Re-anchor an open popover to its freshly-rendered chip, or close it if the
   *  chip vanished. */
  private reanchorIfOpen(pop: { isOpen: boolean; close: () => void }, sel: string, rebind: (anchor: HTMLElement) => void): void {
    if (!pop.isOpen) return;
    const anchor = this.container.querySelector<HTMLElement>(sel);
    if (anchor) rebind(anchor);
    else pop.close();
  }

  /** Dismiss every chip popover (both statusbar-owned and the tool-tally one). */
  private closeChipPopovers(): void {
    this.drainPopover.close();
    this.aiTodosPopover.close();
    this.serversPopover.close();
    this.imagesPopover.close();
    this.effortPopover.close();
    this.modelPopover.close();
    this.branchPopover.close();
    this.commitsPopover.close();
    this.tally.closePopover();
  }
}
