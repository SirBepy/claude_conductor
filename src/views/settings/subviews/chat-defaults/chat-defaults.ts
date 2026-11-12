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
import { CHAT_VIEW_CHANGED, CHAT_VIEW_KEY, SECTIONS_KEY, readChatView, readSections, type ChatView } from "../../../sessions/chat-dashboard/chat-view-pref";
import type { AutoCompact } from "../../../../shared/auto-compact";
import { SECTION_DEFAULTS, sectionOn } from "../../../../shared/chat/dashboard/dashboard-model";
import { kToTokens, readAutoCompact, tokensToK, withAutoCompact } from "../../../../shared/auto-compact";
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

/** Dashboard cards Joe can switch off or on. The rest (Answers, Plan, Waiting on you) always draw. */
const DASHBOARD_SECTIONS: ReadonlyArray<{ id: string; label: string; tooltip: string }> = [
  { id: "links", label: "Links and files", tooltip: "Links the chat produced and the files it touched, with the Bigger plan, Decided and Project memory buttons." },
  { id: "preview", label: "Preview window", tooltip: "A small live tile of the chat's newest preview that opens the preview panel." },
  { id: "drafts", label: "Drafts", tooltip: "Messages Claude wrote for you to send somewhere else, with Copy and Edit. Copied ones fold away." },
  { id: "changes", label: "Changes", tooltip: "The files the chat edited since your last message. Off unless you turn it on." },
];

function template(models: string[], sort: SessionSort, def: { model: string; effort: string }, chips: boolean, view: ChatView, sections: Record<string, boolean>, compact: AutoCompact) {
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
          ${isRemote()
            ? ""
            : html`<div class="kit-row">
                <span class="kit-row-label">Chat view</span>
                <select id="chatDefaultsChatView" class="kit-select">
                  <option value="dashboard" ?selected=${view === "dashboard"}>Dashboard</option>
                  <option value="messages" ?selected=${view === "messages"}>Messages</option>
                </select>
              </div>
              <p class="cd-hint">Dashboard shows a chat's answers, plan and what waits on you as cards. Messages shows the full transcript.</p>
              ${DASHBOARD_SECTIONS.map((sec) => toggleRow({
                label: `Dashboard: ${sec.label}`,
                inputId: `chatDefaultsSection-${sec.id}`,
                checked: sectionOn(sections, sec.id),
                tooltip: sec.tooltip,
              }))}`}
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
              <div class="kit-section-title">Compaction</div>
              ${toggleRow({
                label: "Compact main chats automatically",
                inputId: "chatDefaultsCompactOn",
                checked: compact.on,
                tooltip: "A main chat (Use subchats on) that is idle and past the size below is compacted in place: the conversation is summarized and the chat goes on. A project can set its own in its project settings.",
              })}
              <div class="kit-row">
                <span class="kit-row-label">Compact at (K tokens)</span>
                <input type="number" id="chatDefaultsCompactK" class="kit-select cd-compact-k" min="1" max="10000" step="1" .value=${String(tokensToK(compact.tokens))}>
              </div>
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
  render(template(models, sort, def, getSettings().nextActionChips !== false, readChatView(getSettings()), readSections(getSettings()), readAutoCompact(getSettings(), null)), root);

  for (const id of Object.keys(SECTION_DEFAULTS)) {
    root.querySelector<HTMLInputElement>(`#chatDefaultsSection-${id}`)?.addEventListener("change", (e) => {
      const checked = (e.currentTarget as HTMLInputElement).checked;
      void updateSettings((fresh) => ({ ...fresh, [SECTIONS_KEY]: { ...readSections(fresh as Record<string, unknown>), [id]: checked } }))
        .then(() => document.dispatchEvent(new CustomEvent(CHAT_VIEW_CHANGED)))
        .catch((err) => console.error("[chat-defaults] saving a dashboard section failed", err));
    });
  }

  root.querySelector<HTMLSelectElement>("#chatDefaultsChatView")?.addEventListener("change", (e) => {
    const value: ChatView = (e.currentTarget as HTMLSelectElement).value === "messages" ? "messages" : "dashboard";
    void updateSettings((fresh) => ({ ...fresh, [CHAT_VIEW_KEY]: value }))
      // updateSettings refreshes the settings cache first, so an open chat reads the new value.
      .then(() => document.dispatchEvent(new CustomEvent(CHAT_VIEW_CHANGED)))
      .catch((err) => console.error("[chat-defaults] saving the chat view failed", err));
  });

  root.querySelector<HTMLInputElement>("#chatDefaultsCompactOn")?.addEventListener("change", (e) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    void updateSettings((fresh) => withAutoCompact(fresh, null, { on }))
      .catch((err) => console.error("[chat-defaults] saving the compaction switch failed", err));
  });

  const compactK = root.querySelector<HTMLInputElement>("#chatDefaultsCompactK");
  compactK?.addEventListener("change", () => {
    const tokens = kToTokens(compactK.value);
    if (tokens === null) {
      // Not a number the daemon would accept: show what is in force instead.
      compactK.value = String(tokensToK(readAutoCompact(getSettings(), null).tokens));
      return;
    }
    void updateSettings((fresh) => withAutoCompact(fresh, null, { tokens }))
      .catch((err) => console.error("[chat-defaults] saving the compaction size failed", err));
  });

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
