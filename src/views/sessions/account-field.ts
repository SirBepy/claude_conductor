// Account-picker rendering/wiring for the new-chat modal (multi-account
// milestone 04). Split out of model-effort-modal.ts once that file's
// account-picker section grew large enough to warrant its own module,
// mirroring the earlier account-picker-logic.ts extraction of the pure
// resolution helpers. model-effort-modal.ts is the only caller; it owns the
// state object below in its closure and passes it in/out here.

import { escapeHtml } from "../../shared/escape-html";
import { accountChipHtml, isApiCreditAccount, type AccountLite } from "../../shared/account-chip";
import "../../shared/account-chip.css";

/** Mutable account-picker state, owned by the modal's closure. `accountId`
 * is null only when the registry is empty or ambiguous (see
 * resolveInitialAccountId), which gates "Start session" until the user
 * clicks a chip. */
export interface AccountFieldState {
  accountId: string | null;
}

/** Set when the accounts listed belong to ANOTHER machine (a chat aimed at a
 * paired peer): its name for the messages, and why the list could not be
 * loaded, if it could not. */
export interface AccountFieldMachine {
  label: string;
  error: string | null;
}

/** Read-only context the modal already resolved before opening. */
export interface AccountFieldContext {
  accounts: AccountLite[];
  machine?: AccountFieldMachine | null;
}

/** True while there is no usable account to spawn under: an empty registry
 * (the "add an account first" state), or an ambiguous one (multiple
 * accounts, no binding/default) the user hasn't resolved yet by picking a
 * chip. Gates "Start session" in both cases. */
export function accountPickIncomplete(state: AccountFieldState, accounts: readonly AccountLite[]): boolean {
  return accounts.length === 0 || state.accountId === null;
}

/** A peer's accounts carry their email so two similarly-labelled ones can be
 * told apart; the local picker shows label only, so this stays peer-only. */
function chipTitle(a: AccountLite & { email?: string }, machine: AccountFieldMachine | null | undefined): string {
  if (isApiCreditAccount(a)) return ` title="${escapeHtml("Bills the Max plan's monthly API credit")}"`;
  return machine && a.email ? ` title="${escapeHtml(a.email)}"` : "";
}

export function renderAccountFieldHtml(state: AccountFieldState, ctx: AccountFieldContext): string {
  const { accounts, machine } = ctx;
  // Another machine's registry can't be edited from here, so these two states
  // name that machine instead of pointing at this one's Settings. Start stays
  // gated either way (accountPickIncomplete), so a peer that can't be reached
  // never silently starts the chat on its default account.
  if (machine && (machine.error !== null || accounts.length === 0)) {
    const msg = machine.error !== null
      ? `Couldn't load ${escapeHtml(machine.label)}'s accounts: ${escapeHtml(machine.error)}`
      : `${escapeHtml(machine.label)} has no Claude accounts yet.`;
    return `
      <div class="me-acc-field me-acc-empty">
        <label class="me-label">Account</label>
        <div class="me-acc-empty-msg"><i class="ph ph-warning-circle"></i> ${msg}</div>
      </div>
    `;
  }
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

  // Exactly one account: the field renders nothing at all. todo 883 first
  // made it a non-interactive chip, on the reasoning that Joe should still see
  // which account spawns the session; he overruled that on 2026-09-26 - with
  // one account there is no other answer, so naming it is a row of dead
  // vertical space above the model slider. resolveInitialAccountId() already
  // resolves the sole account, so accountPickIncomplete() stays false and
  // "Start session" is never gated on a field nobody can see. A lone
  // API-credit account is the exception: it is never preselected, so its chip
  // has to be on screen to be clicked.
  if (accounts.length === 1 && !isApiCreditAccount(accounts[0])) return "";

  return `
    <div class="me-acc-field">
      <label class="me-label">Account</label>
      <div class="me-acc-edit">
        ${accounts.map((a) => accountChipHtml(a, a.id === state.accountId, `data-acc-id="${escapeHtml(a.id)}"${chipTitle(a, machine)}`)).join("")}
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
