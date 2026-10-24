// Shared template atoms and the context every dashboard section renders from.
import { html, nothing, type TemplateResult } from "lit-html";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { sameCwd, type ReportsTab } from "./format";
import type { DashboardHistory, DashSnapshot, DashTodo, RepoRef } from "./types";
import type { UsageRange, UsageState } from "./dash-usage";

/** What a dashboard row can do. Implemented in dash-actions.ts, so the section
 *  templates stay pure functions of (ctx) and never import the sessions view. */
export interface DashActions {
  /** A slash command (or, with none, a plain new chat). Inside a draft it goes
   *  into the draft's message box; on the standalone page it starts a draft
   *  with the command already typed. Never sent on its own. */
  runCommand(anchor: HTMLElement, command?: string): void;
  /** Leave the standalone page for the chat that was open before it. */
  back(): void;
  openIn(anchor: HTMLElement, kind: "vscode" | "terminal" | "explorer"): void;
  openChat(sessionId: string): void;
  openHistory(sessionId: string): void;
  openFile(path: string): void;
  openUrl(url: string): void;
  openAllHistory(): void;
  toggleTodo(todo: DashTodo): void;
  refreshCard(id: string): void;
  /** The project menu, under a button (the page header's kebab). */
  openMenu(anchor: HTMLElement): void;
  setTab(tab: ReportsTab): void;
  openImage(id: string): void;
  setPage(key: string, page: number): void;
  /** Full-size view of the Reports card's current tab. */
  openReportsModal(): void;
  setUsageRange(range: UsageRange): void;
  setUsageOffset(offset: number): void;
}

/** Where a dashboard is shown: above a new-chat draft's message box, or as a
 *  page of its own (the chat header's project name, Ctrl+Shift+D). */
export type DashMode = "draft" | "page";

export interface DashCtx {
  mode: DashMode;
  snap: DashSnapshot;
  usage: UsageState;
  history: DashboardHistory | null;
  /** The last dashboard_history call failed while none had landed yet. */
  historyFailed?: boolean;
  tab: ReportsTab;
  /** Gallery data URLs by image id; "failed" once a load errored. */
  images: Map<string, string>;
  refreshing: Set<string>;
  doneTodos: Set<string>;
  /** Current page per paged card, keyed by the pager's name. */
  pages: Map<string, number>;
  /** Which of the two columns each half-width section sits in, by section id (balance.ts). */
  columns: Map<string, 0 | 1>;
  /** The half-width section ids in reading order, as the last template built them. */
  halfOrder: string[];
  /** Called after every paint; the Reports modal redraws from it while open. */
  paintHooks: Set<() => void>;
  nowMs: number;
  act: DashActions;
}

export const isGroup = (c: DashCtx): boolean => c.snap.target.kind === "group";

export const hidden = (c: DashCtx, id: string): boolean => c.snap.hidden_builtins.includes(id);

export function repoName(c: DashCtx, cwd: string): string {
  const r: RepoRef | undefined = c.snap.target.repos.find((x) => sameCwd(x.cwd, cwd));
  return r?.name ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** A repo tag on a row, only where it carries information: a group showing every repo. */
export function repoTag(c: DashCtx, cwd: string): TemplateResult | typeof nothing {
  if (!isGroup(c)) return nothing;
  return html`<span class="pd-repo">${repoName(c, cwd)}</span>`;
}

export const icon = (name: string): TemplateResult => html`<i class="ph ph-${name} pd-ic"></i>`;

export type DotKind = "q" | "w" | "ok" | "idle";
export const dot = (kind: DotKind): TemplateResult => html`<span class="pd-dot ${kind}"></span>`;

/** What a right-click on a row or card is about; the context menu puts that
 *  item's own actions above the project's. Set as a DOM property (pdCtx), so
 *  the menu reads the object itself rather than a serialised copy. */
export type CtxItem =
  | { kind: "chat", sessionId: string, live: boolean }
  | { kind: "todo", todo: DashTodo }
  | { kind: "card", id: string }
  | { kind: "commit", sha: string }
  | { kind: "file", path: string, exists: boolean }
  | { kind: "plan", id: string | null, text: string }
  | { kind: "server", port: number };

export interface RowOpts {
  ctx?: CtxItem;
  onClick?: () => void;
  title?: string;
  dim?: boolean;
  meta?: string;
  tag?: TemplateResult | typeof nothing;
  trailing?: TemplateResult | typeof nothing;
  /** First row of a new run inside a card (the scheduled items, the commits):
   *  extra space above it does the job a sub-heading would. */
  gap?: boolean;
}

export function row(lead: TemplateResult, text: TemplateResult | string, o: RowOpts = {}): TemplateResult {
  return html`<div class="pd-row ${o.onClick ? "is-link" : ""} ${o.dim ? "is-dim" : ""} ${o.gap ? "is-gap" : ""}" title=${ifDefined(o.title)} .pdCtx=${o.ctx} @click=${o.onClick}>
    ${lead}<span class="pd-t">${text}</span>${o.tag ?? nothing}${o.trailing ?? nothing}${o.meta ? html`<span class="pd-m">${o.meta}</span>` : nothing}
  </div>`;
}

export const quiet = (text: string): TemplateResult => html`<div class="pd-quiet">${text}</div>`;

export interface CardOpts {
  id: string;
  ctx?: CtxItem;
  trailing?: TemplateResult | typeof nothing;
  /** A small number beside the title (how many are running), so the state reads at a glance. */
  count?: number;
}

export function card(title: string, body: TemplateResult | TemplateResult[], o: CardOpts): TemplateResult {
  return html`<section class="pd-card" data-pd-card=${o.id} .pdCtx=${o.ctx}>
    <div class="pd-h"><span>${title}${o.count ? html`<span class="pd-count">${o.count}</span>` : nothing}</span><span class="grow"></span>${o.trailing ?? nothing}</div>
    ${body}
  </section>`;
}

export const kv = (k: string, v: TemplateResult | string, cls = ""): TemplateResult =>
  html`<div class="pd-kv"><span class="k">${k}</span><span class=${cls}>${v}</span></div>`;
