import { html, render } from "lit-html";
import { getSettings, setSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { loadSort, saveSort } from "../../../sessions/sessions-helpers";
import type { SessionSort } from "../../../sessions/sessions-helpers";
import { readModels, readDefaultFlags } from "../../../../shared/effort-presets";
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

function template(
  models: string[],
  flags: { autoAccept: boolean; remote: boolean },
  sort: SessionSort,
) {
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
          ${toggleRow({ label: "Auto-allow permissions by default", inputId: "chatDefaultsAutoAllow", checked: flags.autoAccept })}
          ${toggleRow({ label: "Remote chat by default", inputId: "chatDefaultsRemote", checked: flags.remote })}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Models</div>
          <input
            type="text"
            class="cd-models-input"
            id="chatDefaultsModels"
            .value=${models.join(", ")}
            placeholder="haiku, sonnet, opus"
          >
          <p class="cd-hint">Models offered in the New session picker, comma-separated.</p>
        </div>

      </div>
    </div>
  `;
}

export async function renderChatDefaultsView(root: HTMLElement): Promise<() => void> {
  const settings = getSettings();
  let models = readModels(settings);
  let flags = readDefaultFlags(settings);
  const sort = loadSort();

  render(template(models, flags, sort), root);

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

  // Autosave: every control persists on its own change/input event (no Save
  // button).
  async function persist(): Promise<void> {
    models = readModelsField();
    const autoAllow = root.querySelector<HTMLInputElement>("#chatDefaultsAutoAllow")?.checked ?? flags.autoAccept;
    const remote = root.querySelector<HTMLInputElement>("#chatDefaultsRemote")?.checked ?? flags.remote;
    flags = { autoAccept: autoAllow, remote };
    const cur = {
      ...getSettings(),
      models,
      defaultAutoAllow: autoAllow,
      defaultRemoteControl: remote,
    };
    setSettings(cur);
    await api.saveSettings(cur);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function persistDebounced(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void persist(); }, 400);
  }

  const autoAllowEl = root.querySelector<HTMLInputElement>("#chatDefaultsAutoAllow");
  if (autoAllowEl) autoAllowEl.addEventListener("change", () => void persist());
  const remoteEl = root.querySelector<HTMLInputElement>("#chatDefaultsRemote");
  if (remoteEl) remoteEl.addEventListener("change", () => void persist());

  const modelsInput = root.querySelector<HTMLInputElement>("#chatDefaultsModels");
  if (modelsInput) modelsInput.addEventListener("input", () => persistDebounced());

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
