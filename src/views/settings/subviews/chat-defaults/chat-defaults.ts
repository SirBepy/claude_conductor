import { html, render } from "lit-html";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { isRemote } from "../../../../shared/transport";
import {
  EFFORTS, modelDisplayLabel, readGlobalDefault, readModels,
} from "../../../../shared/effort-presets";
import { settingsData } from "../../../sessions/new-session-cache";
import { settingsHeader, toggleRow } from "../../ui";
import { CHAT_VIEW_CHANGED, SECTIONS_KEY, readChatView, readSections, saveChatView, type ChatView } from "../../../sessions/chat-dashboard/chat-view-pref";
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
  { id: "links", label: "Attachments", tooltip: "One card with tabs: the links the chat produced and the files it touched, with the Bigger plan, Decided and Project memory buttons. Switch it off and the Previews and Images tabs go with it." },
  { id: "preview", label: "Previews tab", tooltip: "A Previews tab in the Attachments card: a live miniature of each preview the chat made, opening the preview panel." },
  { id: "images", label: "Images tab", tooltip: "An Images tab in the Attachments card: the images the chat produced or was sent, opening the same gallery as the Messages view." },
  { id: "drafts", label: "Drafts", tooltip: "Messages Claude wrote for you to send somewhere else, with Copy and Edit. Copied ones fold away." },
  { id: "picks", label: "Autopilot picks", tooltip: "The choices Claude made by itself while you were away, with Agree and Overrule on each. Only shows once a chat recorded one." },
  { id: "tests", label: "Tests", tooltip: "Live pass and fail counts, with the failing tests' names, for a test run started through scripts/test-progress.mjs. Only shows once a run reported." },
  { id: "changes", label: "Changes", tooltip: "The files the chat edited since your last message. Off unless you turn it on." },
];

/** Settings key of the offload switch; the daemon reads the same key (`subchats::remote::offload`). Off until set. */
export const OFFLOAD_KEY = "offloadReadOnlySubs";

/** Settings key of the idle-hide switch; the daemon reads the same key (`Settings::auto_hide_idle_chats`). On until turned off. */
export const AUTO_HIDE_KEY = "autoHideIdleChats";

function template(models: string[], def: { model: string; effort: string }, chips: boolean, view: ChatView, sections: Record<string, boolean>, compact: AutoCompact, offload: boolean, autoHide: boolean) {
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
          ${isRemote()
            ? ""
            : toggleRow({
                label: "Offload research subs to a paired machine",
                inputId: "chatDefaultsOffload",
                checked: offload,
                tooltip: "A read-only sub that names no project files (web research, lookups) starts on a paired machine that is awake and has 15 GB free, in an empty scratch folder there, so it spares this PC's memory. The machine keeps no copy of any project. A sub that needs the project's files still runs here. Off until you turn it on: the sub on the other machine cannot see this project.",
              })}
          ${toggleRow({
            label: "Hide idle chats",
            inputId: "chatDefaultsAutoHide",
            checked: autoHide,
            tooltip: "A chat moves into the hidden window by itself after 10 quiet minutes, so the heads show only chats that are working or waiting on you. Idle means it and its subs are not working, no card is open, nothing waits on you, you have seen its latest result, and it holds no unsent draft. It comes back when a new turn, card or sub starts. A chat you hide or show by hand is never overruled.",
          })}
          ${toggleRow({
            label: "Quick reply chips",
            inputId: "chatDefaultsNextChips",
            checked: chips,
            tooltip: "After a chat finishes a turn, offer one-click replies above the message box, like /commit. Click fills the box; Shift+click sends.",
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
  // The default model may not be in the offered list (a removed custom model): keep it selectable.
  const def = readGlobalDefault(getSettings());
  if (!models.includes(def.model)) models = [...models, def.model];

  // Default on: an absent key resolves to true.
  render(template(models, def, getSettings().nextActionChips !== false, readChatView(getSettings()), readSections(getSettings()), readAutoCompact(getSettings(), null), getSettings()[OFFLOAD_KEY] === true, getSettings()[AUTO_HIDE_KEY] !== false), root);

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
    void saveChatView(value)
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

  root.querySelector<HTMLInputElement>("#chatDefaultsOffload")?.addEventListener("change", (e) => {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    void updateSettings((fresh) => ({ ...fresh, [OFFLOAD_KEY]: checked }))
      .catch((err) => console.error("[chat-defaults] saving the offload switch failed", err));
  });

  root.querySelector<HTMLInputElement>("#chatDefaultsAutoHide")?.addEventListener("change", (e) => {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    void updateSettings((fresh) => ({ ...fresh, [AUTO_HIDE_KEY]: checked }))
      .catch((err) => console.error("[chat-defaults] saving the idle-hide switch failed", err));
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
