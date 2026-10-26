// Settings > Accounts' single "Add account" entry: ask which kind of account
// first, then hand off to that kind's own flow (the subscription wizard, or the
// API-credit form). The ask is a card on the shared modal host, built from the
// worktree picker's choice rows (`wt-picker-choice`) rather than a new widget.

import { html, render } from "lit-html";
import type { Account } from "../../../../shared/api";
import { closeHostCard, modalCardSlot, presentHostCard, registerHostOptions, setBackdropCancel } from "../../../../shared/modal";
import { isRemote } from "../../../../shared/transport";
import { openAddAccountWizard } from "./add-account-wizard";
import { openAddApiCreditModal } from "./add-api-credit-modal";
import "../../../../shared/modal.css";
import "../../../sessions/worktree-picker.css";
import "./add-account-flow.css";

export type AddAccountKind = "subscription" | "api_credit";

/** What the flow calls out to. Injected so the routing is testable without the
 * modal host or the wizard's DOM. */
export interface AddAccountFlowDeps {
  /** The phone has no API-credit path (the key never crosses that transport),
   * so it skips the question. */
  remote: boolean;
  pickKind: () => Promise<AddAccountKind | null>;
  /** Closes the kind card; called before a flow that draws its own overlay. */
  closeKindCard: () => void;
  openWizard: (existing: Account[]) => Promise<Account | null>;
  openApiCredit: () => Promise<Account | null>;
}

/** Resolves with the new account, or `null` when the user backs out anywhere. */
export async function runAddAccountFlow(existing: Account[], deps: AddAccountFlowDeps): Promise<Account | null> {
  if (deps.remote) return deps.openWizard(existing);
  const kind = await deps.pickKind();
  // The API-credit form lives on the same modal host, so it morphs from the
  // kind card; the wizard has its own overlay and needs the host gone first.
  if (kind === "api_credit") return deps.openApiCredit();
  deps.closeKindCard();
  return kind === "subscription" ? deps.openWizard(existing) : null;
}

const CHOICES: readonly { kind: AddAccountKind; icon: string; title: string; sub: string }[] = [
  {
    kind: "subscription",
    icon: "user",
    title: "Claude plan",
    sub: "Sign in with a Pro or Max account. Chats use your plan's usage limits.",
  },
  {
    kind: "api_credit",
    icon: "key",
    title: "API credit",
    sub: "Use an API key. Chats bill your Max plan's monthly API credit instead of your plan limits.",
  },
];

function pickKindOnHost(): Promise<AddAccountKind | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (kind: AddAccountKind | null): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      resolve(kind);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      finish(null);
    };
    document.addEventListener("keydown", onKey);
    setBackdropCancel(() => finish(null));

    void presentHostCard(() => {
      const slot = modalCardSlot();
      render(
        html`
          <div class="modal-card wt-picker-modal aac-kind-card" role="dialog" aria-modal="true" aria-label="Add account">
            <header class="modal-header"><h3>Add account</h3></header>
            <div class="modal-body wt-picker-body">
              ${CHOICES.map((c, i) => html`
                <button type="button" class="wt-picker-choice aac-kind-choice" data-kind=${c.kind} style="position:relative" @click=${() => finish(c.kind)}>
                  <i class="ph ph-${c.icon}"></i>
                  <div class="wt-picker-choice-text">
                    <span class="wt-picker-choice-title">${c.title}</span>
                    <span class="wt-picker-choice-sub aac-kind-sub">${c.sub}</span>
                  </div>
                  <span class="modal-option-badge">${i + 1}</span>
                </button>`)}
            </div>
            <footer class="modal-footer">
              <button type="button" class="btn btn-secondary aac-kind-cancel" @click=${() => finish(null)}>Cancel</button>
            </footer>
          </div>`,
        slot,
      );
      registerHostOptions(() => Array.from(slot.querySelectorAll<HTMLElement>(".aac-kind-choice")));
    });
  });
}

export function openAddAccountFlow(existing: Account[]): Promise<Account | null> {
  return runAddAccountFlow(existing, {
    remote: isRemote(),
    pickKind: pickKindOnHost,
    closeKindCard: closeHostCard,
    openWizard: openAddAccountWizard,
    openApiCredit: openAddApiCreditModal,
  });
}
