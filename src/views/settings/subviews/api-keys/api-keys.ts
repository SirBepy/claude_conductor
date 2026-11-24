// Settings > API keys: the tokens Conductor stores for the trackers Claude reads
// through it (Shortcut, Linear, Figma ...), with set/not-set status. Lists the
// registry (src-tauri/src/api_keys.rs); Add/Replace opens the shared
// api-key-modal.ts, which does the actual write. Desktop-only: set_api_key is
// never called over the phone transport, so the page is not offered there.
//
// Its own page, not a tab of Accounts & models: these keys belong to no account.

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { ApiKeyStatus } from "../../../../types/ipc.generated";
import { settingsHeader } from "../../ui";
import "./api-keys.css";

function apiKeyRowHtml(k: ApiKeyStatus): string {
  return `
    <div class="kit-row api-key-row" data-env="${escapeHtml(k.env_name)}">
      <span class="kit-row-label">${escapeHtml(k.label)}</span>
      <span class="api-key-status${k.is_set ? " is-set" : ""}"><i class="ph ${k.is_set ? "ph-check-circle" : "ph-circle-dashed"}"></i>${k.is_set ? "Set" : "Not set"}</span>
      <button type="button" class="btn-secondary api-key-btn" data-env="${escapeHtml(k.env_name)}">${k.is_set ? "Replace" : "Add"}</button>
    </div>`;
}

async function refreshList(list: HTMLElement): Promise<void> {
  const keys = await api.listApiKeys();
  list.innerHTML = keys.map(apiKeyRowHtml).join("");
}

export async function renderApiKeysView(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  const list = root.querySelector<HTMLElement>("#apiKeysList")!;

  // Delegated listener on the stable container: the rows are rebuilt after each save.
  const onClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement)?.closest<HTMLButtonElement>("button.api-key-btn");
    const env = btn?.dataset["env"];
    if (!env) return;
    void (async () => {
      const { openApiKeyModal } = await import("../../../../shared/api-key-modal");
      const saved = await openApiKeyModal(env);
      if (saved) await refreshList(list);
    })();
  };
  list.addEventListener("click", onClick);

  try { await refreshList(list); }
  catch (e) { console.error("[settings-api-keys] render failed", e); }

  return () => list.removeEventListener("click", onClick);
}

function template() {
  return html`
    <div class="view view-settings-api-keys">
      ${settingsHeader("API keys")}
      <div class="view-body">
        <div class="kit-section">
          <div class="kit-section-title">Tracker tokens</div>
          <p class="api-keys-explainer">Tokens for the services Claude reads through Conductor. Chats never see them.</p>
          <div id="apiKeysList" class="api-keys-list"></div>
        </div>
      </div>
    </div>
  `;
}
