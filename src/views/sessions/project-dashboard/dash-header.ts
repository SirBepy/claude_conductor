// The standalone page's header (back, face, name, branch or repo count, menu)
// and the one-line quick-action chip row. A new-chat draft has no header of
// its own: the chat header above it already names the project.
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { renderAvatar } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { isRemote } from "../../../shared/transport";
import { offerableCommands, sameCwd } from "./format";
import { onTrackScroll, onTrackWheel } from "./quick-track";
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

export function header(c: DashCtx): TemplateResult {
  return html`<div class="pd-head">
    <button type="button" class="pd-ib" title="Back" data-pd-back @click=${() => c.act.back()}><i class="ph ph-arrow-left"></i></button>
    ${face(c)}
    <div class="pd-titles">
      <h3>${c.snap.target.name}</h3>
      <div class="pd-subline">${isGroup(c) ? html`<span>${c.snap.target.repos.length} repos</span>` : sublineSingle(c)}</div>
    </div>
    <span class="grow"></span>
    ${/* Every project action opens an app on the PC or edits this PC's config, so the phone has no menu. */
      isRemote() ? nothing : html`<button type="button" class="pd-ib" title="More" data-pd-kebab
      @click=${(e: Event) => c.act.openMenu(e.currentTarget as HTMLElement)}><i class="ph ph-dots-three-vertical"></i></button>`}
  </div>`;
}

/** The pinned slash commands when the project has a list; until it does, the commands used most.
 *  The daemon always sends `pinned_actions`, empty when nothing is pinned, so emptiness is the test. */
export function chipCommands(c: DashCtx): string[] {
  const pinned = c.snap.pinned_actions ?? [];
  return offerableCommands(pinned.length ? pinned : (c.history?.quick_actions ?? []).map((q) => q.command));
}

/** The chip row. On the standalone page "+ New chat" leads it and stays when
 *  the commands are hidden, since it is the page's only way to start a plain
 *  chat; inside a draft the chat is already being started, so it is left out. */
export function quickActions(c: DashCtx, withNewChat: boolean): TemplateResult | typeof nothing {
  const cmds = hidden(c, "quick_actions") ? [] : chipCommands(c);
  if (!withNewChat && !cmds.length) return nothing;
  const lead = withNewChat ? html`<button type="button" class="pd-chip" data-pd-new-chat
      @click=${(e: Event) => c.act.runCommand(e.currentTarget as HTMLElement)}>+ New chat</button>` : nothing;
  return html`<div class="pd-qa"><div class="pd-qa-track" @scroll=${onTrackScroll} @wheel=${onTrackWheel}>${lead}${cmds.map((cmd) => html`
    <button type="button" class="pd-chip" data-pd-chip=${cmd} @click=${(e: Event) => c.act.runCommand(e.currentTarget as HTMLElement, cmd)}>${cmd}</button>`)}
  </div></div>`;
}
