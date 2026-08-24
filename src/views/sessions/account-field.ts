// Account-picker rendering/wiring for the new-chat modal (multi-account
// milestone 04). Split out of model-effort-modal.ts once that file's
// account-picker section grew large enough to warrant its own module,
// mirroring the earlier account-picker-logic.ts extraction of the pure
// resolution helpers. model-effort-modal.ts is the only caller; it owns the
// state object below in its closure and passes it in/out here.

import { escapeHtml } from "../../shared/escape-html";
import type { Account } from "../../shared/api";
import { accountChipHtml } from "../../shared/account-chip";
import "../../shared/account-chip.css";

/** Mutable account-picker state, owned by the modal's closure. `accountId`
 * is null only when the registry is empty or ambiguous (see
 * resolveInitialAccountId), which gates "Start session" until the user
 * clicks a chip. */
export interface AccountFieldState {
  accountId: string | null;
}

/** Read-only context the modal already resolved before opening. */
export interface AccountFieldContext {
  accounts: Account[];
}

/** True while there is no usable account to spawn under: an empty registry
 * (the "add an account first" state), or an ambiguous one (multiple
 * accounts, no binding/default) the user hasn't resolved yet by picking a
 * chip. Gates "Start session" in both cases. */
export function accountPickIncomplete(state: AccountFieldState, accounts: Account[]): boolean {
  return accounts.length === 0 || state.accountId === null;
}

export function renderAccountFieldHtml(state: AccountFieldState, ctx: AccountFieldContext): string {
  const { accounts } = ctx;
  if (accounts.length === 0) {
    return `
      <div class="me-acc-field me-acc-empty">
        <label class="me-label">Account</label>
        <div class="me-acc-empty-msg">
          <i class="ph ph-warning-circle"></i> No Claude accounts yet.
          <button type="button" class="me-acc-add-link">Add one in Settings</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="me-acc-field">
      <label class="me-label">Account</label>
      <div class="me-acc-edit">
        ${accounts.map((a) => accountChipHtml(a, a.id === state.accountId, `data-acc-id="${escapeHtml(a.id)}"`)).join("")}
      </div>
    </div>
  `;
}

/**
 * Wire up the account-field's DOM handlers after `renderAccountFieldHtml`
 * has been injected into the overlay. Mutates `state` in place; callers
 * must re-render after `onChange` fires (matches the modal's own
 * renderBody-on-every-mutation pattern).
 */
export function attachAccountFieldHandlers(
  overlay: HTMLElement,
  state: AccountFieldState,
  onChange: () => void,
  onAddAccount: () => void,
): void {
  overlay.querySelectorAll<HTMLElement>(".me-acc-edit .account-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.accId;
      if (!id) return;
      state.accountId = id;
      onChange();
    });
  });
  overlay.querySelector<HTMLButtonElement>(".me-acc-add-link")?.addEventListener("click", onAddAccount);
}
