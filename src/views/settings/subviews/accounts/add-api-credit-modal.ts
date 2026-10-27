// Add an API-credit account: a label and the API key whose chats bill the Max
// plan's monthly API credit. Same shared modal-host shell and field look as
// api-key-modal.ts (its `aikm-*` rules are the one definition of a masked key
// field here). The key lives only in this closure and is wiped the moment the
// backend accepts it, so it never lingers in the DOM or reaches a caller.

import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../../shared/modal";
import "../../../../shared/modal.css";
import "../../../../shared/api-key-modal.css";

const EXPLAINER =
  "Chats on this account bill the Max plan's monthly API credit instead of your plan's usage limits. " +
  "Only chats you explicitly start on it use it.";

/** The masked key field both modals share. */
function keyFieldHtml(id: string, value: string, onInput: (value: string) => void) {
  return html`
    <div class="field">
      <label for=${id}>API key</label>
      <input type="password" id=${id} class="aikm-field" autocomplete="off" spellcheck="false"
        placeholder="Paste the key value" .value=${value}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}>
    </div>`;
}

/** Resolves with the new account, or `null` when the modal closes without one. */
export function openAddApiCreditModal(): Promise<Account | null> {
  return new Promise<Account | null>((resolve) => {
    let label = "";
    let key = "";
    let saving = false;
    let error: string | null = null;
    let card: HTMLElement | null = null;

    function close(result: Account | null): void {
      document.removeEventListener("keydown", onKey);
      key = "";
      closeHostCard();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    }
    document.addEventListener("keydown", onKey);
    setBackdropCancel(() => close(null));

    const canSave = (): boolean => !saving && label.trim().length > 0 && key.trim().length > 0;

    async function doSave(): Promise<void> {
      if (!canSave()) return;
      saving = true;
      error = null;
      renderCard();
      try {
        const account = await api.addApiCreditAccount(label.trim(), key.trim());
        close(account);
        return;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      saving = false;
      renderCard();
    }

    function renderCard(): void {
      if (!card) return;
      render(
        html`
          <div class="modal-header"><i class="ph ph-key"></i><h3>Add API-credit account</h3></div>
          <div class="modal-body">
            <p>${EXPLAINER}</p>
            <div class="field">
              <label for="aacm-label">Label</label>
              <input type="text" id="aacm-label" class="aikm-field" autocomplete="off" spellcheck="false"
                placeholder="API credit" .value=${label}
                @input=${(e: Event) => { label = (e.target as HTMLInputElement).value; syncSave(); }}>
            </div>
            ${keyFieldHtml("aacm-key", key, (v) => { key = v; syncSave(); })}
            ${error ? html`<div class="aikm-error"><i class="ph ph-warning-circle"></i> ${error}</div>` : ""}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" @click=${() => close(null)}>Cancel</button>
            <button type="button" class="btn-primary aacm-save-btn" ?disabled=${!canSave()} @click=${() => void doSave()}>
              ${saving ? html`<i class="ph ph-spinner aikm-spin"></i> Adding&hellip;` : "Add account"}
            </button>
          </div>`,
        card,
      );
    }

    // Typing must not re-render the card (it would reset the caret); only the
    // button's enabled state follows the fields.
    function syncSave(): void {
      const btn = card?.querySelector<HTMLButtonElement>(".aacm-save-btn");
      if (btn) btn.disabled = !canSave();
    }

    void presentHostCard(() => {
      render(
        html`<div class="modal modal-card aikm-modal-card" role="dialog" aria-modal="true" aria-label="Add API-credit account"></div>`,
        modalCardSlot(),
      );
      card = modalCardSlot().querySelector<HTMLElement>(".aikm-modal-card")!;
      renderCard();
      card.querySelector<HTMLInputElement>("#aacm-label")?.focus();
    });
  });
}

/** Resolves `true` once the new key was accepted and stored, `false` when the
 * modal closes without replacing it. The stored key is untouched until
 * Anthropic accepts the new one. */
export function openReplaceApiKeyModal(account: { id: string; label: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let key = "";
    let saving = false;
    let error: string | null = null;
    let card: HTMLElement | null = null;

    function close(replaced: boolean): void {
      document.removeEventListener("keydown", onKey);
      key = "";
      closeHostCard();
      resolve(replaced);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    }
    document.addEventListener("keydown", onKey);
    setBackdropCancel(() => close(false));

    const canSave = (): boolean => !saving && key.trim().length > 0;

    async function doSave(): Promise<void> {
      if (!canSave()) return;
      saving = true;
      error = null;
      renderCard();
      try {
        await api.replaceApiCreditKey(account.id, key.trim());
        close(true);
        return;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      saving = false;
      renderCard();
    }

    function renderCard(): void {
      if (!card) return;
      render(
        html`
          <div class="modal-header"><i class="ph ph-key"></i><h3>Replace API key</h3></div>
          <div class="modal-body">
            <p>Paste a new key for ${account.label}. The current key stays in place until Anthropic accepts the new one.</p>
            ${keyFieldHtml("rapk-key", key, (v) => { key = v; syncSave(); })}
            ${error ? html`<div class="aikm-error"><i class="ph ph-warning-circle"></i> ${error}</div>` : ""}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" @click=${() => close(false)}>Cancel</button>
            <button type="button" class="btn-primary rapk-save-btn" ?disabled=${!canSave()} @click=${() => void doSave()}>
              ${saving ? html`<i class="ph ph-spinner aikm-spin"></i> Checking&hellip;` : "Replace key"}
            </button>
          </div>`,
        card,
      );
    }

    // Typing must not re-render the card (it would reset the caret).
    function syncSave(): void {
      const btn = card?.querySelector<HTMLButtonElement>(".rapk-save-btn");
      if (btn) btn.disabled = !canSave();
    }

    void presentHostCard(() => {
      render(
        html`<div class="modal modal-card aikm-modal-card" role="dialog" aria-modal="true" aria-label="Replace API key"></div>`,
        modalCardSlot(),
      );
      card = modalCardSlot().querySelector<HTMLElement>(".aikm-modal-card")!;
      renderCard();
      card.querySelector<HTMLInputElement>("#rapk-key")?.focus();
    });
  });
}
