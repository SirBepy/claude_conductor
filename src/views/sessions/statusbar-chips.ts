// Pure chip-HTML builders for SessionStatusbar, extracted per todo 748. Every
// function here reads only its `ChipRenderCtx` param - no `this`, no DOM - so
// a caller assembles the ctx once per render() and reuses it across chips.
import { escapeHtml } from "../../shared/escape-html";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { type ChipType, isToolChip, chipToolName } from "./statusline-catalog";
import { getCachedAccount, capitalize } from "../../shared/accounts-cache";
import { formatDuration, shortModelName, type SessionCounts } from "./session-statusbar-helpers";

export interface ChipRenderCtx {
  meta: SessionMeta;
  metaLoaded: boolean;
  sessionModel: string | null;
  effort: string;
  readOnlyEffort: boolean;
  accountId: string | null;
  hasAccountClick: boolean;
  gitInfo: GitInfo;
  gitInfoLoaded: boolean;
  gitCwd: string | null;
  counts: SessionCounts | null;
  countsLoaded: boolean;
  ctxStatus: ContextStatus | null;
  dirtyCount: number | null;
  dirtyLoaded: boolean;
  startedAt: string | null;
  toolTally: ToolTally;
  hideZero: boolean;
  cwd: string | null;
  animatedKeys: Set<string>;
  renderToolChip: (tool: string, count: number, hideZero: boolean) => string;
  renderAiTodosChip: (cwd: string | null, animClass: (key: string) => string) => string;
  renderDrainChip: (animClass: (key: string) => string) => string;
  renderServersChip: (cwd: string | null, animClass: (key: string) => string) => string;
  renderImagesChip: (animClass: (key: string) => string) => string;
}

export function animClass(animatedKeys: Set<string>, key: string): string {
  if (animatedKeys.has(key)) return "";
  animatedKeys.add(key);
  return " sb-fadein";
}

export function skeletonChip(key: string, extraClass: string, iconClass: string, width: string): string {
  return `<span class="sb-chip sb-skeleton ${extraClass}" data-skeleton="${key}" style="min-width:${width}"><i class="ph ${iconClass}"></i><span class="sb-skel-bar"></span></span>`;
}

export function clockText(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── chip dispatch ──────────────────────────────────────────────────────────
export function renderChip(type: ChipType, ctx: ChipRenderCtx): string {
  const ac = (key: string) => animClass(ctx.animatedKeys, key);
  if (isToolChip(type)) {
    const tool = chipToolName(type);
    const count = ctx.toolTally.byType.find((b) => b.tool === tool)?.count ?? 0;
    return ctx.renderToolChip(tool, count, ctx.hideZero);
  }
  switch (type) {
    case "model": {
      // sessionModel wins: it's the optimistic value set the instant the
      // picker commits, while meta.model only catches up once a fresh turn's
      // system-init event streams in (respawn is silent until the next
      // message) - meta-first here let the chip snap back to the stale model.
      const model = ctx.sessionModel ?? ctx.meta.model;
      if (model) return `<span class="sb-chip sb-model sb-model-btn${ac("model")}" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(model))}</span>`;
      if (!ctx.metaLoaded) return skeletonChip("model", "sb-model", "ph-robot", "70px");
      return "";
    }
    case "account": {
      const acc = getCachedAccount(ctx.accountId);
      if (!acc) return "";
      const clickable = ctx.hasAccountClick ? " sb-account-btn" : "";
      return `<span class="sb-chip sb-account${clickable}${ac("account")}" style="--acc:${escapeHtml(acc.colour)}" role="button" tabindex="0" title="Click to move this chat to a different account"><i class="ph ph-${escapeHtml(acc.icon)}"></i>${escapeHtml(capitalize(acc.label))}</span>`;
    }
    case "effort": {
      if (!ctx.effort) return "";
      const cls = ctx.readOnlyEffort ? " readonly" : " sb-effort-btn";
      return `<span class="sb-chip sb-effort${cls}${ac("effort")}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(ctx.effort)}</span>`;
    }
    case "context_pct": return renderContext(false, ctx);
    case "context_tokens": return renderContext(true, ctx);
    case "thinking":
      return ctx.meta.hasThinking ? `<span class="sb-chip sb-thinking active${ac("thinking")}"><i class="ph ph-brain"></i>thinking</span>` : "";
    case "branch": {
      if (ctx.gitInfo.branch) return `<span class="sb-chip sb-branch sb-branch-btn${ac("branch")}" role="button" tabindex="0"><i class="ph ph-git-branch"></i>${escapeHtml(ctx.gitInfo.branch)}</span>`;
      if (!ctx.gitInfoLoaded) return skeletonChip("branch", "sb-branch", "ph-git-branch", "60px");
      return "";
    }
    case "repo": {
      if (ctx.gitInfo.repo) return `<span class="sb-chip sb-repo${ac("repo")}"><i class="ph ph-folder-simple"></i>${escapeHtml(ctx.gitInfo.repo)}</span>`;
      if (!ctx.gitInfoLoaded) return skeletonChip("repo", "sb-repo", "ph-folder-simple", "80px");
      return "";
    }
    case "folder": {
      // Git-section chip: follow the live git cwd so it stays coherent with
      // the branch/repo chips when the AI is working in a worktree.
      const dir = ctx.gitCwd;
      if (!dir) return "";
      const folderName = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? dir;
      const cwdEsc = escapeHtml(dir);
      return `<span class="sb-chip sb-folder sb-folder-btn${ac("folder")}" role="button" title="${cwdEsc}" data-cwd="${cwdEsc}"><i class="ph ph-folder-open"></i>${escapeHtml(folderName)}</span>`;
    }
    case "commits": return renderCommits("both", ctx);
    case "commits_ahead": return renderCommits("ahead", ctx);
    case "commits_behind": return renderCommits("behind", ctx);
    case "dirty": return renderDirty(ctx);
    case "sha":
      if (ctx.gitInfo.sha) return `<span class="sb-chip sb-sha${ac("sha")}"><i class="ph ph-hash"></i>${escapeHtml(ctx.gitInfo.sha)}</span>`;
      return ctx.gitInfoLoaded ? "" : skeletonChip("sha", "sb-sha", "ph-hash", "60px");
    case "diffstat": return renderDiffstat(ctx);
    case "messages": {
      if (ctx.counts) {
        const n = ctx.counts.prompts;
        if (n === 0 && ctx.hideZero) return "";
        return `<span class="sb-chip sb-messages${ac("messages")}"><i class="ph ph-chat-circle"></i>${n} ${n === 1 ? "msg" : "msgs"}</span>`;
      }
      return ctx.countsLoaded ? "" : skeletonChip("messages", "sb-messages", "ph-chat-circle", "52px");
    }
    case "turns": {
      if (ctx.counts) {
        const n = ctx.counts.turns;
        if (n === 0 && ctx.hideZero) return "";
        return `<span class="sb-chip sb-turns${ac("turns")}"><i class="ph ph-arrows-clockwise"></i>${n} ${n === 1 ? "turn" : "turns"}</span>`;
      }
      return ctx.countsLoaded ? "" : skeletonChip("turns", "sb-turns", "ph-arrows-clockwise", "55px");
    }
    case "duration":
      if (!ctx.startedAt) return "";
      return `<span class="sb-chip sb-duration${ac("duration")}"><i class="ph ph-timer"></i><span class="sb-duration-text">${formatDuration(ctx.startedAt)}</span></span>`;
    case "cost": return renderCost(ctx);
    case "clock":
      return `<span class="sb-chip sb-clock${ac("clock")}"><i class="ph ph-clock"></i><span class="sb-clock-text">${clockText()}</span></span>`;
    case "ai_todos": return ctx.renderAiTodosChip(ctx.cwd, ac);
    case "drain": return ctx.renderDrainChip(ac);
    case "servers": return ctx.renderServersChip(ctx.cwd, ac);
    case "images": return ctx.renderImagesChip(ac);
    case "separator":
      return `<span class="sb-separator" aria-hidden="true"></span>`;
    case "flex_separator":
      return `<span class="sb-flex-sep" aria-hidden="true"></span>`;
    default: return "";
  }
}

export function renderContext(asTokens: boolean, ctx: ChipRenderCtx): string {
  const key = asTokens ? "context_tokens" : "context_pct";
  if (ctx.ctxStatus) {
    const c = ctx.ctxStatus;
    const raw = c.pct_used;
    const estimated = c.confidence !== "proven";
    if (raw >= 100) console.warn("[ctx-100] context pinned at 100% (daemon)", { occupancy: String(c.occupancy), window: String(c.window), model: c.model, confidence: c.confidence });
    const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
    const occ = Number(c.occupancy).toLocaleString();
    const win = Number(c.window).toLocaleString();
    const note = estimated ? " (estimated)" : "";
    const pctStr = raw < 1 && raw > 0 ? "<1" : String(Math.min(100, Math.round(raw)));
    const body = asTokens ? `${formatTokenCount(Number(c.occupancy), { decimals: 0 })} / ${formatTokenCount(Number(c.window), { decimals: 0 })}` : `${pctStr}%`;
    return `<span class="sb-chip sb-context${cls}${animClass(ctx.animatedKeys, key)}" title="${occ} / ${win} tokens (conversation + system prompt + tools)${note}"><i class="ph ph-stack"></i>${body}</span>`;
  } else if (ctx.startedAt === null && !ctx.metaLoaded) {
    // startedAt is null only pre-start (pending pane); with no meta streamed
    // in yet, nothing is actually loading, so 0% beats a skeleton.
    return `<span class="sb-chip sb-context${animClass(ctx.animatedKeys, key)}"><i class="ph ph-stack"></i>${asTokens ? "0" : "0%"}</span>`;
  } else if (!ctx.metaLoaded || ctx.meta.hasUsage) {
    // No independent window heuristic here anymore (ai_todo 31): the daemon's
    // context_status is the sole source of truth. While it's still resolving
    // (or hasn't been fetched yet) show a loading skeleton instead of an
    // estimate; once meta reports usage with no context_status forthcoming,
    // this keeps showing the skeleton rather than silently going stale.
    return skeletonChip(key, "sb-context", "ph-stack", asTokens ? "70px" : "40px");
  }
  return "";
}

export function renderCommits(mode: "ahead" | "behind" | "both", ctx: ChipRenderCtx): string {
  const a = ctx.gitInfo.ahead ?? null, b = ctx.gitInfo.behind ?? null;
  const key = `commits_${mode}`;
  if (a === null && b === null) {
    if (!ctx.gitInfoLoaded) return skeletonChip("commits", "sb-commits", "ph-arrows-down-up", "44px");
    // No upstream tracking branch (as opposed to 0 ahead/0 behind, which is
    // Some(0)/Some(0)). Mirrors VS Code's "Publish Branch" cloud icon rather
    // than hiding the chip, so an unpushed branch reads as expected-empty.
    // Clickable (sb-commits-btn) so the popover's Publish button is reachable.
    if (mode === "both" && ctx.gitInfo.branch) {
      return `<span class="sb-chip sb-commits sb-commits-btn${animClass(ctx.animatedKeys, key)}" role="button" tabindex="0" title="No upstream tracking branch - click to publish"><i class="ph ph-cloud-arrow-up"></i></span>`;
    }
    return "";
  }
  let txt = "", icon = "ph-arrows-down-up";
  if (mode === "ahead") { txt = `↑${a ?? 0}`; icon = "ph-arrow-up"; }
  else if (mode === "behind") { txt = `↓${b ?? 0}`; icon = "ph-arrow-down"; }
  else { txt = `↑${a ?? 0} ↓${b ?? 0}`; }
  return `<span class="sb-chip sb-commits sb-commits-btn${animClass(ctx.animatedKeys, key)}" role="button" tabindex="0" title="${a ?? 0} ahead, ${b ?? 0} behind upstream"><i class="ph ${icon}"></i>${txt}</span>`;
}

export function renderDirty(ctx: ChipRenderCtx): string {
  const n = ctx.dirtyCount;
  if (n === null) return ctx.dirtyLoaded ? "" : skeletonChip("dirty", "sb-dirty", "ph-pencil-simple", "44px");
  if (n === 0 && ctx.hideZero) return "";
  return `<span class="sb-chip sb-dirty${animClass(ctx.animatedKeys, "dirty")}" title="${n} uncommitted file${n === 1 ? "" : "s"}"><i class="ph ph-pencil-simple"></i>${n} dirty</span>`;
}

export function renderDiffstat(ctx: ChipRenderCtx): string {
  const ins = ctx.gitInfo.insertions, del = ctx.gitInfo.deletions;
  if (ins == null && del == null) return ctx.gitInfoLoaded ? "" : skeletonChip("diffstat", "sb-diffstat", "ph-plus-minus", "50px");
  if ((ins ?? 0) === 0 && (del ?? 0) === 0 && ctx.hideZero) return "";
  return `<span class="sb-chip sb-diffstat${animClass(ctx.animatedKeys, "diffstat")}" title="uncommitted: +${ins ?? 0} / -${del ?? 0}"><i class="ph ph-plus-minus"></i><span class="sb-ins">+${ins ?? 0}</span> <span class="sb-del">-${del ?? 0}</span></span>`;
}

export function renderCost(ctx: ChipRenderCtx): string {
  const c = ctx.meta.totalCostUsd;
  if (!ctx.metaLoaded) return skeletonChip("cost", "sb-cost", "ph-currency-dollar", "44px");
  if ((!c || c <= 0) && ctx.hideZero) return "";
  return `<span class="sb-chip sb-cost${animClass(ctx.animatedKeys, "cost")}" title="Estimated session cost (local estimate, not a charge)"><i class="ph ph-currency-dollar"></i>~$${(c ?? 0).toFixed(2)}</span>`;
}
