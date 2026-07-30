// Settings > Accounts. Minimal list + add/remove/logout/set-default + the
// read-only terminal identity row (multi-account milestone 01 frontend).
// Full polish (drift warnings, token expiry, richer cards) is milestone 07 -
// see docs/multi-account/01-account-identity.md and 00-overview.md.

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, AccountIdentity, OauthAccountInfo } from "../../../../shared/api";
import { accountIconBadgeHtml } from "../../../../shared/account-chip";
import { openAddAccountWizard } from "./add-account-wizard";
import { openEditAccountModal } from "./edit-account-modal";
import { askConfirm } from "../../../../shared/confirm";
import { buildIdentitySurface } from "./wizard-logic";
import "../../../../shared/account-chip.css";
import "../../../../shared/kebab-menu.css";
import "./accounts.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}
function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function accountRowHtml(account: Account, defaultAccountId: string | null, identity: AccountIdentity | null): string {
  const isDefault = account.id === defaultAccountId;
  const surface = buildIdentitySurface(account, identity);
  const loggedInLine = surface.loggedInAsEmail
    ? `Logged in as ${surface.loggedInAsEmail} &middot; ${escapeHtml(surface.tierLabel)}`
    : `Registered as ${escapeHtml(account.email)} &middot; ${escapeHtml(surface.tierLabel)}`;
  const id = escapeHtml(account.id);
  return `
    <div class="acc-row" data-id="${id}" style="--acc:${escapeHtml(account.colour)}">
      ${accountIconBadgeHtml(account)}
      <span class="acc-info">
        <span class="acc-label">${escapeHtml(account.label)}${isDefault ? `<span class="acc-default-badge">default</span>` : ""}</span>
        <span class="acc-sub">${loggedInLine}</span>
        <span class="acc-sub acc-sub-expiry">${escapeHtml(surface.tokenExpiryLabel)}</span>
        ${surface.warningMessage ? `<span class="acc-drift-warning"><i class="ph ph-warning"></i> ${escapeHtml(surface.warningMessage)}</span>` : ""}
      </span>
      <span class="acc-actions">
        <div class="menu-anchor">
          <button class="icon-btn acc-btn-kebab" data-id="${id}" title="More options"><i class="ph ph-dots-three-vertical"></i></button>
          <div class="menu-popover" data-id="${id}" hidden>
            <button class="menu-item acc-menu-edit" data-id="${id}"><i class="ph ph-pencil-simple"></i> Edit</button>
            ${!isDefault ? `<button class="menu-item acc-menu-default" data-id="${id}"><i class="ph ph-star"></i> Set as default</button>` : ""}
            <button class="menu-item acc-menu-reauth" data-id="${id}"><i class="ph ph-arrow-clockwise"></i> Reauth</button>
            <div class="menu-sep"></div>
            ${!surface.hasCookie ? `<button class="menu-item acc-menu-add-cookie" data-id="${id}"><i class="ph ph-link"></i> Connect usage</button>` : ""}
            <button class="menu-item acc-menu-logout" data-id="${id}"><i class="ph ph-sign-out"></i> Log out</button>
            <button class="menu-item danger acc-menu-remove" data-id="${id}"><i class="ph ph-trash"></i> Remove</button>
          </div>
        </div>
      </span>
    </div>
  `;
}

async function refreshList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>("#acc-list");
  const empty = root.querySelector<HTMLElement>("#acc-empty");
  if (!list) return;

  let accounts: Account[] = [];
  let defaultAccountId: string | null = null;
  let identities: Record<string, AccountIdentity | null> = {};
  try {
    accounts = await api.listAccounts();
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
    const fetched = await Promise.all(accounts.map((a) => api.getAccountIdentity(a.id)));
    identities = Object.fromEntries(accounts.map((a, i) => [a.id, fetched[i] ?? null]));
  } catch (e) {
    console.error("[settings-accounts] refreshList failed", e);
  }

  if (empty) empty.style.display = accounts.length === 0 ? "" : "none";
  list.innerHTML = accounts.map((a) => accountRowHtml(a, defaultAccountId, identities[a.id] ?? null)).join("");

  // Kebab menu: one popover open at a time, closed by the document-level
  // listener registered once in renderAccountsSettingsView (outside click) or
  // right here after any menu action runs.
  list.querySelectorAll<HTMLButtonElement>(".acc-btn-kebab").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const popover = list.querySelector<HTMLElement>(`.menu-popover[data-id="${CSS.escape(id ?? "")}"]`);
      if (!popover) return;
      const wasHidden = popover.hidden;
      list.querySelectorAll<HTMLElement>(".menu-popover").forEach((p) => { p.hidden = true; });
      popover.hidden = !wasHidden;
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-default").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        try { await api.setDefaultAccount(id); await refreshList(root); }
        catch (e) { console.error("[settings-accounts] setDefaultAccount failed", e); }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-logout").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        try { await api.logoutAccount(id); await refreshList(root); }
        catch (e) { console.error("[settings-accounts] logoutAccount failed", e); }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-reauth").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        try {
          await api.reauthAccount(id);
          alert("A terminal opened for /login. Run it, then reopen this screen to see the refreshed identity.");
        } catch (e) {
          console.error("[settings-accounts] reauthAccount failed", e);
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-add-cookie").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      void (async () => {
        try { await api.recaptureAccountCookie(id); await refreshList(root); }
        catch (e) {
          console.error("[settings-accounts] recaptureAccountCookie failed", e);
          alert(e instanceof Error ? e.message : "Connecting usage tracking failed - see the console.");
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      const row = accounts.find((a) => a.id === id);
      const label = row?.label ?? "this account";
      void (async () => {
        if (!(await askConfirm(`Remove ${label}? This deletes its profile folder (and its browser/cookie login) - it never touches ~/.claude.`, { confirmLabel: "Remove" }))) return;
        try { await api.removeAccount(id); await refreshList(root); }
        catch (e) {
          console.error("[settings-accounts] removeAccount failed", e);
          alert(e instanceof Error ? e.message : "Removing the account failed - see the console.");
        }
      })();
    });
  });

  // Edit: opened from the kebab's Edit item as a real modal (rename/icon/
  // colour + the projects-bound-to-this-account list, both tabs of one
  // modal - see edit-account-modal.ts).
  list.querySelectorAll<HTMLButtonElement>(".acc-menu-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      list.querySelectorAll<HTMLElement>(".menu-popover").forEach((p) => { p.hidden = true; });
      const account = accounts.find((a) => a.id === id);
      if (!account) return;
      void openEditAccountModal(account).then((updated) => { if (updated) void refreshList(root); });
    });
  });
}

async function refreshTerminalIdentity(root: HTMLElement): Promise<void> {
  const el = root.querySelector<HTMLElement>("#acc-terminal-identity");
  if (!el) return;
  let identity: OauthAccountInfo | null = null;
  try { identity = await api.getTerminalIdentity(); }
  catch (e) { console.error("[settings-accounts] getTerminalIdentity failed", e); }
  el.textContent = identity
    ? `Terminal: currently ${identity.emailAddress}`
    : "Terminal: not logged in (or identity unreadable)";
}

export async function renderAccountsSettingsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  const addBtn = root.querySelector<HTMLButtonElement>("#acc-add-btn");
  if (addBtn) {
    addBtn.onclick = () => {
      void (async () => {
        addBtn.disabled = true;
        try {
          const existing = await api.listAccounts();
          const created = await openAddAccountWizard(existing);
          if (created) await refreshList(root);
        } finally {
          addBtn.disabled = false;
        }
      })();
    };
  }

  // Close any open kebab popover on an outside click. Registered once for the
  // view's lifetime (refreshList re-renders the list body on every action, so
  // this can't live inside it without leaking a listener per refresh).
  const onDocClick = (e: MouseEvent) => {
    const list = root.querySelector<HTMLElement>("#acc-list");
    if (!list) return;
    const target = e.target as Node;
    list.querySelectorAll<HTMLElement>(".menu-popover:not([hidden])").forEach((popover) => {
      if (!popover.contains(target) && !popover.previousElementSibling?.contains(target)) {
        popover.hidden = true;
      }
    });
  };
  document.addEventListener("click", onDocClick);

  try { await refreshList(root); }
  catch (e) { console.error("[settings-accounts] initial render failed", e); }
  try { await refreshTerminalIdentity(root); }
  catch (e) { console.error("[settings-accounts] terminal identity failed", e); }

  return () => { document.removeEventListener("click", onDocClick); };
}

function template() {
  return html`
    <div class="view view-settings-accounts">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>Accounts</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Claude accounts</div>
          <p class="acc-explainer">
            Each account gets its own <code>/login</code> and browser cookie, isolated from every
            other account and from your terminal's <code>~/.claude</code>.
          </p>
          <div id="acc-list" class="acc-list"></div>
          <p id="acc-empty" class="acc-empty">No accounts added yet.</p>
          <button class="btn-secondary" id="acc-add-btn"><i class="ph ph-plus"></i> Add account</button>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Terminal</div>
          <p class="acc-explainer">
            Your plain terminal's <code>~/.claude</code> is never an app account - it's just
            observed here so you know who it's currently logged in as.
          </p>
          <div class="kit-row">
            <span id="acc-terminal-identity" class="acc-terminal-identity">Terminal: checking...</span>
          </div>
        </div>

      </div>
    </div>
  `;
}
