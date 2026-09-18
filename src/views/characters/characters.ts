import { html, render, type TemplateResult } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { loadCharacters, invalidateCharactersCache, slotFillCount } from "../../shared/characters";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { api, type Character } from "../../shared/api";
import { openCharacterDetail, ALL_SLOTS, characterAvatarBox } from "./character-detail";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";
import { modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel } from "../../shared/modal";
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

/** Six dots naming which slots are filled, with the missing ones spelled out in
 *  the title tooltip - replaces the bare "4/6" count. */
function slotDotsTemplate(c: Character): TemplateResult {
  const { filled: filledCount, total } = slotFillCount(c);
  const filledSet = new Set(ALL_SLOTS.filter((s) => (c.slots[s]?.length ?? 0) > 0));
  const missing = ALL_SLOTS.filter((s) => !filledSet.has(s));
  const title = missing.length === 0
    ? "All slots filled"
    : `Missing: ${missing.map((s) => s.replace(/_/g, " ")).join(", ")}`;
  return html`
    <div class="char-card-dots" title="${title}">
      ${ALL_SLOTS.map((s) => html`<span class="char-dot${filledSet.has(s) ? " filled" : ""}"></span>`)}
      <span class="sr-only">${filledCount} of ${total} slots filled</span>
    </div>
  `;
}

function openDetail(c: Character): void {
  openCharacterDetail(c.id);
}

function cardTemplate(c: Character): TemplateResult {
  return html`
    <div
      class="char-card v-card v-focusable"
      role="button"
      tabindex="0"
      aria-label="${c.label}"
      @click=${() => openDetail(c)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetail(c);
        }
      }}
    >
      ${characterAvatarBox(c, "char-card-avatar-box", "char-avatar char-card-avatar")}
      <div class="char-card-name">${c.label}</div>
      ${slotDotsTemplate(c)}
    </div>
  `;
}

function groupTemplate(g: GameGroup): TemplateResult {
  return html`
    <details class="char-group v-details" open>
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

function skeletonTemplate(): TemplateResult {
  return html`
    <div class="char-group-grid">
      ${Array.from({ length: 6 }, () => html`<div class="char-card-skeleton v-skeleton"></div>`)}
    </div>
  `;
}

function emptyTemplate(): TemplateResult {
  return html`
    <div class="v-empty">
      <i class="ph ph-game-controller v-empty-icon"></i>
      <div class="v-empty-title">No characters yet</div>
      <div class="v-empty-hint">Run <code>/character-creator &lt;name&gt;</code> in Claude Code to make one.</div>
    </div>
  `;
}

/** Themed replacement for the old native alert() - one info card explaining
 *  how to make a character, closed by its button, Escape, or the backdrop. */
function openNewCharacterModal(): void {
  function close(): void {
    document.removeEventListener("keydown", onKey);
    closeHostCard();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  setBackdropCancel(close);
  document.addEventListener("keydown", onKey);
  void presentHostCard(() => {
    render(
      html`
        <div class="modal modal-card" role="dialog" aria-modal="true" aria-label="New character">
          <div class="modal-header">
            <i class="ph ph-plus"></i>
            <h3>New character</h3>
          </div>
          <div class="modal-body">
            <p>Claude can search sprite and sound sources for a new character and let you pick which candidates fill each slot - run this in Claude Code:</p>
            <div class="modal-preview"><code>/character-creator &lt;name&gt;</code></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-primary char-new-modal-ok">Got it</button>
          </div>
        </div>
      `,
      modalCardSlot(),
    );
    const okBtn = modalCardSlot().querySelector<HTMLButtonElement>(".char-new-modal-ok")!;
    okBtn.addEventListener("click", close);
    okBtn.focus();
  });
}

async function refresh(list: HTMLElement): Promise<void> {
  render(skeletonTemplate(), list);
  const chars = await loadCharacters();
  if (chars.length === 0) {
    render(emptyTemplate(), list);
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
    openNewCharacterModal();
  };

  await refresh(list);

  return () => {
    disposeMenu();
  };
}
