/**
 * The six inline popover subsystems extracted from session-statusbar.ts.
 * Each class owns its chip HTML, its popover HTML, and (where relevant) its data
 * refresh; the shared PopoverShell owns every popover's DOM lifecycle, placement
 * (below the chip, centered, window-clamped, scrollable) and dismissal, so they
 * all look and behave the same. SessionStatusbar delegates to these.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { EFFORTS, readModels, modelDisplayLabel } from "../../shared/effort-presets";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import type { AiTodoEntry, ChatDrain, ServerInfo } from "../../types/ipc.generated";
import { drainCache } from "./session-statusbar-helpers";
import { PopoverShell } from "./statusbar-popover-shell";

// ─────────────────────────────────── Drain ─────────────────────────────────

export class DrainPopover {
  drain: ChatDrain | null = null;
  private inflight = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  async refresh(sid: string, rerender: () => void, reanchor: () => void): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const d = await invoke<ChatDrain | null>("chat_drain", { sessionId: sid });
      if (d) {
        this.drain = d;
        drainCache.set(sid, d);
        rerender();
        if (this.shell.isOpen) reanchor();
      }
    } catch { /* transient */ }
    finally { this.inflight = false; }
  }

  renderChip(animClass: (key: string) => string): string {
    const d = this.drain;
    if (!d) {
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="Token drain (loading)" title="Share of a 5h session this chat has used (loading)"><i class="ph ph-drop"></i>··%</span>`;
    }
    if (d.fiveHourPct === null) {
      const label = "No usage data yet to compute this chat's share. Click for the token rundown.";
      return `<span class="sb-chip sb-drain sb-drain-btn muted${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>—%</span>`;
    }
    const five = Math.round(d.fiveHourPct);
    const week = Math.round(d.weeklyPct ?? 0);
    const cls = d.fiveHourPct >= 80 ? " danger" : d.fiveHourPct >= 50 ? " warn" : "";
    const label = `This chat is ${five}% of your current 5h session and ${week}% of the week. Click for a per-message rundown.`;
    return `<span class="sb-chip sb-drain sb-drain-btn${cls}${animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>${five}% · ${week}%w</span>`;
  }

  /** Rebuilds in-place when called while open (background refresh / re-anchor). */
  open(anchor: HTMLElement): void {
    this.shell.open(anchor, this.buildHtml(), { className: "sb-drain-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    const d = this.drain;
    if (!d) return `<div class="sb-drain-empty">No drain data yet</div>`;
    const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}%`);
    const tokens = formatTokenCount(Number(d.tokens), { decimals: 1 });
    const header = `
      <div class="sb-drain-header">
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.fiveHourPct)}</span><span class="sb-drain-stat-lbl">of your 5h session</span></span>
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${pct(d.weeklyPct)}</span><span class="sb-drain-stat-lbl">of the week</span></span>
      </div>
      <div class="sb-drain-secondary"><i class="ph ph-coins"></i>${escapeHtml(tokens)} tokens used</div>`;
    const rows = d.messages.length === 0
      ? `<div class="sb-drain-empty">No message breakdown yet</div>`
      : d.messages.map((m) => {
          const flag = m.expensive ? ' <i class="ph ph-warning sb-drain-flag"></i>' : "";
          const expCls = m.expensive ? " expensive" : "";
          const tok = formatTokenCount(Number(m.tokens), { decimals: 1 });
          return `<div class="sb-drain-row${expCls}" title="${escapeHtml(m.preview)}"><span class="sb-drain-idx">#${m.index}</span><span class="sb-drain-preview">${escapeHtml(m.preview)}</span>${flag}<span class="sb-drain-tokens">${escapeHtml(tok)} tok</span></div>`;
        }).join("");
    return `${header}<div class="sb-drain-list">${rows}</div>`;
  }
}

// ─────────────────────────────── Branch ────────────────────────────────────

export interface BranchEntry { name: string; current: boolean; short_sha: string | null; upstream: string | null; }

export class BranchPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, branches: BranchEntry[]): void {
    this.shell.open(anchor, this.buildHtml(branches), { className: "sb-git-popover sb-branch-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement, branches: BranchEntry[]): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor, branches);
  }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(branches: BranchEntry[]): string {
    const header = `<div class="sb-git-pop-header"><i class="ph ph-git-branch"></i>Recent branches</div>`;
    if (branches.length === 0) return `${header}<div class="sb-git-pop-empty">No branches found</div>`;
    const rows = branches.map((b) => {
      const check = b.current ? `<i class="ph ph-check sb-git-pop-check"></i>` : `<span class="sb-git-pop-check-pad"></span>`;
      const sha = b.short_sha ? `<span class="sb-git-pop-sha">${escapeHtml(b.short_sha)}</span>` : "";
      const up = b.upstream ? `<span class="sb-git-pop-upstream">${escapeHtml(b.upstream)}</span>` : "";
      return `<div class="sb-git-pop-row${b.current ? " current" : ""}">${check}<span class="sb-git-pop-name">${escapeHtml(b.name)}</span>${sha}${up}</div>`;
    }).join("");
    return `${header}<div class="sb-git-pop-list">${rows}</div>`;
  }
}

// ─────────────────────────────── Commits ───────────────────────────────────

export interface CommitEntry { short_sha: string; message: string; }
export interface CommitSync { ahead: CommitEntry[]; behind: CommitEntry[]; has_upstream: boolean; }

export class CommitsPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, sync: CommitSync): void {
    this.shell.open(anchor, this.buildHtml(sync), { className: "sb-git-popover sb-commits-popover" });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement, sync: CommitSync): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor, sync);
  }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(sync: CommitSync): string {
    if (!sync.has_upstream) {
      return `<div class="sb-git-pop-empty">No upstream configured for this branch</div>`;
    }
    const { ahead, behind } = sync;
    if (ahead.length === 0 && behind.length === 0) {
      return `<div class="sb-git-pop-empty"><i class="ph ph-check-circle"></i> Up to date with upstream</div>`;
    }
    const parts: string[] = [];
    if (ahead.length > 0) {
      const rows = ahead.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section ahead"><i class="ph ph-arrow-up"></i>Outgoing <span class="sb-git-pop-count">${ahead.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    if (behind.length > 0) {
      const rows = behind.map((c) =>
        `<div class="sb-git-pop-commit"><span class="sb-git-pop-sha">${escapeHtml(c.short_sha)}</span><span class="sb-git-pop-msg">${escapeHtml(c.message)}</span></div>`
      ).join("");
      parts.push(`<div class="sb-git-pop-section behind"><i class="ph ph-arrow-down"></i>Incoming <span class="sb-git-pop-count">${behind.length}</span></div><div class="sb-git-pop-list">${rows}</div>`);
    }
    return parts.join("");
  }
}

// ─────────────────────────────── AI Todos ──────────────────────────────────

export class AiTodosPopover {
  files: AiTodoEntry[] = [];
  loaded = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  async refresh(cwd: string, rerender: () => void): Promise<void> {
    try {
      const files = await invoke<AiTodoEntry[]>("list_ai_todos", { cwd });
      this.files = files;
      this.loaded = true;
      rerender();
    } catch { /* transient */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-ai-todos" data-skeleton="ai_todos" style="min-width:55px"><i class="ph ph-check-square"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.files.length;
    if (n === 0) return "";
    return `<span class="sb-chip sb-ai-todos sb-ai-todos-btn${animClass("ai_todos")}" role="button" tabindex="0" title="${n} AI todo${n === 1 ? "" : "s"} in .claude/todos"><i class="ph ph-check-square"></i>${n} todo${n === 1 ? "" : "s"}</span>`;
  }

  /** Rebuilds in-place when called while open (re-anchor after a chip re-render
   *  or a background list refresh). No-op when there are no todos. */
  open(anchor: HTMLElement): void {
    if (this.files.length === 0) { this.shell.close(); return; }
    this.shell.open(anchor, this.buildHtml(), {
      className: "sb-ai-todos-popover",
      wire: (el) => {
        el.querySelectorAll<HTMLElement>(".sb-ai-todos-popover-file").forEach((f) => {
          f.addEventListener("click", () => {
            const p = f.dataset.path;
            if (p) void invoke<void>("open_in_editor", { path: p });
          });
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    return `
      <div class="sb-ai-todos-popover-header">AI Todos (${this.files.length})</div>
      <div class="sb-ai-todos-popover-list">
        ${this.files.map((f) => `<div class="sb-ai-todos-popover-file" role="button" tabindex="0" data-path="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>`).join("")}
      </div>
    `;
  }
}

// ─────────────────────────────── Servers ───────────────────────────────────

export class ServersPopover {
  servers: ServerInfo[] = [];
  loaded = false;
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  /** Signature of the current list, so a background poll only re-renders on
   *  change (avoids churning the statusbar every tick). */
  private sig(list: ServerInfo[]): string {
    return list.map((s) => `${s.id}@${s.port}`).join("|");
  }

  async refresh(cwd: string, rerender: () => void): Promise<void> {
    try {
      const next = await invoke<ServerInfo[]>("list_project_servers", { cwd });
      const changed = !this.loaded || this.sig(next) !== this.sig(this.servers);
      this.servers = next;
      this.loaded = true;
      if (changed) rerender();
    } catch { /* supervisor down / transient - keep last known */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-servers" data-skeleton="servers" style="min-width:52px"><i class="ph ph-broadcast"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.servers.length;
    if (n === 0) return "";
    const ports = this.servers.map((s) => `:${s.port}`).join(", ");
    const label = `${n} dev server${n === 1 ? "" : "s"} running for this project (${ports}). Click to open in the browser.`;
    return `<span class="sb-chip sb-servers sb-servers-btn${animClass("servers")}" role="button" tabindex="0" title="${escapeHtml(label)}"><i class="ph ph-broadcast"></i>${n} live</span>`;
  }

  /** Rebuilds in-place when called while open (re-anchor / background refresh).
   *  No-op when nothing is running. */
  open(anchor: HTMLElement): void {
    if (this.servers.length === 0) { this.shell.close(); return; }
    this.shell.open(anchor, this.buildHtml(), {
      className: "sb-servers-popover",
      wire: (el) => {
        el.querySelectorAll<HTMLElement>(".sb-servers-row").forEach((r) => {
          r.addEventListener("click", () => {
            const url = r.dataset.url;
            if (url) void invoke<void>("open_external", { url });
          });
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  toggle(anchor: HTMLElement): void {
    if (this.shell.isOpen) this.shell.close();
    else this.open(anchor);
  }

  private buildHtml(): string {
    const rows = this.servers.map((s) => {
      const url = `http://127.0.0.1:${s.port}`;
      return `<div class="sb-servers-row" role="button" tabindex="0" data-url="${escapeHtml(url)}" title="Open ${escapeHtml(url)}"><i class="ph ph-arrow-square-out"></i><span class="sb-servers-name">${escapeHtml(s.name)}</span><span class="sb-servers-port">:${s.port}</span></div>`;
    }).join("");
    return `
      <div class="sb-servers-popover-header">Running servers (${this.servers.length})</div>
      <div class="sb-servers-popover-list">${rows}</div>
    `;
  }
}

// ─────────────────────────────── Effort ────────────────────────────────────

export interface EffortOpenCtx {
  effort: string;
  sessionId: string | null;
  onEffortChange: ((effort: string) => void) | null;
  /** Persist + reflect the chosen effort, then close + re-render the chip. */
  onCommit: (effort: string) => void;
}

export class EffortPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, ctx: EffortOpenCtx): void {
    this.shell.open(anchor, this.buildHtml(ctx.effort), {
      className: "sb-effort-popover",
      wire: (el) => {
        const slider = el.querySelector<HTMLInputElement>(".sb-effort-slider");
        slider?.addEventListener("change", () => {
          const next = EFFORTS[Number(slider.value)];
          if (!next) return;
          if (ctx.onEffortChange) {
            ctx.onEffortChange(next);
            ctx.onCommit(next);
            return;
          }
          if (!ctx.sessionId) return;
          const sid = ctx.sessionId;
          void invoke<void>("set_session_effort", { sessionId: sid, effort: next })
            .then(() => ctx.onCommit(next))
            .catch((err) => console.error("[statusbar] set_session_effort failed", err));
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(effort: string): string {
    const effortIdx = Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number]));
    return `
      <div class="sb-effort-popover-label">Effort</div>
      <input type="range" class="sb-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx}">
      <div class="sb-effort-stops">
        ${EFFORTS.map((e, i) => `<span class="sb-effort-stop${i === effortIdx ? " active" : ""}">${escapeHtml(e)}</span>`).join("")}
      </div>
    `;
  }
}

// ─────────────────────────────── Model ─────────────────────────────────────

export interface ModelOpenCtx {
  model: string;
  sessionId: string | null;
  /** Present only for a not-yet-started (draft) session: commits locally
   *  instead of round-tripping through set_session_model. */
  onModelChange?: (model: string) => void;
  /** Persist + reflect the chosen model, then close + re-render the chip. */
  onCommit: (model: string) => void;
}

export class ModelPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, ctx: ModelOpenCtx): void {
    if (!ctx.onModelChange && !ctx.sessionId) {
      if (!ctx.model) { this.shell.close(); return; }
      this.shell.open(anchor, `
        <div class="sb-model-popover-name">${escapeHtml(ctx.model)}</div>
      `, { className: "sb-model-popover" });
      return;
    }
    const models = readModels({});
    const isDraft = !!ctx.onModelChange;
    this.shell.open(anchor, this.buildEditableHtml(models, ctx.model, isDraft), {
      className: "sb-model-popover",
      wire: (el) => {
        const slider = el.querySelector<HTMLInputElement>(".sb-model-slider");
        slider?.addEventListener("change", () => {
          const next = models[Number(slider.value)];
          if (!next) return;
          if (ctx.onModelChange) {
            ctx.onModelChange(next);
            ctx.onCommit(next);
            return;
          }
          if (!ctx.sessionId) return;
          const sid = ctx.sessionId;
          void invoke<void>("set_session_model", { sessionId: sid, model: next })
            .then(() => ctx.onCommit(next))
            .catch((err) => console.error("[statusbar] set_session_model failed", err));
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildEditableHtml(models: string[], model: string, isDraft: boolean): string {
    const idx = Math.max(0, models.indexOf(model));
    const stops = models.map((m, i) => `
      <span class="sb-model-stop${i === idx ? " active" : ""}">${escapeHtml(modelDisplayLabel(m))}</span>
    `).join("");
    const hint = isDraft ? "Applies when this chat starts." : "Applies to your next message.";
    return `
      <div class="sb-model-popover-name">Model</div>
      <input type="range" class="sb-model-slider" min="0" max="${models.length - 1}" step="1" value="${idx}">
      <div class="sb-model-stops">${stops}</div>
      <div class="sb-model-popover-hint">${hint}</div>
    `;
  }
}
