// Dashboard header (face, name, branch or repo chips, New chat, kebab) and the
// quick-action chip row.
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { renderAvatar } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { sameCwd } from "./format";
import { hidden, isGroup, type DashCtx } from "./dash-parts";

function face(c: DashCtx): TemplateResult {
  const t = c.snap.target;
  if (t.kind === "group") return html`<div class="pd-face"><i class="ph ph-briefcase"></i></div>`;
  const cwd = t.repos[0]?.cwd;
  const avatar = getSettings()?.projects?.find((p) => cwd && sameCwd(p.path, cwd))?.avatar;
  return html`<div class="pd-face">${unsafeHTML(renderAvatar(avatar, cwd))}</div>`;
}

function sublineSingle(c: DashCtx): TemplateResult | typeof nothing {
  const s = c.snap.ship[0];
  if (!s) return nothing;
  const arrows = `${s.ahead > 0 ? ` ↑${s.ahead}` : ""}${s.behind > 0 ? ` ↓${s.behind}` : ""}`;
  return html`<code class="pd-branch">${s.branch}${arrows}</code>`;
}

function repoChips(c: DashCtx): TemplateResult {
  const chip = (label: string, cwd: string | null): TemplateResult => html`
    <button type="button" class="pd-repo-chip ${c.repo === cwd ? "on" : ""}" @click=${() => c.act.setRepo(cwd)}>${label}</button>`;
  return html`<span class="pd-repos">${chip("All", null)}${c.snap.target.repos.map((r) => chip(r.name, r.cwd))}</span>`;
}

export function header(c: DashCtx): TemplateResult {
  return html`<div class="pd-head">
    ${face(c)}
    <div class="pd-titles">
      <h3>${c.snap.target.name}</h3>
      <div class="pd-subline">${isGroup(c) ? repoChips(c) : sublineSingle(c)}</div>
    </div>
    <span class="grow"></span>
    <button type="button" class="pd-btn primary" @click=${(e: Event) => c.act.newChat(e.currentTarget as HTMLElement)}>
      <i class="ph ph-plus"></i>New chat</button>
    <button type="button" class="pd-ib" title="More" @click=${(e: Event) => c.act.openKebab(e.currentTarget as HTMLElement)}>
      <i class="ph ph-dots-three-vertical"></i></button>
  </div>`;
}

export function quickActions(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "quick_actions")) return nothing;
  const slash = (c.history?.quick_actions ?? []).map((q, i) => html`
    <button type="button" class="pd-chip" title="${q.count} uses in the last 30 days"
      @click=${(e: Event) => c.act.newChat(e.currentTarget as HTMLElement, q.command)}>
      ${i === 0 ? html`<i class="ph ph-lightning"></i>` : nothing}${q.command}</button>`);
  const open = (kind: "vscode" | "terminal" | "explorer", ic: string, label: string): TemplateResult => html`
    <button type="button" class="pd-chip plain" @click=${(e: Event) => c.act.openIn(e.currentTarget as HTMLElement, kind)}>
      <i class="ph ph-${ic}"></i>${label}</button>`;
  return html`<div class="pd-qa">
    ${slash}${slash.length ? html`<span class="pd-vsep"></span>` : nothing}
    ${open("vscode", "code", "VS Code")}${open("terminal", "terminal-window", "Terminal")}${open("explorer", "folder-open", "Explorer")}
  </div>`;
}
