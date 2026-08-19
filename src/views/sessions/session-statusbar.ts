import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { RemoteUnavailableError } from "../../shared/http-transport";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { type ChipType, type StaticChipType, isToolChip, chipToolName, STATIC_CHIPS } from "./statusline-catalog";
import { getCachedAccount, capitalize } from "../../shared/accounts-cache";
import { getChatRendererSnapshot } from "../../shared/chat/chat-renderer-bridge";
import { sessionEvents } from "../../shared/chat/event-store";
import {
  formatDuration,
  shortModelName,
  gitInfoCache,
  metaCache,
  countsCache,
  ctxStatusCache,
  drainCache,
  fetchGitInfo,
  type SessionCounts,
  type StatusbarOptions,
} from "./session-statusbar-helpers";
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

// NOTE: a split of the chip-render concern into a separate `statusline-chip-render.ts`
// was evaluated and rejected (ai_todo 98). The render methods read ~18 instance
// fields and depend on a LIVE controller (`this.tally.renderChipFor` for tool chips)
// plus a MUTABLE `animatedKeys` Set (`animClass` has a side effect), so a "pure
// function + small snapshot" seam doesn't hold - the snapshot balloons and threading
// the controller + mutable set out worsens readability. This file uses plain
// innerHTML strings (not lit) and sits only marginally over the ~400-line guideline,
// which this codebase tolerates. Leave as-is; don't re-attempt without a new seam.
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
    void this.serversPopover.refresh(cwd, () => this.render());
    this.serversTimer = setInterval(() => {
      void this.serversPopover.refresh(cwd, () => this.render());
    }, 8000);
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
    let effective = spawn;
    if (this.sessionId) {
      try {
        effective = await invoke<string>("session_live_cwd", { sessionId: this.sessionId, fallback: spawn });
      } catch { /* command may predate this binary - keep spawn cwd */ }
    }
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

  /** User prompts this chat has actually delivered, or null when the live
   *  renderer can't answer for this session (a different chat is mounted, or
   *  older history is still unpaged). */
  private deliveredPrompts(sid: string): number | null {
    const snap = getChatRendererSnapshot();
    if (!snap || snap.sessionId !== sid) return null;
    if (sessionEvents.hasMore(sid)) return null;
    return snap.messages.reduce((n, m) => n + (m.kind === "user" ? 1 : 0), 0);
  }

  private async refreshCounts(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    try {
      const r = await invoke<{ tokens: number; turns: number; prompts?: number }>("instance_token_stats", { sessionId: sid });
      if (this.sessionId !== sid) return;
      const next: SessionCounts = { prompts: r.prompts ?? 0, turns: r.turns ?? 0 };
      // A chat that has delivered nothing cannot own counts, so these belong to
      // another transcript. Fall back to the skeleton chip (todo 660).
      if (next.prompts > 0 && this.deliveredPrompts(sid) === 0) {
        this.counts = null;
        this.countsLoaded = false;
        countsCache.delete(sid);
        this.render();
        return;
      }
      this.counts = next;
      this.countsLoaded = true;
      countsCache.set(sid, this.counts);
      this.render();
    } catch { /* transient - keep last known counts */ }
  }

  private async refreshContextStatus(allowRetry = true): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    const hadUsage = this.meta.hasUsage;
    try {
      const r = await invoke<ContextStatus | null>("context_status", { sessionId: sid });
      if (this.sessionId !== sid) return;
      if (r) {
        this.ctxStatus = r;
        ctxStatusCache.set(sid, r);
        this.render();
      } else if (allowRetry && hadUsage && !this.ctxStatus) {
        setTimeout(() => {
          if (this.sessionId === sid && !this.ctxStatus) void this.refreshContextStatus(false);
        }, 1500);
      }
    } catch { /* command may predate this binary, or transient - keep fallback */ }
  }

  private async refreshGitInfo(): Promise<void> {
    const cwd = this.gitCwd;
    if (!cwd) return;
    try {
      const info = await fetchGitInfo(cwd);
      if (this.gitCwd !== cwd) return;
      this.updateGitInfo(info);
    } catch (e) {
      // An unwired remote command resolves the skeleton to hidden instead of
      // spinning forever; a genuine transient failure keeps retrying.
      if (e instanceof RemoteUnavailableError) { this.gitInfoLoaded = true; this.render(); }
    }
  }

  private async refreshDirty(): Promise<void> {
    const cwd = this.gitCwd;
    if (!cwd) return;
    try {
      const files = await invoke<string[]>("get_git_dirty", { cwd });
      if (this.gitCwd !== cwd) return;
      this.dirtyCount = files.length;
      this.dirtyLoaded = true;
      this.render();
    } catch (e) {
      if (e instanceof RemoteUnavailableError) { this.dirtyLoaded = true; this.render(); }
    }
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
    if (this.wantsContext() && id && !id.startsWith("pending-")) {
      setTimeout(() => {
        if (this.sessionId === id && !this.ctxStatus) void this.refreshContextStatus();
      }, 3000);
    }
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

  private skeletonChip(key: string, extraClass: string, iconClass: string, width: string): string {
    return `<span class="sb-chip sb-skeleton ${extraClass}" data-skeleton="${key}" style="min-width:${width}"><i class="ph ${iconClass}"></i><span class="sb-skel-bar"></span></span>`;
  }

  private animClass(key: string): string {
    if (this.animatedKeys.has(key)) return "";
    this.animatedKeys.add(key);
    return " sb-fadein";
  }

  private clockText(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ── chip dispatch ──────────────────────────────────────────────────────────
  private renderChip(type: ChipType): string {
    if (isToolChip(type)) {
      const tool = chipToolName(type);
      const count = this.toolTally.byType.find((b) => b.tool === tool)?.count ?? 0;
      return this.tally.renderChipFor(tool, count, this.hideZero);
    }
    switch (type) {
      case "model": {
        const model = this.meta.model ?? this.sessionModel;
        if (model) return `<span class="sb-chip sb-model sb-model-btn${this.animClass("model")}" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(model))}</span>`;
        if (!this.metaLoaded) return this.skeletonChip("model", "sb-model", "ph-robot", "70px");
        return "";
      }
      case "account": {
        const acc = getCachedAccount(this.accountId);
        if (!acc) return "";
        const clickable = this.onAccountClick ? " sb-account-btn" : "";
        return `<span class="sb-chip sb-account${clickable}${this.animClass("account")}" style="--acc:${escapeHtml(acc.colour)}" role="button" tabindex="0" title="Click to move this chat to a different account"><i class="ph ph-${escapeHtml(acc.icon)}"></i>${escapeHtml(capitalize(acc.label))}</span>`;
      }
      case "effort": {
        if (!this.effort) return "";
        const cls = this.readOnlyEffort ? " readonly" : " sb-effort-btn";
        return `<span class="sb-chip sb-effort${cls}${this.animClass("effort")}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(this.effort)}</span>`;
      }
      case "context_pct": return this.renderContext(false);
      case "context_tokens": return this.renderContext(true);
      case "thinking":
        return this.meta.hasThinking ? `<span class="sb-chip sb-thinking active${this.animClass("thinking")}"><i class="ph ph-brain"></i>thinking</span>` : "";
      case "branch": {
        if (this.gitInfo.branch) return `<span class="sb-chip sb-branch sb-branch-btn${this.animClass("branch")}" role="button" tabindex="0"><i class="ph ph-git-branch"></i>${escapeHtml(this.gitInfo.branch)}</span>`;
        if (!this.gitInfoLoaded) return this.skeletonChip("branch", "sb-branch", "ph-git-branch", "60px");
        return "";
      }
      case "repo": {
        if (this.gitInfo.repo) return `<span class="sb-chip sb-repo${this.animClass("repo")}"><i class="ph ph-folder-simple"></i>${escapeHtml(this.gitInfo.repo)}</span>`;
        if (!this.gitInfoLoaded) return this.skeletonChip("repo", "sb-repo", "ph-folder-simple", "80px");
        return "";
      }
      case "folder": {
        // Git-section chip: follow the live git cwd so it stays coherent with
        // the branch/repo chips when the AI is working in a worktree.
        const dir = this.gitCwd;
        if (!dir) return "";
        const folderName = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? dir;
        const cwdEsc = escapeHtml(dir);
        return `<span class="sb-chip sb-folder sb-folder-btn${this.animClass("folder")}" role="button" title="${cwdEsc}" data-cwd="${cwdEsc}"><i class="ph ph-folder-open"></i>${escapeHtml(folderName)}</span>`;
      }
      case "commits": return this.renderCommits("both");
      case "commits_ahead": return this.renderCommits("ahead");
      case "commits_behind": return this.renderCommits("behind");
      case "dirty": return this.renderDirty();
      case "sha":
        if (this.gitInfo.sha) return `<span class="sb-chip sb-sha${this.animClass("sha")}"><i class="ph ph-hash"></i>${escapeHtml(this.gitInfo.sha)}</span>`;
        return this.gitInfoLoaded ? "" : this.skeletonChip("sha", "sb-sha", "ph-hash", "60px");
      case "diffstat": return this.renderDiffstat();
      case "messages": {
        if (this.counts) {
          const n = this.counts.prompts;
          if (n === 0 && this.hideZero) return "";
          return `<span class="sb-chip sb-messages${this.animClass("messages")}"><i class="ph ph-chat-circle"></i>${n} ${n === 1 ? "msg" : "msgs"}</span>`;
        }
        return this.countsLoaded ? "" : this.skeletonChip("messages", "sb-messages", "ph-chat-circle", "52px");
      }
      case "turns": {
        if (this.counts) {
          const n = this.counts.turns;
          if (n === 0 && this.hideZero) return "";
          return `<span class="sb-chip sb-turns${this.animClass("turns")}"><i class="ph ph-arrows-clockwise"></i>${n} ${n === 1 ? "turn" : "turns"}</span>`;
        }
        return this.countsLoaded ? "" : this.skeletonChip("turns", "sb-turns", "ph-arrows-clockwise", "55px");
      }
      case "duration":
        if (!this.startedAt) return "";
        return `<span class="sb-chip sb-duration${this.animClass("duration")}"><i class="ph ph-timer"></i><span class="sb-duration-text">${formatDuration(this.startedAt)}</span></span>`;
      case "cost": return this.renderCost();
      case "clock":
        return `<span class="sb-chip sb-clock${this.animClass("clock")}"><i class="ph ph-clock"></i><span class="sb-clock-text">${this.clockText()}</span></span>`;
      case "ai_todos": return this.aiTodosPopover.renderChip(this.cwd, (k) => this.animClass(k));
      case "drain": return this.drainPopover.renderChip((k) => this.animClass(k));
      case "servers": return this.serversPopover.renderChip(this.cwd, (k) => this.animClass(k));
      case "images": return this.imagesPopover.renderChip((k) => this.animClass(k));
      case "separator":
        return `<span class="sb-separator" aria-hidden="true"></span>`;
      case "flex_separator":
        return `<span class="sb-flex-sep" aria-hidden="true"></span>`;
      default: return "";
    }
  }

  private renderContext(asTokens: boolean): string {
    const key = asTokens ? "context_tokens" : "context_pct";
    if (this.ctxStatus) {
      const c = this.ctxStatus;
      const raw = c.pct_used;
      const estimated = c.confidence !== "proven";
      if (raw >= 100) console.warn("[ctx-100] context pinned at 100% (daemon)", { occupancy: String(c.occupancy), window: String(c.window), model: c.model, confidence: c.confidence });
      const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
      const occ = Number(c.occupancy).toLocaleString();
      const win = Number(c.window).toLocaleString();
      const note = estimated ? " (estimated)" : "";
      const pctStr = raw < 1 && raw > 0 ? "<1" : String(Math.min(100, Math.round(raw)));
      const body = asTokens ? `${formatTokenCount(Number(c.occupancy), { decimals: 0 })} / ${formatTokenCount(Number(c.window), { decimals: 0 })}` : `${pctStr}%`;
      return `<span class="sb-chip sb-context${cls}${this.animClass(key)}" title="${occ} / ${win} tokens (conversation + system prompt + tools)${note}"><i class="ph ph-stack"></i>${body}</span>`;
    } else if (!this.metaLoaded || this.meta.hasUsage) {
      // No independent window heuristic here anymore (ai_todo 31): the daemon's
      // context_status is the sole source of truth. While it's still resolving
      // (or hasn't been fetched yet) show a loading skeleton instead of an
      // estimate; once meta reports usage with no context_status forthcoming,
      // this keeps showing the skeleton rather than silently going stale.
      return this.skeletonChip(key, "sb-context", "ph-stack", asTokens ? "70px" : "40px");
    }
    return "";
  }

  private renderCommits(mode: "ahead" | "behind" | "both"): string {
    const a = this.gitInfo.ahead ?? null, b = this.gitInfo.behind ?? null;
    if (a === null && b === null) {
      if (!this.gitInfoLoaded) return this.skeletonChip("commits", "sb-commits", "ph-arrows-down-up", "44px");
      // No upstream tracking branch (as opposed to 0 ahead/0 behind, which is
      // Some(0)/Some(0)). Mirrors VS Code's "Publish Branch" cloud icon rather
      // than hiding the chip, so an unpushed branch reads as expected-empty.
      if (mode === "both" && this.gitInfo.branch) {
        return `<span class="sb-chip sb-commits" title="No upstream tracking branch"><i class="ph ph-cloud-arrow-up"></i></span>`;
      }
      return "";
    }
    let txt = "", icon = "ph-arrows-down-up";
    if (mode === "ahead") { txt = `↑${a ?? 0}`; icon = "ph-arrow-up"; }
    else if (mode === "behind") { txt = `↓${b ?? 0}`; icon = "ph-arrow-down"; }
    else { txt = `↑${a ?? 0} ↓${b ?? 0}`; }
    const key = `commits_${mode}`;
    return `<span class="sb-chip sb-commits sb-commits-btn${this.animClass(key)}" role="button" tabindex="0" title="${a ?? 0} ahead, ${b ?? 0} behind upstream"><i class="ph ${icon}"></i>${txt}</span>`;
  }

  private renderDirty(): string {
    const n = this.dirtyCount;
    if (n === null) return this.dirtyLoaded ? "" : this.skeletonChip("dirty", "sb-dirty", "ph-pencil-simple", "44px");
    if (n === 0 && this.hideZero) return "";
    return `<span class="sb-chip sb-dirty${this.animClass("dirty")}" title="${n} uncommitted file${n === 1 ? "" : "s"}"><i class="ph ph-pencil-simple"></i>${n} dirty</span>`;
  }

  private renderDiffstat(): string {
    const ins = this.gitInfo.insertions, del = this.gitInfo.deletions;
    if (ins == null && del == null) return this.gitInfoLoaded ? "" : this.skeletonChip("diffstat", "sb-diffstat", "ph-plus-minus", "50px");
    if ((ins ?? 0) === 0 && (del ?? 0) === 0 && this.hideZero) return "";
    return `<span class="sb-chip sb-diffstat${this.animClass("diffstat")}" title="uncommitted: +${ins ?? 0} / -${del ?? 0}"><i class="ph ph-plus-minus"></i><span class="sb-ins">+${ins ?? 0}</span> <span class="sb-del">-${del ?? 0}</span></span>`;
  }

  private renderCost(): string {
    const c = this.meta.totalCostUsd;
    if (!this.metaLoaded) return this.skeletonChip("cost", "sb-cost", "ph-currency-dollar", "44px");
    if ((!c || c <= 0) && this.hideZero) return "";
    return `<span class="sb-chip sb-cost${this.animClass("cost")}" title="Estimated session cost (local estimate, not a charge)"><i class="ph ph-currency-dollar"></i>~$${(c ?? 0).toFixed(2)}</span>`;
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
    const rowsHtml = this.rows.map((row) => {
      const chips = row.map((t) => this.renderChip(t)).filter(Boolean).join("");
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
        model: this.meta.model ?? this.sessionModel ?? "",
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
        this.commitsPopover.open(anchor, sync);
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
