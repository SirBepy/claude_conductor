// Account-picker rendering/wiring for the new-chat modal (multi-account
// milestone 04). Split out of model-effort-modal.ts once that file's
// account-picker section grew large enough to warrant its own module,
// mirroring the earlier account-picker-logic.ts extraction of the pure
// resolution helpers. model-effort-modal.ts is the only caller; it owns the
// state object below in its closure and passes it in/out here.

import { escapeHtml } from "../../shared/escape-html";
import type { Account } from "../../shared/api";
import { accountChipHtml, accountIconBadgeHtml } from "../../shared/account-chip";
import "../../shared/account-chip.css";
import { shouldOfferRemember } from "./account-picker-logic";

/** Mutable account-picker state, owned by the modal's closure. `accountId`
 * is null only when the registry is empty or ambiguous (see
 * resolveInitialAccountId) - both cases start in "editing" so the user must
 * make an explicit pick before Start session is enabled. */
export interface AccountFieldState {
  accountId: string | null;
  editingAccount: boolean;
  remember: boolean;
}

/** Read-only context the modal already resolved before opening. */
export interface AccountFieldContext {
  accounts: Account[];
  preferredAccountId: string | null;
  resolvedAccountId: string | null;
  projectName: string;
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

  if (state.editingAccount || state.accountId === null) {
    return `
      <div class="me-acc-field">
        <label class="me-label">Account</label>
        <div class="me-acc-edit">
          ${accounts.map((a) => accountChipHtml(a, a.id === state.accountId, `data-acc-id="${escapeHtml(a.id)}"`)).join("")}
        </div>
      </div>
    `;
  }

  const chosen = accounts.find((a) => a.id === state.accountId)!;
  const showRemember = shouldOfferRemember(state.accountId, ctx.resolvedAccountId);
  return `
    <div class="me-acc-field">
      <label class="me-label">Account</label>
      <button type="button" class="me-acc-ghost">
        ${accountIconBadgeHtml(chosen)}
        <span class="me-acc-ghost-name">${escapeHtml(chosen.label)}</span>
        <i class="ph ph-caret-down"></i>
      </button>
      ${showRemember ? `
        <label class="me-remember">
          <input type="checkbox" class="me-remember-input"${state.remember ? " checked" : ""}>
          Remember <b>${escapeHtml(chosen.label)}</b> for <span class="path">${escapeHtml(ctx.projectName)}</span>
        </label>
      ` : ""}
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
  const openAccountEdit = () => { state.editingAccount = true; onChange(); };
  // Real <button>, unlike the .account-chip options below - no extra
  // keyboard-activation wiring needed, Enter/Space already work natively.
  overlay.querySelector<HTMLButtonElement>(".me-acc-ghost")?.addEventListener("click", openAccountEdit);
  overlay.querySelectorAll<HTMLElement>(".me-acc-edit .account-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.accId;
      if (!id) return;
      state.accountId = id;
      state.editingAccount = false;
      state.remember = false; // reset every time the pick changes
      onChange();
    });
  });
  overlay.querySelector<HTMLInputElement>(".me-remember-input")?.addEventListener("change", (e) => {
    state.remember = (e.target as HTMLInputElement).checked;
  });
  overlay.querySelector<HTMLButtonElement>(".me-acc-add-link")?.addEventListener("click", onAddAccount);
}
