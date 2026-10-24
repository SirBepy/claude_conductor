import { html, render } from "lit-html";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { isRemote } from "../../../../shared/transport";
import { loadSort, saveSort } from "../../../sessions/sessions-helpers";
import type { SessionSort } from "../../../sessions/sessions-helpers";
import { readModels } from "../../../../shared/effort-presets";
import { settingsHeader } from "../../ui";
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

function template(models: string[], sort: SessionSort) {
  return html`
    <div class="view view-settings-chat-defaults">
      ${settingsHeader("Chat defaults")}
      <div class="view-body">

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

  render(template(models, sort), root);

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
