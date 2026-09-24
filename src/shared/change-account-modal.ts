// Minimal account-picker modal shared by "Change account" (chat-menu.ts /
// active-session.ts statusline chip) and the manual-takeover account
// confirmation (active-session.ts). Reuses the generic cc-modal-* shell from
// change-character-modal.css and the account-chip visuals from account-chip.css
// rather than introducing a third picker UI (the new-chat picker in
// account-field.ts is intentionally NOT reused here - it owns a much larger
// "remember for this project" state machine that doesn't apply to an
// already-running chat).

import "./change-character-modal.css";
import "./account-chip.css";
import "./change-account-modal.css";
import "./modal.css";
import { api } from "./api";
import type { Account } from "./api";
import { escapeHtml } from "./escape-html";
import { accountChipHtml, accountIconBadgeHtml, attachChipKeyboardActivation } from "./account-chip";
import { lockInputToHost, registerSelectableOptions } from "./modal-input-lock";

/** The `.cc-modal-body` contents for the account list, split out so the
 * single-vs-multi-account branching is unit-testable without the modal's
 * DOM/IPC wiring. Exactly one account: nothing to pick (todo 883 - a
 * single-option picker is a confirmation, not a choice). Render it as a
 * static display, not a chip: no data-acc-id/role="button", so there is
 * nothing for the click handler in `openChangeAccountModal` to wire up. */
export function renderAccountListBodyHtml(accounts: Account[], currentId: string | null): string {
  if (accounts.length === 0) return `<div class="cc-modal-empty">No Claude accounts configured yet.</div>`;
  if (accounts.length === 1) {
    const a = accounts[0]!;
    return `<div class="cam-account-list"><span class="account-chip sel cam-acc-static" style="--acc:${escapeHtml(a.colour)}">${accountIconBadgeHtml(a)}${escapeHtml(a.label)}</span></div>`;
  }
  return `<div class="cam-account-list">${accounts
    .map((a: Account) => accountChipHtml(a, a.id === currentId, `data-acc-id="${escapeHtml(a.id)}"`))
    .join("")}</div>`;
}

export async function openChangeAccountModal(opts: {
  currentId: string | null;
  title?: string;
  /** Set by a caller that cannot proceed without an id (the history
   *  "Continue this chat" gate, the manual-takeover gate). With exactly one
   *  account those callers must get it back rather than a modal: the
   *  single-account body renders a static chip with no `data-acc-id`, so there
   *  is deliberately nothing to click and no `registerSelectableOptions` entry
   *  for Enter - the only exits are Escape and the close button, both of which
   *  resolve null and strand the caller on its `if (!id) return`. A
   *  "Change account" style caller leaves this off and keeps the static
   *  confirmation, which is a display, not a gate. */
  autoPickSole?: boolean;
}): Promise<string | null> {
  const title = opts.title ?? "Change account";
  const accounts = await api.listAccounts();

  if (opts.autoPickSole && accounts.length === 1) return accounts[0]!.id;

  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "cc-modal-overlay";

    const unlock = lockInputToHost(overlay);

    function close(result: string | null) {
      unlock();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function render() {
      const bodyHtml = renderAccountListBodyHtml(accounts, opts.currentId);

      overlay.innerHTML = `
        <div class="cc-modal-card cam-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="cc-modal-header">
            <h3 class="cc-modal-title">${escapeHtml(title)}</h3>
            <button type="button" class="cc-modal-close" title="Close"><i class="ph ph-x"></i></button>
          </div>
          <div class="cc-modal-body">${bodyHtml}</div>
        </div>
      `;

      overlay.querySelector<HTMLButtonElement>(".cc-modal-close")?.addEventListener("click", () => close(null));
      // [data-acc-id] excludes the single-account static span above: nothing
      // to wire a click/number-key/keyboard handler to when there's no pick.
      const chips = overlay.querySelectorAll<HTMLElement>(".cam-account-list .account-chip[data-acc-id]");
      chips.forEach((chip, i) => {
        chip.addEventListener("click", () => {
          const id = chip.dataset.accId;
          if (id) close(id);
        });
        if (i >= 9) return; // only 1-9 are reachable by number key
        chip.style.position = "relative";
        const badge = document.createElement("span");
        badge.className = "modal-option-badge";
        badge.textContent = String(i + 1);
        chip.appendChild(badge);
      });
      registerSelectableOptions(overlay, () => Array.from(chips));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    attachChipKeyboardActivation(overlay); // render() only runs once here - safe to attach once

    render();
  });
}
