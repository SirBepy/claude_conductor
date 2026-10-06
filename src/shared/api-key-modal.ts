// Add/replace an API key (Shortcut, Linear, ...) without opening ~/.claude/.env
// by hand (todo 1043). Rebuilt onto the shared modal-host chain (src/shared/modal.ts,
// same shell as characters.ts's openNewCharacterModal: .modal.modal-card +
// .modal-header/.modal-body/.modal-actions) so its input picks up the app's
// shared text-input look instead of a bespoke one - that look only needed
// `input[type="password"]` added to styles/inputs.css's shared input rule.
// presentHostCard()/closeHostCard() own the backdrop, focus trap and phone
// hardware-back; this module no longer manages those itself.
//
// The key's value is only ever held in this module's local `value` string -
// cleared the instant a save resolves, before the next render, so it never
// lingers in the DOM or gets handed back to a caller.

import { html, render } from "lit-html";
import "./api-key-modal.css";
import "./modal.css";
import { api } from "./api";
import type { ApiKeyStatus } from "./api";
import { escapeHtml } from "./escape-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "./modal";

/** Resolves `true` iff at least one save succeeded while the modal was open
 *  (callers use this to decide whether to refresh their own "set/not set"
 *  display), `false` on close without ever saving. */
export function openApiKeyModal(envName: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let status: ApiKeyStatus | null = null;
    let loading = true;
    let value = "";
    let saving = false;
    let error: string | null = null;
    let savedOnce = false;
    let justSaved = false;
    let card: HTMLElement | null = null;

    function close(result: boolean): void {
      document.removeEventListener("keydown", onKey);
      closeHostCard();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(savedOnce); }
    }
    document.addEventListener("keydown", onKey);
    setBackdropCancel(() => close(savedOnce));

    async function load(): Promise<void> {
      const list = await api.listApiKeys();
      status = list.find((k) => k.env_name === envName) ?? null;
      loading = false;
      renderCard();
      // Focus the field once the real form is up - not during the loading
      // shell above and not on the "unknown key" dead end below, which has
      // nothing to type into.
      card?.querySelector<HTMLInputElement>("#aikm-value")?.focus();
    }

    async function doSave(): Promise<void> {
      if (!status || !value.trim() || saving) return;
      saving = true;
      error = null;
      renderCard();
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
        renderCard();
      }
    }

    function bodyHtml(): string {
      if (loading) {
        return `<div class="modal-header"><i class="ph ph-key"></i><h3>Add API key</h3></div><div class="modal-body"><div class="aikm-loading"><i class="ph ph-circle-notch aikm-spin"></i> Loading&hellip;</div></div>`;
      }
      if (!status) {
        return `
          <div class="modal-body">
            <div class="aikm-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(envName)} is not a known API key.</div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary aikm-close-btn">Close</button>
          </div>`;
      }
      const s = status;
      return `
        <div class="modal-header">
          <i class="ph ph-key"></i>
          <h3>${escapeHtml(s.label)}</h3>
        </div>
        <div class="modal-body">
          <p>${escapeHtml(s.purpose)}</p>
          <div class="aikm-meta-row"><span class="aikm-meta-label">Env var</span><code class="aikm-code">${escapeHtml(s.env_name)}</code></div>
          <div class="aikm-meta-row"><span class="aikm-meta-label">Used by</span><span>${escapeHtml(s.used_by)}</span></div>
          <div class="aikm-meta-row"><span class="aikm-meta-label">Saves to</span><code class="aikm-code aikm-path">${escapeHtml(s.save_path)}</code></div>
          <a class="aikm-create-link" href="${escapeHtml(s.create_url)}" rel="noopener">Get a key <i class="ph ph-arrow-square-out"></i></a>
          <div class="field">
            <label for="aikm-value">${s.is_set ? "Replace key" : "Key"}</label>
            <input type="password" id="aikm-value" class="aikm-field" autocomplete="off" spellcheck="false" placeholder="Paste the key value" value="${escapeHtml(value)}">
          </div>
          <div class="aikm-status${s.is_set ? " is-set" : ""}">
            <i class="ph ${s.is_set ? "ph-check-circle" : "ph-circle-dashed"}"></i>${s.is_set ? "Set" : "Not set"}
          </div>
          ${error ? `<div class="aikm-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
          ${justSaved && !error ? `<div class="aikm-saved"><i class="ph ph-check"></i> Saved</div>` : ""}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary aikm-close-btn">${savedOnce ? "Done" : "Cancel"}</button>
          <button type="button" class="btn-primary aikm-save-btn" ${saving || !value.trim() ? "disabled" : ""}>${saving ? `<i class="ph ph-spinner aikm-spin"></i> Saving&hellip;` : "Save"}</button>
        </div>`;
    }

    function attach(): void {
      if (!card) return;
      card.setAttribute("aria-label", !loading && status ? status.label : "Add API key");
      card.querySelector<HTMLButtonElement>(".aikm-close-btn")?.addEventListener("click", () => close(savedOnce));
      card.querySelector<HTMLButtonElement>(".aikm-save-btn")?.addEventListener("click", () => void doSave());
      const input = card.querySelector<HTMLInputElement>("#aikm-value");
      input?.addEventListener("input", () => {
        value = input.value;
        justSaved = false;
        const saveBtn = card!.querySelector<HTMLButtonElement>(".aikm-save-btn");
        if (saveBtn) saveBtn.disabled = saving || !value.trim();
      });
    }

    function renderCard(): void {
      if (!card) return;
      card.innerHTML = bodyHtml();
      attach();
    }

    void presentHostCard(() => {
      render(
        html`<div class="modal modal-card aikm-modal-card" role="dialog" aria-modal="true" aria-label="Add API key"></div>`,
        modalCardSlot(),
      );
      card = modalCardSlot().querySelector<HTMLElement>(".aikm-modal-card")!;
      renderCard();
    });
    void load();
  });
}
