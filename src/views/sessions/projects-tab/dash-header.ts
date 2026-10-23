// Dashboard header (face, name, branch or repo chips, kebab), the New chat
// FAB, and the one-line quick-action chip row.
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { renderAvatar } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { isRemote } from "../../../shared/transport";
import { offerableCommands, sameCwd } from "./format";
import { moveTrack } from "./quick-track";
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
    ${/* The kebab opens apps on the PC and edits the dashboard's configuration, so the phone has none of it. */
      isRemote() ? nothing : html`<button type="button" class="pd-ib" title="More" data-pd-kebab
        @click=${(e: Event) => c.act.openKebab(e.currentTarget as HTMLElement)}><i class="ph ph-dots-three-vertical"></i></button>`}
  </div>`;
}

/** New chat as a floating button, bottom right of the pane (pd-dashboard.css
 *  docks it). */
export function newChatFab(c: DashCtx): TemplateResult {
  return html`<div class="pd-fab-dock"><button type="button" class="pd-fab" title="New chat" aria-label="New chat"
    @click=${(e: Event) => c.act.newChat(e.currentTarget as HTMLElement)}><i class="ph ph-plus"></i></button></div>`;
}

/** The pinned slash commands when the project has a list; until it does, the commands used most.
 *  The daemon always sends `pinned_actions`, empty when nothing is pinned, so emptiness is the test. */
export function chipCommands(c: DashCtx): string[] {
  const pinned = c.snap.pinned_actions ?? [];
  return offerableCommands(pinned.length ? pinned : (c.history?.quick_actions ?? []).map((q) => q.command));
}

export function quickActions(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "quick_actions")) return nothing;
  const cmds = chipCommands(c);
  if (!cmds.length) return nothing;
  const arrow = (dir: 1 | -1, ic: string): TemplateResult => html`
    <button type="button" class="pd-ib sm pd-qa-btn" data-pd-qa-dir=${dir} title=${dir === 1 ? "Next actions" : "Previous actions"}
      @click=${(e: Event) => { c.qaStart = moveTrack((e.currentTarget as HTMLElement).closest<HTMLElement>(".pd-qa")!, c.qaStart, dir); }}>
      <i class="ph ph-${ic}"></i></button>`;
  return html`<div class="pd-qa">
    ${arrow(-1, "caret-left")}
    <div class="pd-qa-track"><div class="pd-qa-strip">${cmds.map((cmd) => html`
      <button type="button" class="pd-chip" @click=${(e: Event) => c.act.newChat(e.currentTarget as HTMLElement, cmd)}>${cmd}</button>`)}
    </div></div>
    ${arrow(1, "caret-right")}
  </div>`;
}
