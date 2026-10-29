// Add an API-credit account: a label and the API key whose chats bill the Max
// plan's monthly API credit. Same shared modal-host shell and field look as
// api-key-modal.ts (its `aikm-*` rules are the one definition of a masked key
// field here). The key lives only in this closure and is wiped the moment the
// backend accepts it, so it never lingers in the DOM or reaches a caller.

import { html, render } from "lit-html";
import type { TemplateResult } from "lit-html";
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

interface KeyModalSpec<T> {
  ariaLabel: string;
  headerHtml: TemplateResult;
  /** Class on the primary button; `syncSave` finds it by this. */
  saveClass: string;
  idleLabel: string;
  busyLabel: string;
  /** Selector of the field focused on open. */
  focusSelector: string;
  /** What the promise resolves with when the modal closes without saving. */
  cancelled: T;
  /** The card body (fields and explainer); `syncSave` is for the fields' input handlers. */
  bodyHtml: (syncSave: () => void) => TemplateResult;
  /** True once every field has a value. */
  filled: () => boolean;
  /** Runs the request; its result resolves the modal. A throw shows as the error line. */
  save: () => Promise<T>;
  /** Drops the typed values from the closure. */
  wipe: () => void;
}

/** The open, close, busy and error lifecycle both API-key modals share. While a
 * save is in flight Escape, the backdrop and Cancel are ignored: closing then
 * would report "cancelled" to the caller while the request still lands, leaving
 * a key replaced (or an account created) with no toast and no refresh. */
function openKeyModal<T>(spec: KeyModalSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let saving = false;
    let error: string | null = null;
    let card: HTMLElement | null = null;

    function close(result: T): void {
      document.removeEventListener("keydown", onKey);
      spec.wipe();
      closeHostCard();
      resolve(result);
    }

    function cancel(): void {
      if (!saving) close(spec.cancelled);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    document.addEventListener("keydown", onKey);
    setBackdropCancel(cancel);

    const canSave = (): boolean => !saving && spec.filled();

    async function doSave(): Promise<void> {
      if (!canSave()) return;
      saving = true;
      error = null;
      renderCard();
      try {
        close(await spec.save());
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
          <div class="modal-header">${spec.headerHtml}</div>
          <div class="modal-body">
            ${spec.bodyHtml(syncSave)}
            ${error ? html`<div class="aikm-error"><i class="ph ph-warning-circle"></i> ${error}</div>` : ""}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" ?disabled=${saving} @click=${cancel}>Cancel</button>
            <button type="button" class="btn-primary ${spec.saveClass}" ?disabled=${!canSave()} @click=${() => void doSave()}>
              ${saving ? html`<i class="ph ph-spinner aikm-spin"></i> ${spec.busyLabel}&hellip;` : spec.idleLabel}
            </button>
          </div>`,
        card,
      );
    }

    // Typing must not re-render the card (it would reset the caret); only the
    // button's enabled state follows the fields.
    function syncSave(): void {
      const btn = card?.querySelector<HTMLButtonElement>(`.${spec.saveClass}`);
      if (btn) btn.disabled = !canSave();
    }

    void presentHostCard(() => {
      render(
        html`<div class="modal modal-card aikm-modal-card" role="dialog" aria-modal="true" aria-label=${spec.ariaLabel}></div>`,
        modalCardSlot(),
      );
      card = modalCardSlot().querySelector<HTMLElement>(".aikm-modal-card")!;
      renderCard();
      card.querySelector<HTMLInputElement>(spec.focusSelector)?.focus();
    });
  });
}

/** Resolves with the new account, or `null` when the modal closes without one. */
export function openAddApiCreditModal(): Promise<Account | null> {
  let label = "";
  let key = "";
  return openKeyModal<Account | null>({
    ariaLabel: "Add API-credit account",
    headerHtml: html`<i class="ph ph-key"></i><h3>Add API-credit account</h3>`,
    saveClass: "aacm-save-btn",
    idleLabel: "Add account",
    busyLabel: "Adding",
    focusSelector: "#aacm-label",
    cancelled: null,
    bodyHtml: (syncSave) => html`
      <p>${EXPLAINER}</p>
      <div class="field">
        <label for="aacm-label">Label</label>
        <input type="text" id="aacm-label" class="aikm-field" autocomplete="off" spellcheck="false"
          placeholder="API credit" .value=${label}
          @input=${(e: Event) => { label = (e.target as HTMLInputElement).value; syncSave(); }}>
      </div>
      ${keyFieldHtml("aacm-key", key, (v) => { key = v; syncSave(); })}`,
    filled: () => label.trim().length > 0 && key.trim().length > 0,
    save: () => api.addApiCreditAccount(label.trim(), key.trim()),
    wipe: () => { key = ""; },
  });
}

/** Resolves `true` once the new key was accepted and stored, `false` when the
 * modal closes without replacing it. The stored key is untouched until
 * Anthropic accepts the new one. */
export function openReplaceApiKeyModal(account: { id: string; label: string }): Promise<boolean> {
  let key = "";
  return openKeyModal<boolean>({
    ariaLabel: "Replace API key",
    headerHtml: html`<i class="ph ph-key"></i><h3>Replace API key</h3>`,
    saveClass: "rapk-save-btn",
    idleLabel: "Replace key",
    busyLabel: "Checking",
    focusSelector: "#rapk-key",
    cancelled: false,
    bodyHtml: (syncSave) => html`
      <p>Paste a new key for ${account.label}. The current key stays in place until Anthropic accepts the new one.</p>
      ${keyFieldHtml("rapk-key", key, (v) => { key = v; syncSave(); })}`,
    filled: () => key.trim().length > 0,
    save: async () => {
      await api.replaceApiCreditKey(account.id, key.trim());
      return true;
    },
    wipe: () => { key = ""; },
  });
}
