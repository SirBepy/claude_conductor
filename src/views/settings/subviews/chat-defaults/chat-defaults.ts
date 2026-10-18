import { html, render } from "lit-html";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { isRemote } from "../../../../shared/transport";
import { loadSort, saveSort } from "../../../sessions/sessions-helpers";
import type { SessionSort } from "../../../sessions/sessions-helpers";
import { readModels, readDefaultFlags } from "../../../../shared/effort-presets";
import { settingsHeader, toggleRow } from "../../ui";
import { browserSectionTemplate, readBrowserEnabled, wireBrowserSection, BROWSER_SETTING_KEY } from "./browser-section";
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

/** Both default on when absent, matching `Settings::spawned_chats_inherit_auto_accept`
 *  and `Settings::jarvis_workers_auto_accept` on the daemon side. */
function readSpawnFlags(settings: Record<string, unknown>): { inherit: boolean; workers: boolean } {
  return {
    inherit: settings["spawnedChatsInheritAutoAccept"] !== false,
    workers: settings["jarvisWorkersAutoAccept"] !== false,
  };
}

function template(
  models: string[],
  flags: { autoAccept: boolean },
  spawn: { inherit: boolean; workers: boolean },
  sort: SessionSort,
  browser: boolean,
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
          ${isRemote() ? "" : toggleRow({ label: "Auto-allow permissions by default", inputId: "chatDefaultsAutoAllow", checked: flags.autoAccept })}
          ${isRemote() ? "" : toggleRow({
            label: "Chats an agent starts inherit auto-allow",
            inputId: "chatDefaultsInheritAutoAllow",
            checked: spawn.inherit,
            tooltip: "A chat started by spawn_chat or a scheduled new chat copies its parent's auto-allow. Off: it asks for permissions. Respawn always keeps the flag.",
          })}
          ${isRemote() ? "" : toggleRow({
            label: "Jarvis workers auto-allow",
            inputId: "chatDefaultsWorkersAutoAllow",
            checked: spawn.workers,
            tooltip: "Workers Jarvis spawns run with auto-allow. Off: they ask, and Jarvis can approve their permission prompts. Worker questions always come to you.",
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

        ${isRemote() ? "" : browserSectionTemplate(browser)}

      </div>
    </div>
  `;
}

export async function renderChatDefaultsView(root: HTMLElement): Promise<() => void> {
  const settings = getSettings();
  let models = readModels(settings);
  let flags = readDefaultFlags(settings);
  let spawn = readSpawnFlags(settings);
  let browser = readBrowserEnabled(settings);
  const sort = loadSort();

  render(template(models, flags, spawn, sort, browser), root);
  if (!isRemote()) wireBrowserSection(root);

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
    flags = { autoAccept: autoAllow };
    spawn = {
      inherit: root.querySelector<HTMLInputElement>("#chatDefaultsInheritAutoAllow")?.checked ?? spawn.inherit,
      workers: root.querySelector<HTMLInputElement>("#chatDefaultsWorkersAutoAllow")?.checked ?? spawn.workers,
    };
    browser = root.querySelector<HTMLInputElement>("#chatDefaultsBrowser")?.checked ?? browser;
    // Fresh-read + retry (todo 1004): building from the frontend's own
    // settings cache could revert a concurrent daemon-owned write.
    await updateSettings((fresh) => ({
      ...fresh,
      models,
      defaultAutoAllow: autoAllow,
      spawnedChatsInheritAutoAccept: spawn.inherit,
      jarvisWorkersAutoAccept: spawn.workers,
      [BROWSER_SETTING_KEY]: browser,
    }));
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
  for (const id of ["#chatDefaultsInheritAutoAllow", "#chatDefaultsWorkersAutoAllow", "#chatDefaultsBrowser"]) {
    root.querySelector<HTMLInputElement>(id)?.addEventListener("change", () => void persist());
  }

  const modelsInput = root.querySelector<HTMLInputElement>("#chatDefaultsModels");
  if (modelsInput) modelsInput.addEventListener("input", () => persistDebounced());

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
