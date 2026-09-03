import "./change-character-modal.css";
import "./modal.css";
import { api } from "./api";
import type { Character } from "./api";
import { escapeHtml } from "./escape-html";
import { getCharacterIconUrl, cachedCharacterIconUrl } from "./character-icon";
import { playCharacterSelectSound, cancelCharacterSelectSound } from "./character-select-sound";
import { lockInputToHost } from "./modal-input-lock";

export async function openChangeCharacterModal(opts: {
  projectId: string;
  currentId: string | null;
  /** Ids the "Random" action should skip (e.g. characters already showing on
   * other live sessions), on top of always skipping `currentId`. */
  excludeIds?: string[];
}): Promise<string | null> {
  const { projectId, currentId, excludeIds = [] } = opts;

  return new Promise<string | null>((resolve) => {
    // --- state ---
    type Tab = "whitelisted" | "all";
    let activeTab: Tab = "whitelisted";
    let query = "";
    const cache: Partial<Record<Tab, Character[]>> = {};
    // Icon URLs come from the shared character-icon cache (see character-icon.ts).

    // Clicking a card only stages a pick (and plays its voiceline) - nothing is
    // applied until Save, so the grid doubles as a listening booth.
    let pickedId: string | null = currentId;
    let pickedChar: Character | null = null;

    const overlay = document.createElement("div");
    overlay.className = "cc-modal-overlay";

    const unlock = lockInputToHost(overlay);

    function close(result: string | null) {
      unlock();
      cancelCharacterSelectSound();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function filterChars(list: Character[]): Character[] {
      if (!query) return list;
      const q = query.toLowerCase();
      return list.filter((c) => c.label.toLowerCase().includes(q));
    }

    /** Fills in the staged pick's label/game once whichever tab holds it loads -
     * `currentId` arrives as a bare id, and a pick made in one tab has to keep
     * its name after switching to the other. */
    function resolvePickedChar() {
      if (!pickedId || pickedChar?.id === pickedId) return;
      for (const list of Object.values(cache)) {
        if (!Array.isArray(list)) continue;
        const found = list.find((c) => c.id === pickedId);
        if (found) { pickedChar = found; return; }
      }
    }

    function pickHtml(): string {
      if (!pickedId) return `<span class="cc-modal-pick-empty">No character selected</span>`;
      const iconUrl = cachedCharacterIconUrl(pickedId);
      const iconHtml = iconUrl
        ? `<img class="cc-modal-pick-icon" src="${escapeHtml(iconUrl)}" alt="">`
        : `<div class="cc-modal-pick-icon cc-modal-pick-icon-ph" data-pick-icon-ph="${escapeHtml(pickedId)}"><i class="ph ph-question"></i></div>`;
      const label = pickedChar?.label ?? pickedId;
      const game = pickedChar?.game_label
        ? `<span class="cc-modal-pick-game">${escapeHtml(pickedChar.game_label)}</span>`
        : "";
      return `${iconHtml}<span class="cc-modal-pick-name">${escapeHtml(label)}</span>${game}`;
    }

    /** In-place refresh of everything the staged pick drives. Never a full
     * renderBody(): that rebuilds the grid and throws away the body's scroll
     * position, which clicking a card halfway down the list would jump. */
    function renderPick() {
      resolvePickedChar();
      const pickEl = overlay.querySelector<HTMLElement>(".cc-modal-pick");
      if (pickEl) {
        pickEl.innerHTML = pickHtml();
        hydratePickIcon();
      }
      overlay.querySelectorAll<HTMLElement>(".cc-char-card").forEach((card) => {
        card.classList.toggle("selected", card.dataset.charId === pickedId);
      });
      const save = overlay.querySelector<HTMLButtonElement>(".cc-modal-save");
      if (save) save.disabled = !pickedId;
    }

    /** The header portrait loads independently of the grid's lazy loader, since
     * the staged character may be filtered out of the visible list entirely. */
    function hydratePickIcon() {
      const id = pickedId;
      if (!id) return;
      const ph = overlay.querySelector<HTMLElement>(`[data-pick-icon-ph="${CSS.escape(id)}"]`);
      if (!ph) return;
      void getCharacterIconUrl(id).then((url) => {
        if (!url || pickedId !== id || !ph.isConnected) return;
        const img = document.createElement("img");
        img.className = "cc-modal-pick-icon";
        img.src = url;
        img.alt = "";
        ph.replaceWith(img);
      });
    }

    function stagePick(char: Character | null, id: string) {
      pickedId = id;
      pickedChar = char;
      playCharacterSelectSound(id);
      renderPick();
    }

    function renderBody() {
      // cache[tab] may be: undefined (not started), the "__loading__" sentinel
      // (in flight, see loadTab), or the resolved Character[]. Only a real array
      // is renderable; everything else means "still loading".
      const tabData = cache[activeTab];
      const ready = Array.isArray(tabData);
      const loading = !ready;
      const filtered = ready ? filterChars(tabData) : [];
      resolvePickedChar();

      let bodyHtml: string;
      if (loading) {
        bodyHtml = `<div class="cc-modal-loading">Loading...</div>`;
      } else if (filtered.length === 0) {
        bodyHtml = `<div class="cc-modal-empty">No characters found.</div>`;
      } else {
        const cards = filtered.map((c) => {
          const iconUrl = cachedCharacterIconUrl(c.id);
          let iconHtml: string;
          if (iconUrl) {
            iconHtml = `<img class="cc-char-icon" src="${escapeHtml(iconUrl)}" alt="" data-char-icon="${escapeHtml(c.id)}">`;
          } else {
            iconHtml = `<div class="cc-char-icon-placeholder" data-char-icon-ph="${escapeHtml(c.id)}"><i class="ph ph-question"></i></div>`;
          }
          const gameLabel = c.game_label
            ? `<span class="cc-char-game">${escapeHtml(c.game_label)}</span>`
            : "";
          return `<button class="cc-char-card${c.id === pickedId ? " selected" : ""}" data-char-id="${escapeHtml(c.id)}" type="button">
            ${iconHtml}
            <span class="cc-char-label">${escapeHtml(c.label)}</span>
            ${gameLabel}
          </button>`;
        });
        bodyHtml = `<div class="cc-char-grid">${cards.join("")}</div>`;
      }

      overlay.innerHTML = `
        <div class="cc-modal-card" role="dialog" aria-modal="true" aria-label="Change character">
          <div class="cc-modal-header">
            <div class="cc-modal-heading">
              <span class="cc-modal-eyebrow">Change character</span>
              <div class="cc-modal-pick">${pickHtml()}</div>
            </div>
            <div class="cc-modal-header-actions">
              <button type="button" class="cc-modal-random"${loading ? " disabled" : ""}><i class="ph ph-shuffle"></i> Random</button>
              <button type="button" class="cc-modal-close" title="Close"><i class="ph ph-x"></i></button>
            </div>
          </div>
          <div class="cc-modal-search-row">
            <div class="cc-modal-search-wrap">
              <i class="ph ph-magnifying-glass cc-modal-search-icon"></i>
              <input type="text" class="cc-modal-search" placeholder="Search..." value="${escapeHtml(query)}" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div class="cc-modal-tabs">
            <button type="button" class="cc-modal-tab${activeTab === "whitelisted" ? " active" : ""}" data-tab="whitelisted">Whitelisted</button>
            <button type="button" class="cc-modal-tab${activeTab === "all" ? " active" : ""}" data-tab="all">All</button>
          </div>
          <div class="cc-modal-body">${bodyHtml}</div>
          <div class="cc-modal-footer">
            <button type="button" class="btn btn-secondary cc-modal-cancel">Cancel</button>
            <button type="button" class="btn btn-primary cc-modal-save"${pickedId ? "" : " disabled"}>Save</button>
          </div>
        </div>
      `;

      attachHandlers();
      hydratePickIcon();

      // Focus the search input, preserve cursor position
      const searchEl = overlay.querySelector<HTMLInputElement>(".cc-modal-search");
      if (searchEl) {
        searchEl.focus();
        const len = searchEl.value.length;
        searchEl.setSelectionRange(len, len);
      }

      // Kick off lazy icon loads for characters that don't have icons cached yet.
      // The shared cache de-dupes concurrent/repeat requests, so we just skip any
      // id already resolved (it rendered as an <img> above) and patch the rest.
      if (tabData) {
        for (const c of filtered) {
          if (cachedCharacterIconUrl(c.id)) continue;
          void getCharacterIconUrl(c.id).then((url) => {
            if (!url) return; // no icon - leave the placeholder
            // Patch the DOM directly (avoid full re-render)
            const ph = overlay.querySelector<HTMLElement>(`[data-char-icon-ph="${CSS.escape(c.id)}"]`);
            if (ph) {
              const img = document.createElement("img");
              img.className = "cc-char-icon";
              img.src = url;
              img.alt = "";
              img.dataset.charIcon = c.id;
              ph.replaceWith(img);
            }
          });
        }
      }
    }

    /** Stages a pick from whatever the active tab has loaded, skipping the
     * staged/current id and `excludeIds`; falls back to just skipping the staged
     * id, then to the full list, mirroring the new-session character pane's own
     * reroll cascade. Rerollable - it no longer closes the modal. */
    function pickRandom() {
      const tabData = cache[activeTab];
      if (!Array.isArray(tabData) || tabData.length === 0) return;
      const excluded = new Set(excludeIds);
      if (currentId) excluded.add(currentId);
      if (pickedId) excluded.add(pickedId);
      let candidates = tabData.filter((c) => !excluded.has(c.id));
      if (candidates.length === 0) candidates = tabData.filter((c) => c.id !== pickedId);
      if (candidates.length === 0) candidates = tabData;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      if (pick) stagePick(pick, pick.id);
    }

    function attachHandlers() {
      overlay.querySelector<HTMLButtonElement>(".cc-modal-close")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>(".cc-modal-cancel")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>(".cc-modal-save")?.addEventListener("click", () => close(pickedId));
      overlay.querySelector<HTMLButtonElement>(".cc-modal-random")?.addEventListener("click", pickRandom);

      overlay.querySelector<HTMLInputElement>(".cc-modal-search")?.addEventListener("input", (e) => {
        query = (e.target as HTMLInputElement).value;
        renderBody();
      });

      overlay.querySelectorAll<HTMLButtonElement>(".cc-modal-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tab = btn.dataset.tab as Tab;
          if (!tab) return;
          activeTab = tab;
          renderBody();
          // Trigger load if not yet cached
          loadTab(tab);
        });
      });

      overlay.querySelectorAll<HTMLButtonElement>(".cc-char-card").forEach((btn) => {
        btn.addEventListener("click", () => {
          const charId = btn.dataset.charId;
          if (!charId) return;
          const list = cache[activeTab];
          stagePick(Array.isArray(list) ? list.find((c) => c.id === charId) ?? null : null, charId);
        });
      });
    }

    function loadTab(tab: Tab) {
      if (cache[tab] !== undefined) return; // already loaded or loading
      // Set to a sentinel so we don't double-load, but keep showing "Loading..."
      // We use undefined = not started, so we need a different signal.
      // Use a local promise pattern: mark as "in progress" by storing empty array temporarily.
      // We'll use null as "loading" - but type is Character[] | undefined. Re-key:
      // Actually just fire the async load and re-render when done.
      const loader = tab === "whitelisted"
        ? api.resolveWhitelistCharacters(projectId)
        : api.listCharacters();

      // Store a temporary marker so we don't double-trigger
      (cache as Record<string, unknown>)[tab] = "__loading__";

      loader.then((chars) => {
        cache[tab] = chars;
        // Pre-seed icon cache entries for already-known URLs
        // (The per-card lazy load below will fill them in)
        if (activeTab === tab) renderBody();
        else renderPick();
      }).catch((err) => {
        console.error("[change-character-modal] failed to load tab", tab, err);
        cache[tab] = [];
        if (activeTab === tab) renderBody();
      });
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter" && pickedId) {
        e.preventDefault();
        close(pickedId);
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);

    // Initial render + first tab load
    renderBody();
    loadTab("whitelisted");
  });
}
