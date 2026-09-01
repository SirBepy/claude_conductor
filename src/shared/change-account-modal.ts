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
import { api } from "./api";
import type { Account } from "./api";
import { escapeHtml } from "./escape-html";
import { accountChipHtml, attachChipKeyboardActivation } from "./account-chip";
import { lockInputToHost } from "./modal-input-lock";

export async function openChangeAccountModal(opts: {
  currentId: string | null;
  title?: string;
}): Promise<string | null> {
  const title = opts.title ?? "Change account";
  const accounts = await api.listAccounts();

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
      const bodyHtml = accounts.length === 0
        ? `<div class="cc-modal-empty">No Claude accounts configured yet.</div>`
        : `<div class="cam-account-list">${accounts
            .map((a: Account) => accountChipHtml(a, a.id === opts.currentId, `data-acc-id="${escapeHtml(a.id)}"`))
            .join("")}</div>`;

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
      overlay.querySelectorAll<HTMLElement>(".cam-account-list .account-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const id = chip.dataset.accId;
          if (id) close(id);
        });
      });
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
