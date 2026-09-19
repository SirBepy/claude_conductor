import { html, render, type TemplateResult } from "lit-html";
import { api, type Character, type CharacterSlot } from "../../shared/api";
import { loadCharacters } from "../../shared/characters";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { showView } from "../../shared/navigation";
import { showToast } from "../../shared/toast";
import "./character-detail.css";

export const ALL_SLOTS: CharacterSlot[] = [
  "work_finished",
  "question_asked",
  "ready",
  "select",
  "annoyed",
  "death",
];

const SLOT_ICONS: Record<CharacterSlot, string> = {
  work_finished: "ph-check-circle",
  question_asked: "ph-question",
  ready: "ph-play-circle",
  select: "ph-cursor-click",
  annoyed: "ph-smiley-meh",
  death: "ph-skull",
};

/** Fixed-size avatar box shared by the card grid and this view's hero: a
 *  first-letter tile shows by default, the real art fades in over it once its
 *  src loads. Box overflow is clipped so a never-resolved image can never
 *  spill alt text past its border - the bug this replaces. */
export function characterAvatarBox(c: Character, boxClass: string, imgClass: string): TemplateResult {
  const letter = c.label.trim().charAt(0).toUpperCase() || "?";
  return html`
    <div class="${boxClass}">
      <div class="char-avatar-fallback" aria-hidden="true">${letter}</div>
      <img
        class="${imgClass}"
        data-character-id="${c.id}"
        alt="${c.label}"
        @load=${(e: Event) => (e.target as HTMLImageElement).classList.add("loaded")}
        @error=${(e: Event) => (e.target as HTMLImageElement).classList.remove("loaded")}
      />
    </div>
  `;
}

let currentCharacterId: string | null = null;

let activeFile: string | null = null;
let activeRoot: HTMLElement | null = null;
let activeChar: Character | null = null;

// One-shot "pop" settle when playback ends on its own (not on manual stop) -
// the peak-moment reward, cleared after the CSS animation finishes.
let justEnded = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function clearSettleTimer(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

export function openCharacterDetail(id: string): void {
  void api.stopCharacterPreview();
  activeFile = null;
  justEnded = false;
  clearSettleTimer();
  currentCharacterId = id;
  showView("character-detail");
}

function rerender(): void {
  if (activeRoot && activeChar) {
    render(detailTemplate(activeChar), activeRoot);
  }
}

function togglePlay(file: string, charId: string): void {
  if (activeFile === file) {
    activeFile = null;
    rerender();
    void api.stopCharacterPreview();
    return;
  }
  clearSettleTimer();
  justEnded = false;
  activeFile = file;
  rerender();
  void api.previewCharacterFile(charId, file).catch((e) => {
    console.error("[char-detail] preview failed", e);
    showToast(`Couldn't play ${file.split("/").pop()}`);
    activeFile = null;
    rerender();
  });
}

function formatSlot(slot: string): string {
  return slot.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function detailTemplate(c: Character): TemplateResult {
  const isPlaying = activeFile !== null;
  const avatarBoxClass = `char-detail-avatar-box${isPlaying ? " playing" : ""}${justEnded ? " pop-settle" : ""}`;
  return html`
    <div class="view view-character-detail">
      <div class="view-header">
        <button
          class="icon-btn"
          title="Back"
          @click=${() => {
            void api.stopCharacterPreview();
            activeFile = null;
            showView("characters");
          }}
        >
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>${c.label}</h2>
        <div class="char-detail-header-spacer"></div>
      </div>
      <div class="view-body">
        <div class="char-detail-hero">
          ${characterAvatarBox(c, avatarBoxClass, "char-avatar char-detail-avatar")}
          ${c.game_label || c.game
            ? html`<div class="char-detail-game-chip">${c.game_label ?? c.game}</div>`
            : ""}
          <div class="char-detail-sub">${c.id} · v${c.version}</div>
        </div>
        <div class="section">
          <div class="section-title">Slots</div>
          ${ALL_SLOTS.map((slot) => {
            const files = c.slots[slot] ?? [];
            const filled = files.length > 0;
            return html`
              <div class="char-slot-row">
                <i class="ph ${SLOT_ICONS[slot]} char-slot-icon${filled ? " filled" : ""}"></i>
                <div class="char-slot-name">${formatSlot(slot)}</div>
                <div class="char-slot-files">
                  ${!filled
                    ? html`<span class="char-slot-empty">(empty)</span>`
                    : files.map((f) => {
                        const isPlaying = activeFile === f;
                        return html`
                          <button
                            class="char-play-btn ${isPlaying ? "playing v-pulse" : ""}"
                            aria-pressed="${isPlaying ? "true" : "false"}"
                            @click=${() => togglePlay(f, c.id)}
                          >
                            <i class="ph ${isPlaying ? "ph-pause" : "ph-play"}"></i>
                            ${f.split("/").pop()}
                          </button>
                        `;
                      })}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

export async function renderCharacterDetailView(root: HTMLElement): Promise<() => void> {
  const id = currentCharacterId;
  if (!id) {
    showView("characters");
    return () => {};
  }

  activeRoot = root;

  render(
    html`
      <div class="view view-character-detail">
        <div class="view-header">
          <button
            class="icon-btn"
            @click=${() => {
              void api.stopCharacterPreview();
              activeFile = null;
              showView("characters");
            }}
          >
            <i class="ph ph-arrow-left"></i>
          </button>
          <h2>Loading...</h2>
          <div class="char-detail-header-spacer"></div>
        </div>
        <div class="view-body"></div>
      </div>
    `,
    root,
  );

  const chars = await loadCharacters();
  const c = chars.find((x) => x.id === id);
  if (!c) {
    activeRoot = null;
    showView("characters");
    return () => {};
  }

  activeChar = c;
  render(detailTemplate(c), root);
  await hydrateCharacterAvatars(root);

  const unlisten = api.onCharacterPreviewEnded(() => {
    activeFile = null;
    justEnded = true;
    rerender();
    clearSettleTimer();
    settleTimer = setTimeout(() => {
      justEnded = false;
      settleTimer = null;
      rerender();
    }, 200);
  });

  return () => {
    void api.stopCharacterPreview();
    activeFile = null;
    justEnded = false;
    clearSettleTimer();
    activeRoot = null;
    activeChar = null;
    unlisten();
  };
}
