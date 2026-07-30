import { html, render, type TemplateResult } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { loadCharacters, invalidateCharactersCache, slotFillCount } from "../../shared/characters";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { api, type Character } from "../../shared/api";
import { openCharacterDetail } from "./character-detail";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";
import "../../shared/kebab-menu.css";
import "./characters.css";

interface GameGroup {
  key: string;
  label: string;
  chars: Character[];
}

function groupByGame(chars: Character[]): GameGroup[] {
  const map = new Map<string, GameGroup>();
  for (const c of chars) {
    const key = c.game ?? "other";
    const label = c.game_label ?? c.game ?? "Other";
    if (!map.has(key)) map.set(key, { key, label, chars: [] });
    map.get(key)!.chars.push(c);
  }
  return Array.from(map.values());
}

function cardTemplate(c: Character): TemplateResult {
  const { filled, total } = slotFillCount(c);
  return html`
    <div class="char-card" @click=${() => openCharacterDetail(c.id)}>
      <img class="char-avatar char-card-avatar" data-character-id="${c.id}" alt="${c.label}" />
      <div class="char-card-name">${c.label}</div>
      <div class="char-card-count">${filled}/${total}</div>
    </div>
  `;
}

function groupTemplate(g: GameGroup): TemplateResult {
  return html`
    <details class="char-group" open>
      <summary class="char-group-summary">
        <i class="ph ph-caret-right char-group-chevron"></i>
        ${g.label}
        <span class="char-group-count">${g.chars.length}</span>
      </summary>
      <div class="char-group-grid">
        ${g.chars.map(cardTemplate)}
      </div>
    </details>
  `;
}

async function refresh(list: HTMLElement): Promise<void> {
  const chars = await loadCharacters();
  if (chars.length === 0) {
    render(
      html`<div class="no-data">No characters installed. Run <code>/character-creator &lt;name&gt;</code> in Claude Code to make one.</div>`,
      list,
    );
    return;
  }
  const groups = groupByGame(chars);
  render(
    html`${groups.map(groupTemplate)}`,
    list,
  );
  await hydrateCharacterAvatars(list);
}

export async function renderCharactersView(root: HTMLElement): Promise<() => void> {
  render(
    html`
      <div class="view view-characters">
        <div class="view-header">
          <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
            <i class="ph ph-list"></i>
          </button>
          <h2>Characters</h2>
          <div class="view-header-actions">
            <div class="menu-anchor">
              <button class="icon-btn" id="characters-more" title="More options">
                <i class="ph ph-dots-three-vertical"></i>
              </button>
              <div class="menu-popover hidden" id="characters-menu">
                <button class="menu-item" id="characters-refresh">
                  <i class="ph ph-arrow-clockwise"></i> Refresh
                </button>
                <button class="menu-item" id="characters-open-folder">
                  <i class="ph ph-folder-open"></i> Open folder
                </button>
                <button class="menu-item" id="characters-create-new">
                  <i class="ph ph-plus"></i> New character
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="view-body">
          <div id="characters-list"></div>
        </div>
      </div>
    `,
    root,
  );

  const list = root.querySelector<HTMLElement>("#characters-list")!;
  const moreBtn = root.querySelector<HTMLButtonElement>("#characters-more")!;
  const menu = root.querySelector<HTMLElement>("#characters-menu")!;

  const disposeMenu = wireKebabMenu(moreBtn, menu);

  root.querySelector<HTMLButtonElement>("#characters-refresh")!.onclick = () => {
    closeKebabMenu(menu);
    invalidateCharactersCache();
    void refresh(list);
  };

  root.querySelector<HTMLButtonElement>("#characters-open-folder")!.onclick = async () => {
    closeKebabMenu(menu);
    const dir = await api.getCharactersDir();
    await api.openInExplorer(dir);
  };

  root.querySelector<HTMLButtonElement>("#characters-create-new")!.onclick = () => {
    closeKebabMenu(menu);
    alert(
      "To make a new character, run this in Claude Code:\n\n  /character-creator <name>\n\nThe skill searches sprite + sound sources, downloads candidates, and asks you to pick which go into each slot.",
    );
  };

  await refresh(list);

  return () => {
    disposeMenu();
  };
}
