// Add/replace an API key (Shortcut, Linear, ...) without opening ~/.claude/.env
// by hand (todo 1043). Own-backdrop modal, same shape as edit-account-modal.ts:
// lockInputToHost for the composer key-trap, registerOverlayBack for phone
// hardware-back, Escape/backdrop-click to close. Opened from Settings > System
// (one row per registry entry) and from the ticket hover card's missing-token
// error (ticket-refs.ts).
//
// The key's value is only ever held in this module's local `value` string -
// cleared the instant a save resolves, before the next render, so it never
// lingers in the DOM or gets handed back to a caller.

import "./api-key-modal.css";
import { api } from "./api";
import type { ApiKeyStatus } from "./api";
import { escapeHtml } from "./escape-html";
import { lockInputToHost } from "./modal-input-lock";
import { registerOverlayBack } from "./back-button";

/** Resolves `true` iff at least one save succeeded while the modal was open
 *  (callers use this to decide whether to refresh their own "set/not set"
 *  display), `false` on close without ever saving. */
export function openApiKeyModal(envName: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aikm-overlay";

    const unlock = lockInputToHost(overlay);

    let status: ApiKeyStatus | null = null;
    let loading = true;
    let value = "";
    let saving = false;
    let error: string | null = null;
    let savedOnce = false;
    let justSaved = false;

    function close(result: boolean): void {
      disposeBack();
      unlock();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(savedOnce); }
    }
    document.addEventListener("keydown", onKey);
    const disposeBack = registerOverlayBack(() => { close(savedOnce); return true; });

    async function load(): Promise<void> {
      const list = await api.listApiKeys();
      status = list.find((k) => k.env_name === envName) ?? null;
      loading = false;
      render();
    }

    async function doSave(): Promise<void> {
      if (!status || !value.trim() || saving) return;
      saving = true;
      error = null;
      render();
      try {
        status = await api.setApiKey(status.env_name, value);
        // Cleared before the next render - the typed value never survives a
        // successful save, in state or in the DOM.
        value = "";
        savedOnce = true;
        justSaved = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        saving = false;
        render();
      }
    }

    function bodyHtml(): string {
      if (loading) {
        return `<div class="aikm-modal" role="dialog" aria-modal="true" aria-label="Add API key"><div class="aikm-loading"><i class="ph ph-circle-notch aikm-spin"></i> Loading&hellip;</div></div>`;
      }
      if (!status) {
        return `
          <div class="aikm-modal" role="dialog" aria-modal="true" aria-label="Add API key">
            <div class="aikm-body">
              <div class="aikm-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(envName)} is not a known API key.</div>
            </div>
            <div class="aikm-actions">
              <button type="button" class="btn-secondary aikm-close-btn">Close</button>
            </div>
          </div>`;
      }
      const s = status;
      return `
        <div class="aikm-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(s.label)}">
          <div class="aikm-head">
            <span class="t">${escapeHtml(s.label)}</span>
            <button type="button" class="icon-btn-sq aikm-close" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
          </div>
          <div class="aikm-body">
            <p class="aikm-purpose">${escapeHtml(s.purpose)}</p>
            <div class="aikm-meta-row"><span class="aikm-meta-label">Env var</span><code class="aikm-code">${escapeHtml(s.env_name)}</code></div>
            <div class="aikm-meta-row"><span class="aikm-meta-label">Used by</span><span>${escapeHtml(s.used_by)}</span></div>
            <div class="aikm-meta-row"><span class="aikm-meta-label">Saves to</span><code class="aikm-code aikm-path">${escapeHtml(s.save_path)}</code></div>
            <a class="aikm-create-link" href="${escapeHtml(s.create_url)}" rel="noopener">Get a key <i class="ph ph-arrow-square-out"></i></a>
            <div class="field">
              <label for="aikm-value">${s.is_set ? "Replace key" : "Key"}</label>
              <input type="password" id="aikm-value" class="aikm-input" autocomplete="off" spellcheck="false" placeholder="Paste the key value" value="${escapeHtml(value)}">
            </div>
            <div class="aikm-status${s.is_set ? " is-set" : ""}">
              <i class="ph ${s.is_set ? "ph-check-circle" : "ph-circle-dashed"}"></i>${s.is_set ? "Set" : "Not set"}
            </div>
            ${error ? `<div class="aikm-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
            ${justSaved && !error ? `<div class="aikm-saved"><i class="ph ph-check"></i> Saved</div>` : ""}
          </div>
          <div class="aikm-actions">
            <button type="button" class="btn-secondary aikm-close-btn">${savedOnce ? "Done" : "Cancel"}</button>
            <button type="button" class="btn-primary aikm-save-btn" ${saving || !value.trim() ? "disabled" : ""}>${saving ? `<i class="ph ph-spinner aikm-spin"></i> Saving&hellip;` : "Save"}</button>
          </div>
        </div>`;
    }

    function attach(): void {
      overlay.querySelector<HTMLButtonElement>(".aikm-close")?.addEventListener("click", () => close(savedOnce));
      overlay.querySelector<HTMLButtonElement>(".aikm-close-btn")?.addEventListener("click", () => close(savedOnce));
      overlay.querySelector<HTMLButtonElement>(".aikm-save-btn")?.addEventListener("click", () => void doSave());
      const input = overlay.querySelector<HTMLInputElement>("#aikm-value");
      input?.addEventListener("input", () => {
        value = input.value;
        justSaved = false;
        const saveBtn = overlay.querySelector<HTMLButtonElement>(".aikm-save-btn");
        if (saveBtn) saveBtn.disabled = saving || !value.trim();
      });
    }

    function render(): void {
      overlay.innerHTML = bodyHtml();
      attach();
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(savedOnce); });
    document.body.appendChild(overlay);
    render();
    void load();
  });
}
