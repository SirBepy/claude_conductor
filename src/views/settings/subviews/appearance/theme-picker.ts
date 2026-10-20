// Settings > Appearance theme picker: a live preview of chat UI on top, a
// Dark / Light switch, and a two-column list of named palettes per group.
// Hovering or focusing a palette repaints only the preview; clicking it
// applies the theme.

import { html, render } from "lit-html";
import { SIRBEPY_PALETTES } from "../../../../../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default";
import type { PaletteDef } from "../../../../../vendor/tauri_kit/frontend/settings/pages/theme";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings, setSettings } from "../../../../shared/state";
import { applyAppearance } from "../../../../shared/theme-sync";
// The preview's bubbles are the real chat classes. Settings can open before
// the Chats view has ever loaded its CSS in this window, so pull them in here.
import "../../../../shared/chat/chat-messages.css";
import "../../../../shared/chat/chat-messages-user.css";
import "../../../../shared/chat/chat-messages-assistant.css";
import "../../../../shared/chat/chat-messages-markdown.css";
import "./theme-picker.css";

interface Choice { id: string; light: boolean }

function parse(fullId: string | undefined): Choice {
  const id = fullId || "void";
  const light = id.endsWith("-light");
  return { id: light ? id.slice(0, -"-light".length) : id, light };
}

const fullId = (c: Choice): string => (c.light ? `${c.id}-light` : c.id);
const byId = (id: string): PaletteDef =>
  SIRBEPY_PALETTES.find((p) => p.id === id) ?? (SIRBEPY_PALETTES[0] as PaletteDef);

/** Palettes bucketed by `group`, in list order. */
function groups(): Array<[string, PaletteDef[]]> {
  const out: Array<[string, PaletteDef[]]> = [];
  for (const p of SIRBEPY_PALETTES) {
    const name = p.group ?? "";
    const last = out[out.length - 1];
    if (last && last[0] === name) last[1].push(p);
    else out.push([name, [p]]);
  }
  return out;
}

export function themePickerSection() {
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Theme</div>
      <div id="themePicker"></div>
    </div>
  `;
}

export function hydrateThemePicker(): void {
  const host = document.getElementById("themePicker");
  if (!host) return;
  // Settings not fetched yet: fall back to what boot already painted.
  const root = document.documentElement.dataset;
  let committed = parse(
    (getSettings().theme as string | undefined)
      ?? (root.theme && (root.mode === "light" ? `${root.theme}-light` : root.theme)),
  );
  // The palette the preview shows: the hovered/focused dot, else the committed one.
  let previewId: string | null = null;

  const commit = (next: Choice): void => {
    committed = next;
    previewId = null;
    const s = getSettings();
    s.theme = fullId(next);
    setSettings(s);
    applyAppearance(s);
    saveSettings();
    draw();
  };

  const preview = (id: string | null): void => {
    previewId = id;
    draw();
  };

  const draw = (): void => {
    const shown = byId(previewId ?? committed.id);
    const mode = committed.light ? "light" : "dark";
    render(html`
      <div class="tp-preview" data-theme=${shown.id} data-mode=${mode} aria-hidden="true">
        <div class="tp-pv-rail">
          <div class="tp-pv-row is-active"><span class="tp-pv-avatar"></span><span class="tp-pv-text"><b>Theme picker</b><small>claude_usage</small></span></div>
          <div class="tp-pv-row"><span class="tp-pv-avatar is-busy"></span><span class="tp-pv-text"><b>Release notes</b><small>zng-app</small></span></div>
          <div class="tp-pv-row"><span class="tp-pv-avatar"></span><span class="tp-pv-text"><b>Log rotation</b><small>countoff</small></span></div>
        </div>
        <div class="tp-pv-pane">
          <div class="tp-pv-head"><b>Theme picker</b><span class="tp-pv-chip"><i class="ph ph-git-branch"></i>master</span></div>
          <div class="tp-pv-msgs">
            <div class="msg user">make the picker less overwhelming</div>
            <div class="msg assistant">Done: <strong>16 themes</strong>, previewed live in <code>appearance.ts</code>.</div>
          </div>
          <div class="tp-pv-composer"><span>Type a message...</span><i class="ph ph-paper-plane-right"></i></div>
        </div>
      </div>
      <div class="tp-bar">
        <span class="tp-name" id="themeName">${shown.label}</span>
        <div class="tp-seg" role="group" aria-label="Mode" id="themeModeSeg">
          <button type="button" data-mode="dark" aria-pressed=${String(!committed.light)}
            @click=${() => commit({ ...committed, light: false })}><i class="ph ph-moon"></i>Dark</button>
          <button type="button" data-mode="light" aria-pressed=${String(committed.light)}
            @click=${() => commit({ ...committed, light: true })}><i class="ph ph-sun"></i>Light</button>
        </div>
      </div>
      ${groups().map(([name, list]) => html`
        ${name ? html`<div class="tp-group">${name}</div>` : ""}
        <div class="tp-list">
          ${list.map((p) => {
            const s = committed.light ? p.lightSwatch : p.darkSwatch;
            const active = p.id === committed.id;
            // Background, primary, secondary: the three colours that tell palettes apart.
            return html`<button type="button" class="tp-option" data-palette=${p.id}
              aria-label=${`${p.label} theme`} aria-pressed=${String(active)}
              @mouseenter=${() => preview(p.id)} @mouseleave=${() => preview(null)}
              @focus=${() => preview(p.id)} @blur=${() => preview(null)}
              @click=${() => commit({ ...committed, id: p.id })}>
              <span class="tp-swatch">${[s[0], s[2], s[3]].map((c) => html`<span style=${`background:${c}`}></span>`)}</span>
              ${p.label}
            </button>`;
          })}
        </div>
      `)}
    `, host);
  };

  draw();
}
