// Shared template atoms and the context every dashboard section renders from.
import { html, nothing, type TemplateResult } from "lit-html";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { sameCwd, type ReportsTab } from "./format";
import type { DashboardHistory, DashSnapshot, DashTodo, RepoRef } from "./types";

export type ChatsTab = "current" | "recent";

/** What a dashboard row can do. Implemented in dash-actions.ts, so the section
 *  templates stay pure functions of (ctx) and never import the sessions view. */
export interface DashActions {
  newChat(anchor: HTMLElement, initialMessage?: string): void;
  openIn(anchor: HTMLElement, kind: "vscode" | "terminal" | "explorer"): void;
  openChat(sessionId: string): void;
  openHistory(sessionId: string): void;
  openDraft(draftId: string, sessionId: string | null): void;
  openFile(path: string): void;
  openUrl(url: string): void;
  openAllHistory(): void;
  toggleTodo(todo: DashTodo): void;
  refreshCard(id: string): void;
  openKebab(anchor: HTMLElement): void;
  setRepo(cwd: string | null): void;
  setTab(tab: ReportsTab): void;
  openImage(id: string): void;
  setPage(key: string, page: number): void;
  setChatsTab(tab: ChatsTab): void;
  /** Full-size view of the Reports card's current tab. */
  openReportsModal(): void;
}

export interface DashCtx {
  snap: DashSnapshot;
  history: DashboardHistory | null;
  /** Selected repo of a group dashboard; null means "All". */
  repo: string | null;
  tab: ReportsTab;
  /** Gallery data URLs by image id; "failed" once a load errored. */
  images: Map<string, string>;
  refreshing: Set<string>;
  doneTodos: Set<string>;
  /** Current page per paged card, keyed by the pager's name. */
  pages: Map<string, number>;
  chatsTab: ChatsTab;
  /** Index of the first quick-action chip showing in the one-line track. */
  qaStart: number;
  /** Called after every paint; the Reports modal redraws from it while open. */
  paintHooks: Set<() => void>;
  nowMs: number;
  act: DashActions;
}

export const isGroup = (c: DashCtx): boolean => c.snap.target.kind === "group";

export const inRepo = (c: DashCtx, cwd: string): boolean => !c.repo || sameCwd(c.repo, cwd);

export const hidden = (c: DashCtx, id: string): boolean => c.snap.hidden_builtins.includes(id);

export function repoName(c: DashCtx, cwd: string): string {
  const r: RepoRef | undefined = c.snap.target.repos.find((x) => sameCwd(x.cwd, cwd));
  return r?.name ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** A repo tag on a row, only where it carries information: a group showing every repo. */
export function repoTag(c: DashCtx, cwd: string): TemplateResult | typeof nothing {
  if (!isGroup(c) || c.repo) return nothing;
  return html`<span class="pd-repo">${repoName(c, cwd)}</span>`;
}

export const icon = (name: string): TemplateResult => html`<i class="ph ph-${name} pd-ic"></i>`;

export type DotKind = "q" | "w" | "ok" | "idle";
export const dot = (kind: DotKind): TemplateResult => html`<span class="pd-dot ${kind}"></span>`;

export interface RowOpts {
  onClick?: () => void;
  title?: string;
  dim?: boolean;
  meta?: string;
  tag?: TemplateResult | typeof nothing;
  trailing?: TemplateResult | typeof nothing;
}

export function row(lead: TemplateResult, text: TemplateResult | string, o: RowOpts = {}): TemplateResult {
  return html`<div class="pd-row ${o.onClick ? "is-link" : ""} ${o.dim ? "is-dim" : ""}" title=${ifDefined(o.title)} @click=${o.onClick}>
    ${lead}<span class="pd-t">${text}</span>${o.tag ?? nothing}${o.trailing ?? nothing}${o.meta ? html`<span class="pd-m">${o.meta}</span>` : nothing}
  </div>`;
}

export const quiet = (text: string): TemplateResult => html`<div class="pd-quiet">${text}</div>`;

export const sub = (text: string): TemplateResult => html`<div class="pd-sub">${text}</div>`;

export interface CardOpts {
  full?: boolean;
  id: string;
  /** Extra class on the section. */
  cls?: string;
  trailing?: TemplateResult | typeof nothing;
}

export function card(title: string, body: TemplateResult | TemplateResult[], o: CardOpts): TemplateResult {
  return html`<section class="pd-card ${o.full ? "full" : ""} ${o.cls ?? ""}" data-pd-card=${o.id}>
    <div class="pd-h"><span>${title}</span><span class="grow"></span>${o.trailing ?? nothing}</div>
    ${body}
  </section>`;
}

export const kv = (k: string, v: TemplateResult | string, cls = ""): TemplateResult =>
  html`<div class="pd-kv"><span class="k">${k}</span><span class=${cls}>${v}</span></div>`;
