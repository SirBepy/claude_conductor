import { html, render } from "lit-html";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { isRemote } from "../../../../shared/transport";
import { loadSort, saveSort } from "../../../sessions/sessions-helpers";
import type { SessionSort } from "../../../sessions/sessions-helpers";
import {
  EFFORTS, modelDisplayLabel, readGlobalDefault, readModels,
} from "../../../../shared/effort-presets";
import { settingsData } from "../../../sessions/new-session-cache";
import { settingsHeader, toggleRow } from "../../ui";
import "./chat-defaults.css";

/** Parse a comma-separated models string into a trimmed, deduped, non-empty list. */
function parseModels(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function template(models: string[], sort: SessionSort, def: { model: string; effort: string }, chips: boolean) {
  return html`
    <div class="view view-settings-chat-defaults">
      ${settingsHeader("Chat defaults")}
      <div class="view-body">

        ${isRemote()
          ? ""
          : html`<div class="kit-section">
              <div class="kit-section-title">New chats</div>
              <div class="kit-row">
                <span class="kit-row-label">Default model</span>
                <select id="chatDefaultsModel" class="kit-select">
                  ${models.map((m) => html`<option value=${m} ?selected=${m === def.model}>${modelDisplayLabel(m)}</option>`)}
                </select>
              </div>
              <div class="kit-row">
                <span class="kit-row-label">Default effort</span>
                <select id="chatDefaultsEffort" class="kit-select">
                  ${EFFORTS.map((e) => html`<option value=${e} ?selected=${e === def.effort}>${e}</option>`)}
                </select>
              </div>
              <p class="cd-hint">What a new chat opens on. A project can set its own in its project settings.</p>
            </div>`}

        <div class="kit-section">
          <div class="kit-section-title">Behavior</div>
          <div class="kit-row">
            <span class="kit-row-label">Sort chats by</span>
            <select id="chatDefaultsSort" class="kit-select">
              <option value="status" ?selected=${sort === "status"}>Status</option>
              <option value="recent" ?selected=${sort === "recent"}>Recent</option>
              <option value="name" ?selected=${sort === "name"}>Name</option>
              <option value="drain" ?selected=${sort === "drain"}>Token drain</option>
            </select>
          </div>
          ${toggleRow({
            label: "Quick reply chips",
            inputId: "chatDefaultsNextChips",
            checked: chips,
            tooltip: "After a chat finishes a turn, offer one-click replies above the message box, like /close. Click fills the box; Shift+click sends.",
          })}
        </div>

        ${isRemote()
          ? ""
          : html`<div class="kit-section">
              <div class="kit-section-title">Models</div>
              <input
                type="text"
                class="cd-models-input"
                id="chatDefaultsModels"
                .value=${models.join(", ")}
                placeholder="haiku, sonnet, opus"
              >
              <p class="cd-hint">Models offered in the New session picker, comma-separated.</p>
            </div>`}

      </div>
    </div>
  `;
}

export async function renderChatDefaultsView(root: HTMLElement): Promise<() => void> {
  let models = readModels(getSettings());
  const sort = loadSort();
  // The default model may not be in the offered list (a removed custom model): keep it selectable.
  const def = readGlobalDefault(getSettings());
  if (!models.includes(def.model)) models = [...models, def.model];

  // Default on: an absent key resolves to true.
  render(template(models, sort, def, getSettings().nextActionChips !== false), root);

  root.querySelector<HTMLInputElement>("#chatDefaultsNextChips")?.addEventListener("change", (e) => {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    void updateSettings((fresh) => ({ ...fresh, nextActionChips: checked }))
      .catch((err) => console.error("[chat-defaults] saving quick reply chips failed", err));
  });

  for (const [id, key] of [["#chatDefaultsModel", "defaultModel"], ["#chatDefaultsEffort", "defaultEffort"]] as const) {
    root.querySelector<HTMLSelectElement>(id)?.addEventListener("change", (e) => {
      const value = (e.currentTarget as HTMLSelectElement).value;
      // Fresh-read inside updateSettings, so a concurrent daemon-owned write is kept.
      void updateSettings((fresh) => ({ ...fresh, [key]: value }))
        // The new-chat draft reads settings from a stale-while-revalidate cache.
        .then(() => settingsData().ready.catch(() => {}))
        .catch((err) => console.error("[chat-defaults] saving the default failed", err));
    });
  }

  const sortSelect = root.querySelector<HTMLSelectElement>("#chatDefaultsSort");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      const v = sortSelect.value as SessionSort;
      saveSort(v);
      // Dispatch an event so the sessions view can re-render if it's mounted.
      document.dispatchEvent(new CustomEvent("cc-sort-changed"));
    });
  }

  function readModelsField(): string[] {
    const raw = root.querySelector<HTMLInputElement>("#chatDefaultsModels")?.value ?? "";
    const parsed = parseModels(raw);
    return parsed.length > 0 ? parsed : models;
  }

  // Autosave: the models input persists on its own input event (no Save
  // button). Fresh-read + retry: building from the frontend's own
  // settings cache could revert a concurrent daemon-owned write.
  async function persist(): Promise<void> {
    models = readModelsField();
    await updateSettings((fresh) => ({ ...fresh, models }));
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function persistDebounced(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void persist(); }, 400);
  }

  const modelsInput = root.querySelector<HTMLInputElement>("#chatDefaultsModels");
  if (modelsInput) modelsInput.addEventListener("input", () => persistDebounced());

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
