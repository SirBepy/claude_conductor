import { invoke } from "../../shared/ipc";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { type ChipType } from "./statusline-catalog";
import { getChatRendererSnapshot } from "../../shared/chat/chat-renderer-bridge";
import { sessionEvents } from "../../shared/chat/event-store";
import { isPendingSessionId } from "../../shared/chat/pending-session-id";
import {
  tickTimer,
  updateRowFades,
  hasChip,
  wantsCounts,
  wantsContext,
  wantsTimer,
  wantsDrain,
  wantsGit,
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
import {
  closeChipPopovers as closeAllChipPopovers,
  wireChipPopovers,
  type StatusbarPopovers,
  type ChipPopoverWireCtx,
} from "./session-statusbar-popovers";
import { DrainPopover } from "./drain-popover";
import { AiTodosPopover } from "./ai-todos-popover";
import { ServersPopover } from "./servers-popover";
import { ImagesPopover } from "./images-popover";
import { EffortPopover } from "./effort-popover";
import { ModelPopover } from "./model-popover";
import { GitCard } from "./git-card";
import { OverflowPopover, type OverflowPanelData } from "./overflow-popover";
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
const EMPTY_GIT_INFO: GitInfo = { branch: null, repo: null, ahead: null, behind: null, sha: null, insertions: null, deletions: null };

// Chip HTML builders live in statusbar-chips.ts (todo 748): a per-render
// ChipRenderCtx snapshot plus callback params replace the `this` reads that
// blocked the earlier ai_todo 98 attempt.
export class SessionStatusbar {
  private container: HTMLElement;
  private rows: ChipType[][];
  private meta: SessionMeta = EMPTY_META;
  private gitInfo: GitInfo = EMPTY_GIT_INFO;
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
  // Live working dir the git DATA chips (branch/sha/commits) resolve against.
  // Starts at the spawn `cwd`, then follows the AI into a worktree via
  // `session_live_cwd` (last cwd recorded in the transcript). refreshGitInfo
  // may reassign this back to the spawn `cwd` when the live location has no
  // repo at all, so the git chip still has something to show (ab23f6b3) -
  // which makes it unfit as "where is the AI actually sitting" (todo 921).
  private gitCwd: string | null;
  // True live location, untouched by refreshGitInfo's off-repo fallback.
  // folder/repo chips and driftLabel's "away" segment read this one instead
  // of gitCwd, so an off-repo cwd stays visible even while gitCwd (and the
  // git chip's branch/sha data) fall back to the chat's own repo.
  private liveCwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  private onEffortChange: ((effort: string) => void) | null;
  private onModelChange: ((model: string) => void) | null;
  private accountId: string | null;
  private onAccountClick: (() => void) | null;
  private onConfig: ((model: string | null, effort: string, effortEditable: boolean) => void) | null;
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
  /** Whatever last opened the model/effort popover - a statusline chip, or the
   *  pane header's config text. Which one it was decides whether a re-render
   *  has to re-bind the anchor; see `reanchorConfigPopover`. */
  private modelAnchor: HTMLElement | null = null;
  private effortAnchor: HTMLElement | null = null;
  private gitCard = new GitCard();
  private overflowPopover = new OverflowPopover();
  private mobileUnsub: (() => void) | null = null;

  constructor(container: HTMLElement, startedAt: string | null, rows: ChipType[][], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.rows = rows;
    this.cwd = opts.cwd ?? null;
    this.gitCwd = this.cwd;
    this.liveCwd = this.cwd;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.sessionModel = opts.sessionModel ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.onEffortChange = opts.onEffortChange ?? null;
    this.onModelChange = opts.onModelChange ?? null;
    this.accountId = opts.accountId ?? null;
    this.onAccountClick = opts.onAccountClick ?? null;
    this.onConfig = opts.onConfig ?? null;
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
      const cachedMeta = metaCache.get(this.sessionId);
      if (cachedMeta) { this.meta = cachedMeta; this.metaLoaded = true; }
      this.seedSessionCaches(this.sessionId);
    }

    this.render();
    if (wantsTimer(this.rows)) this.startTimer();
    if (wantsCounts(this.rows)) void this.refreshCounts();
    if (wantsContext(this.rows)) void this.refreshContextStatus();
    // Resolve the live git cwd (may follow the AI into a worktree), then fetch
    // git info + dirty against it. Owns all git fetching for live sessions.
    if (wantsGit(this.rows)) void this.resolveGitCwd();
    if (hasChip(this.rows, "ai_todos") && this.cwd) void this.aiTodosPopover.refresh(this.cwd, () => this.render());
    if (wantsDrain(this.rows)) void this.refreshDrain();
    if (hasChip(this.rows, "servers") && this.cwd) this.startServersPoll();
  }

  /** Seed counts/ctxStatus/drain from cache for `id`. Meta is constructor-only
   *  (see the constructor's own cache block): setSessionId intentionally
   *  leaves it, since the session's own model/usage meta arrives via
   *  updateMeta as soon as the chat mounts, not from this cache. */
  private seedSessionCaches(id: string): void {
    const cachedCounts = countsCache.get(id);
    if (cachedCounts) { this.counts = cachedCounts; this.countsLoaded = true; }
    const cachedCtx = ctxStatusCache.get(id);
    if (cachedCtx) this.ctxStatus = cachedCtx;
    const cachedDrain = drainCache.get(id);
    if (cachedDrain) this.drainPopover.drain = cachedDrain;
  }

  /** Servers are external processes with no event stream, so poll on a light
   *  interval; the popover only re-renders the bar when the list changes. */
  private startServersPoll(): void {
    const cwd = this.cwd;
    if (!cwd) return;
    this.serversTimer = startServersPollData(() => void this.serversPopover.refresh(cwd, () => this.render()));
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
    this.liveCwd = effective;
    // Seed instantly from cache for the new dir (a revisit paints without flicker).
    if (changed) {
      const cached = gitInfoCache.get(effective);
      if (cached) { this.gitInfo = cached; this.gitInfoLoaded = true; this.render(); }
    }
    await this.refreshGitInfo();
    if (hasChip(this.rows, "dirty")) await this.refreshDirty();
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

  /** A live cwd outside any repo answers with a null branch, and renderGitChip
   *  prints NOTHING without one - so one `cd` into an install or temp dir takes
   *  the whole chip down, ahead count included. The chat's own repo beats an
   *  empty statusbar, so retry there once (bounded: cwd === this.cwd). */
  private async refreshGitInfo(): Promise<void> {
    const cwd = this.gitCwd;
    if (!cwd) return;
    let offRepo = false;
    await fetchGitInfoData({
      cwd,
      isCurrent: () => this.gitCwd === cwd,
      onSuccess: (info) => {
        // `info` is null from a transport that degrades an unwired command;
        // that is not an off-repo cwd and retrying elsewhere can't fix it.
        if (info && !info.branch && this.cwd && cwd !== this.cwd) { offRepo = true; return; }
        this.updateGitInfo(info);
      },
      onUnavailable: () => { this.gitInfoLoaded = true; this.render(); },
    });
    if (offRepo) {
      // Only gitCwd (the git-DATA source) falls back here - liveCwd stays at
      // the AI's true off-repo location so folder/repo/driftLabel don't lie
      // about where it actually is (todo 921).
      this.gitCwd = this.cwd;
      await this.refreshGitInfo();
    }
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
    if (wantsCounts(this.rows)) void this.refreshCounts();
    if (wantsContext(this.rows)) void this.refreshContextStatus();
    if (wantsDrain(this.rows)) void this.refreshDrain();
    // Re-resolve the live cwd too: the completed turn may have moved the AI
    // into (or out of) a worktree.
    if (turnJustCompleted && this.cwd) {
      if (wantsGit(this.rows)) void this.resolveGitCwd();
      else void this.refreshGitInfo();
    }
  }

  updateGitInfo(info: GitInfo): void {
    // A transport that silently degrades an unwired command answers null, and
    // one null here takes the whole bar's render down with it.
    this.gitInfo = info ?? EMPTY_GIT_INFO;
    this.gitInfoLoaded = true;
    if (this.gitCwd) gitInfoCache.set(this.gitCwd, info);
    this.render();
    if (hasChip(this.rows, "dirty")) void this.refreshDirty();
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
    this.seedSessionCaches(id);
    this.render();
    if (wantsCounts(this.rows)) void this.refreshCounts();
    if (wantsContext(this.rows)) void this.refreshContextStatus();
    if (wantsDrain(this.rows)) void this.refreshDrain();
    // Fallback for fast turns that complete before the JS event-store listener
    // is set up (the live turn_usage event is dropped). Re-check after 3 s; by
    // then any fast turn is done and the JSONL is definitely flushed.
    if (wantsContext(this.rows) && id && !isPendingSessionId(id)) {
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

  /** Open (or dismiss) the model slider on `anchor`. Public because the pane
   *  header prints model/effort too and routes its own clicks here, so both
   *  surfaces share one popover and one commit path. `anchor` may sit outside
   *  this statusbar's container. */
  toggleModelPopover(anchor: HTMLElement): void {
    const wasOpen = this.modelPopover.isOpen;
    this.closeChipPopovers();
    if (wasOpen) return;
    this.modelAnchor = anchor;
    this.modelPopover.open(anchor, {
      model: this.sessionModel ?? this.meta.model ?? "",
      sessionId: this.sessionId,
      onModelChange: this.onModelChange ?? undefined,
      onCommit: (next) => {
        this.sessionModel = next;
        this.modelPopover.close();
        this.render();
      },
    });
  }

  /** Effort's counterpart to `toggleModelPopover`. A read-only (external)
   *  session has no effort to set, so the click is swallowed here rather than
   *  in each caller. */
  toggleEffortPopover(anchor: HTMLElement): void {
    if (this.readOnlyEffort) return;
    const wasOpen = this.effortPopover.isOpen;
    this.closeChipPopovers();
    if (wasOpen) return;
    this.effortAnchor = anchor;
    this.effortPopover.open(anchor, {
      effort: this.effort,
      sessionId: this.sessionId,
      onEffortChange: this.onEffortChange,
      onCommit: (next) => { this.effort = next; this.effortPopover.close(); this.render(); },
    });
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

  private startTimer(): void {
    this.durationTimer = setInterval(() => tickTimer(this.container, this.startedAt), 1000);
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
      liveCwd: this.liveCwd,
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

  /** Snapshot for the overflow panel. Rebuilt per open (and per re-anchor) so a
   *  panel left open through a turn keeps counting up with the bar. */
  private overflowData(): OverflowPanelData {
    return {
      counts: this.counts,
      startedAt: this.startedAt,
      drain: this.drainPopover.drain,
      toolTally: this.toolTally,
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
    if (!hasChip(this.rows, "images")) return;
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
      if (this.liveCwd) void invoke<void>("open_in_explorer", { path: this.liveCwd });
    });

    this.container.querySelector<HTMLElement>(".sb-account-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onAccountClick?.();
    });

    this.tally.wireChips();

    wireChipPopovers(this.container, this.popoverWireCtx());

    updateRowFades(this.container);
    this.onConfig?.(this.sessionModel ?? this.meta.model, this.effort, !this.readOnlyEffort);
  }

  /** The popovers a closeChipPopovers() sweep dismisses, bundled for reuse by
   *  both the wiring ctx below and this class's own closeChipPopovers(). */
  private popoverBundle(): StatusbarPopovers {
    return {
      drainPopover: this.drainPopover,
      aiTodosPopover: this.aiTodosPopover,
      serversPopover: this.serversPopover,
      imagesPopover: this.imagesPopover,
      effortPopover: this.effortPopover,
      modelPopover: this.modelPopover,
      gitCard: this.gitCard,
      overflowPopover: this.overflowPopover,
      tally: this.tally,
    };
  }

  /** Snapshot session-statusbar-popovers.ts's wireChipPopovers needs, once per
   *  render() rather than per handler (same pattern as chipRenderCtx()). */
  private popoverWireCtx(): ChipPopoverWireCtx {
    return {
      ...this.popoverBundle(),
      cwd: this.cwd,
      liveCwd: this.liveCwd,
      gitInfo: this.gitInfo,
      gitCwd: this.gitCwd,
      effortAnchor: this.effortAnchor,
      modelAnchor: this.modelAnchor,
      toggleModelPopover: (anchor) => this.toggleModelPopover(anchor),
      toggleEffortPopover: (anchor) => this.toggleEffortPopover(anchor),
      refreshGitInfo: () => void this.refreshGitInfo(),
      overflowData: () => this.overflowData(),
    };
  }

  /** Dismiss every chip popover (both statusbar-owned and the tool-tally one). */
  private closeChipPopovers(): void {
    closeAllChipPopovers(this.popoverBundle());
  }
}
