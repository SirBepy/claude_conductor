// The Preview tab's static shell, its header (name and version pickers with
// their "newer page" dots) and the empty canvas. Pure DOM from a root plus the
// selection; PreviewTab owns the events.

import { composerFieldHtml } from "../../shared/chat/composer-field";
import { versionsOf } from "./preview-panel-history";
import type { PreviewSelection } from "./preview-panel-selection";

export function renderCanvasEmpty(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLElement>(".pv-canvas");
  if (!canvas) return;
  canvas.innerHTML = `
      <div class="pv-empty">
        <i class="ph ph-monitor-play"></i>
        <p>No previews yet</p>
        <p class="pv-empty-hint">Push one via <code>/preview</code>, or ask the chat AI to show you something.</p>
      </div>
    `;
}

export function renderShell(root: HTMLElement): void {
  root.innerHTML = `
      <header class="pv-head">
        <button type="button" class="pv-pick pv-pick-name" data-act="previews" title="Switch preview" data-single>
          <i class="ph ph-monitor-play"></i><span class="pv-name">No previews yet</span><i class="ph-fill ph-caret-down pv-tri"></i>
        </button>
        <button type="button" class="pv-pick pv-pick-ver" data-act="versions" title="Switch version" hidden>
          <span class="pv-ver">Latest</span><i class="ph-fill ph-caret-down pv-tri"></i>
        </button>
        <span class="pv-grow"></span>
        <button type="button" class="icon-btn" data-act="more" title="More options"><i class="ph ph-dots-three-vertical"></i></button>
      </header>
      <div class="pv-body">
        <div class="pv-canvas"></div>
      </div>
      ${composerFieldHtml({
        rowClass: "composer-field--docked pv-composer",
        inputClass: "pv-composer-input",
        sendClass: "pv-composer-send",
        placeholder: "Message the session that pushed this preview...",
      })}
    `;
  renderCanvasEmpty(root);
}

export function renderHeader(root: HTMLElement, sel: PreviewSelection): void {
  if (!sel.selected) return;
  const selected = sel.selected;
  const nameBtn = root.querySelector<HTMLElement>(".pv-pick-name");
  const verBtn = root.querySelector<HTMLElement>(".pv-pick-ver");
  const nameEl = root.querySelector<HTMLElement>(".pv-name");
  const verEl = root.querySelector<HTMLElement>(".pv-ver");
  if (nameEl) nameEl.textContent = selected.slug;
  // A lone preview has nothing to switch to, so its name is a plain label.
  nameBtn?.toggleAttribute("data-single", sel.snapshots.length <= 1);
  nameBtn?.toggleAttribute("data-new", [...sel.unseenIds].some((id) => id !== selected.id && sel.snapshots.some((s) => s.id === id)));
  const current = sel.snapshots.find((s) => s.id === selected.id);
  const versions = current ? versionsOf(current) : [];
  if (verEl) verEl.textContent = sel.selectedVersion === null ? "Latest" : `v${sel.selectedVersion}`;
  if (verBtn) {
    verBtn.hidden = versions.length === 0;
    verBtn.toggleAttribute("data-new", sel.unseenIds.has(selected.id) && sel.selectedVersion !== null);
  }
}

export function renderHeaderEmpty(root: HTMLElement): void {
  const nameBtn = root.querySelector<HTMLElement>(".pv-pick-name");
  const verBtn = root.querySelector<HTMLElement>(".pv-pick-ver");
  const nameEl = root.querySelector<HTMLElement>(".pv-name");
  if (nameEl) nameEl.textContent = "No previews yet";
  nameBtn?.setAttribute("data-single", "");
  nameBtn?.removeAttribute("data-new");
  // Nothing to open a version list on, so the picker isn't offered.
  if (verBtn) verBtn.hidden = true;
}
