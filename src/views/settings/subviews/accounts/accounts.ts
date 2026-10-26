// Settings > Accounts. Minimal list + add/remove/logout/set-default + the
// read-only terminal identity row (multi-account milestone 01 frontend).
// Full polish (drift warnings, token expiry, richer cards) is milestone 07 -
// see docs/multi-account/01-account-identity.md and 00-overview.md.

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, AccountIdentity, AuthState, OauthAccountInfo } from "../../../../shared/api";
import { accountIconBadgeHtml, isApiCreditAccount, linkedToLabel } from "../../../../shared/account-chip";
import { apiCreditLine } from "../../../../shared/api-credit-format";
import { watchApiCreditStatus, type ApiCreditStatusMap } from "../../../../shared/api-credit-watch";
import { openAddAccountFlow } from "./add-account-flow";
import { openEditAccountModal } from "./edit-account-modal";
import { askConfirm } from "../../../../shared/confirm";
import { showToast } from "../../../../shared/toast";
import { wireKebabMenu, closeKebabMenu } from "../../../../shared/kebab-menu";
import { buildIdentitySurface, LOGIN_POLL_INTERVAL_MS } from "./wizard-logic";
import { visibleInterval } from "../../../../shared/visible-interval";
import { settingsHeader } from "../../ui";
import { isRemote } from "../../../../shared/transport";
import type { ApiCreditStatus, ApiKeyStatus } from "../../../../types/ipc.generated";
import "../../../../shared/account-chip.css";
import "../../../../shared/kebab-menu.css";
import "./accounts.css";

// Per-row kebab wiring (ARIA/Escape/arrows via wireKebabMenu) is rebuilt on
// every refreshList() innerHTML rebuild, so prior disposers must run first or
// each refresh leaks a document-level listener.
let kebabDisposers: (() => void)[] = [];
// Only a refresh after the list has already loaded once (a user-triggered
// action) gets a toast on failure - the very first load shows the inline
// error card instead, so a broken backend doesn't double-surface.
let hasLoadedOnce = false;
// Last-loaded account list, so refreshTerminalIdentity() can match the
// terminal's observed email against a managed account without a second
// listAccounts() round-trip.
let lastAccounts: Account[] = [];
let lastSurfaces: Record<string, ReturnType<typeof buildIdentitySurface>> = {};
// Reauth spawns a detached /login terminal and returns immediately - nothing
// tells this view when the user finishes typing into it, so without a
// poller the list stays stale until the next manual refresh (the exact "I
// had to leave and come back" bug). One timer per account id, keyed so a
// second Reauth click on the same row replaces rather than stacks.
const REAUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;
let reauthPollers: Map<string, () => void> = new Map();
// Shared by refreshTerminalIdentity()'s two no-managed-account branches (not
// logged in at all, and logged in but unmatched) - reuses the same badge
// src/shared/account-chip.ts renders for every other account icon on this
// page rather than a one-off terminal-row copy.
const TERMINAL_FALLBACK_ICON_HTML = accountIconBadgeHtml({ icon: "terminal-window", colour: "var(--sb-muted)", label: "" });

// ── API-credit accounts ───────────────────────────────────────────────────
// Rows for the account kind whose chats bill the Max plan's monthly API credit.
// They have no OAuth login, so no identity/token lines, no Reauth, no Connect
// usage and never "default"; the figures come from the Console instead
// (api-credit-watch.ts), and Connect Console is their one login.

/** Latest Console figures per account id, fed by watchApiCreditStatus. */
let creditStatuses: ApiCreditStatusMap = {};
/** Live subscription to those figures. Started only once an API-credit account
 * is in the list, so a subscription-only setup never asks for them. */
let stopCreditWatch: (() => void) | null = null;

function ensureCreditWatch(root: HTMLElement, accounts: readonly Account[]): void {
  if (stopCreditWatch || !accounts.some(isApiCreditAccount)) return;
  stopCreditWatch = watchApiCreditStatus((map) => {
    creditStatuses = map;
    paintCreditStatuses(root);
  });
}
/** Accounts with a Console login window open, so a second click can't open another. */
const connectingConsole = new Set<string>();

function creditStatusHtml(id: string, status: ApiCreditStatus | undefined): string {
  const line = apiCreditLine(status);
  const connect = line.needsConnect
    ? ` <button type="button" class="acc-link-btn acc-credit-connect" data-id="${escapeHtml(id)}">Connect Console</button>`
    : "";
  return [
    line.summary
      ? `<span class="acc-sub">${escapeHtml(line.summary)}</span>`
      : line.error ? "" : `<span class="acc-sub">No figures yet</span>`,
    line.error ? `<span class="acc-sub">${escapeHtml(line.error)}${connect}</span>` : "",
    line.blockReason ? `<span class="acc-drift-warning"><i class="ph ph-warning"></i> ${escapeHtml(line.blockReason)}</span>` : "",
  ].join("");
}

function apiCreditRowHtml(account: Account, accounts: readonly Account[]): string {
  const id = escapeHtml(account.id);
  const linked = linkedToLabel(account, accounts);
  return `
    <div class="acc-row acc-row-credit" data-id="${id}" style="--acc:${escapeHtml(account.colour)}">
      ${accountIconBadgeHtml(account)}
      <span class="acc-info">
        <span class="acc-label">${escapeHtml(account.label)}</span>
        ${linked ? `<span class="acc-sub acc-linked">${escapeHtml(linked)}</span>` : ""}
        <span class="acc-credit" data-id="${id}">${creditStatusHtml(account.id, creditStatuses[account.id])}</span>
      </span>
      <span class="acc-actions">
        <div class="menu-anchor">
          <button class="icon-btn acc-btn-kebab" data-id="${id}" title="More options" aria-label="More options"><i class="ph ph-dots-three-vertical"></i></button>
          <div class="menu-popover hidden" data-id="${id}">
            <button class="menu-item acc-menu-edit" data-id="${id}"><i class="ph ph-pencil-simple"></i> Edit</button>
            <button class="menu-item acc-menu-connect-console" data-id="${id}"><i class="ph ph-link"></i> Connect Console</button>
            <button class="menu-item acc-menu-refresh-credit" data-id="${id}"><i class="ph ph-arrow-clockwise"></i> Refresh balance</button>
            <div class="menu-sep"></div>
            <button class="menu-item danger acc-menu-remove" data-id="${id}"><i class="ph ph-trash"></i> Remove</button>
          </div>
        </div>
      </span>
    </div>
  `;
}

/** Repaints the status lines in place: figures arrive on a 5 minute cycle and
 * after each turn, and a full refreshList() would rebuild every row's menu. */
function paintCreditStatuses(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".acc-credit[data-id]").forEach((el) => {
    const id = el.dataset["id"];
    if (id) el.innerHTML = creditStatusHtml(id, creditStatuses[id]);
  });
}

async function connectConsole(root: HTMLElement, accountId: string): Promise<void> {
  if (connectingConsole.has(accountId)) return;
  connectingConsole.add(accountId);
  showToast("A browser window opened for platform.claude.com. Sign in there and this row updates itself.");
  try {
    creditStatuses = { ...creditStatuses, [accountId]: await api.connectConsoleLogin(accountId) };
    paintCreditStatuses(root);
  } catch (e) {
    console.error("[settings-accounts] connectConsoleLogin failed", e);
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    connectingConsole.delete(accountId);
  }
}

async function refreshCredit(root: HTMLElement, accountId: string): Promise<void> {
  try {
    creditStatuses = { ...creditStatuses, [accountId]: await api.refreshApiCreditStatus(accountId) };
    paintCreditStatuses(root);
  } catch (e) {
    console.error("[settings-accounts] refreshApiCreditStatus failed", e);
    showToast(e instanceof Error ? e.message : String(e));
  }
}

function accountRowHtml(account: Account, defaultAccountId: string | null, surface: ReturnType<typeof buildIdentitySurface>): string {
  const isDefault = account.id === defaultAccountId;
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
        <span class="acc-sub acc-sub-expiry">${escapeHtml(surface.refreshExpiryLabel)}</span>
        ${surface.warningMessage ? `<span class="acc-drift-warning"><i class="ph ph-warning"></i> ${escapeHtml(surface.warningMessage)}</span>` : ""}
      </span>
      <span class="acc-actions">
        <div class="menu-anchor">
          <button class="icon-btn acc-btn-kebab" data-id="${id}" title="More options" aria-label="More options"><i class="ph ph-dots-three-vertical"></i></button>
          <div class="menu-popover hidden" data-id="${id}">
            <button class="menu-item acc-menu-edit" data-id="${id}"><i class="ph ph-pencil-simple"></i> Edit</button>
            ${!isDefault ? `<button class="menu-item acc-menu-default" data-id="${id}"><i class="ph ph-star"></i> Set as default</button>` : ""}
            <button class="menu-item acc-menu-reauth" data-id="${id}"><i class="ph ph-arrow-clockwise"></i> Reauth</button>
            <div class="menu-sep"></div>
            <button class="menu-item acc-menu-add-cookie" data-id="${id}"><i class="ph ph-link"></i> Connect usage</button>
            <button class="menu-item acc-menu-logout" data-id="${id}"><i class="ph ph-sign-out"></i> Log out</button>
            <button class="menu-item danger acc-menu-remove" data-id="${id}"><i class="ph ph-trash"></i> Remove</button>
          </div>
        </div>
      </span>
    </div>
  `;
}

function emptyStateHtml(): string {
  return `
    <div class="v-empty">
      <i class="ph ph-user-circle v-empty-icon"></i>
      <div class="v-empty-title">No accounts added yet</div>
      <div class="v-empty-hint">Click "Add account" below to connect your first Claude account.</div>
    </div>
  `;
}

function errorStateHtml(): string {
  return `
    <div class="v-empty">
      <i class="ph ph-warning v-empty-icon"></i>
      <div class="v-empty-title">Couldn't load accounts</div>
      <div class="v-empty-hint">Something went wrong talking to the backend.</div>
      <button class="btn-secondary" id="acc-retry-btn">Retry</button>
    </div>
  `;
}

async function refreshList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>("#acc-list");
  if (!list) return;

  kebabDisposers.forEach((dispose) => dispose());
  kebabDisposers = [];

  let accounts: Account[] = [];
  let defaultAccountId: string | null = null;
  let identities: Record<string, AccountIdentity | null> = {};
  let authStates: Record<string, AuthState> = {};
  let loadError = false;
  try {
    accounts = await api.listAccounts();
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
    // An API-credit account has no OAuth login to read an identity from; asking
    // would reject and turn the whole list into the error card.
    const [fetched, authStateMap] = await Promise.all([
      Promise.all(accounts.map((a) => (isApiCreditAccount(a) ? null : api.getAccountIdentity(a.id)))),
      api.getAuthStateMap(),
    ]);
    identities = Object.fromEntries(accounts.map((a, i) => [a.id, fetched[i] ?? null]));
    authStates = authStateMap;
  } catch (e) {
    console.error("[settings-accounts] refreshList failed", e);
    loadError = true;
    if (hasLoadedOnce) showToast("Couldn't refresh accounts - see the console.");
  }

  if (loadError) {
    list.innerHTML = errorStateHtml();
    list.querySelector<HTMLButtonElement>("#acc-retry-btn")?.addEventListener("click", () => void refreshList(root));
    return;
  }
  hasLoadedOnce = true;
  lastAccounts = accounts;
  lastSurfaces = Object.fromEntries(
    accounts
      .filter((a) => !isApiCreditAccount(a))
      .map((a) => [a.id, buildIdentitySurface(a, identities[a.id] ?? null, authStates[a.id])]),
  );

  list.innerHTML = accounts.length === 0
    ? emptyStateHtml()
    : accounts
        .map((a) => (isApiCreditAccount(a) ? apiCreditRowHtml(a, accounts) : accountRowHtml(a, defaultAccountId, lastSurfaces[a.id]!)))
        .join("");
  ensureCreditWatch(root, accounts);

  // Each row's kebab gets its own ARIA/Escape/arrow-key wiring; the capture
  // listener registered once in renderAccountsSettingsView enforces
  // one-open-at-a-time across rows before this per-row handler runs.
  list.querySelectorAll<HTMLElement>(".menu-anchor").forEach((anchor) => {
    const btn = anchor.querySelector<HTMLButtonElement>(".acc-btn-kebab");
    const popover = anchor.querySelector<HTMLElement>(".menu-popover");
    if (btn && popover) kebabDisposers.push(wireKebabMenu(btn, popover));
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
          const before = await api.getAccountIdentity(id).catch(() => null);
          await api.reauthAccount(id);
          showToast("A terminal opened for /login - this screen will refresh itself once you finish.");
          startReauthPoll(root, id, before?.tokenExpiresAt ?? null);
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
          showToast(e instanceof Error ? e.message : "Connecting usage tracking failed - see the console.");
        }
      })();
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-connect-console").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (id) void connectConsole(root, id);
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-refresh-credit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (id) void refreshCredit(root, id);
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      const row = accounts.find((a) => a.id === id);
      const label = row?.label ?? "this account";
      const prompt = isApiCreditAccount(row)
        ? `Remove ${label}? Chats can no longer be started on it.`
        : `Remove ${label}? This deletes its profile folder (and its browser/cookie login) - it never touches ~/.claude.`;
      void (async () => {
        if (!(await askConfirm(prompt, { confirmLabel: "Remove" }))) return;
        try { await api.removeAccount(id); await refreshList(root); }
        catch (e) {
          console.error("[settings-accounts] removeAccount failed", e);
          showToast(e instanceof Error ? e.message : "Removing the account failed - see the console.");
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
      list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((p) => closeKebabMenu(p));
      const account = accounts.find((a) => a.id === id);
      if (!account) return;
      void openEditAccountModal(account).then((updated) => { if (updated) void refreshList(root); });
    });
  });
}

/** Polls an account's identity (whileHidden: true - the whole point is
 * noticing while the user is over in the spawned /login terminal, not this
 * window) until its token is refreshed, then auto-refreshes the list in
 * place. Self-disposes on success, timeout, or a repeat Reauth click. */
function startReauthPoll(root: HTMLElement, accountId: string, baselineTokenExpiresAt: bigint | null): void {
  reauthPollers.get(accountId)?.();

  const startedAt = Date.now();
  const dispose = visibleInterval(
    () => {
      void (async () => {
        if (Date.now() - startedAt > REAUTH_POLL_TIMEOUT_MS) {
          dispose();
          reauthPollers.delete(accountId);
          return;
        }
        let identity: AccountIdentity | null = null;
        try { identity = await api.getAccountIdentity(accountId); }
        catch { return; }
        if (!identity || identity.tokenExpiresAt == null || identity.tokenExpiresAt === baselineTokenExpiresAt) return;
        dispose();
        reauthPollers.delete(accountId);
        await refreshList(root);
        await refreshTerminalIdentity(root);
        showToast("Logged in - identity refreshed.");
      })();
    },
    LOGIN_POLL_INTERVAL_MS,
    { whileHidden: true, reason: "detect /login completion in the spawned reauth terminal while this window is unfocused" },
  );
  reauthPollers.set(accountId, dispose);
}

async function refreshTerminalIdentity(root: HTMLElement): Promise<void> {
  const el = root.querySelector<HTMLElement>("#acc-terminal-identity");
  if (!el) return;
  let identity: OauthAccountInfo | null = null;
  try { identity = await api.getTerminalIdentity(); }
  catch (e) { console.error("[settings-accounts] getTerminalIdentity failed", e); }

  if (!identity) {
    el.style.removeProperty("--acc");
    el.innerHTML = `
      ${TERMINAL_FALLBACK_ICON_HTML}
      <span class="acc-info">
        <span class="acc-label">Not logged in</span>
        <span class="acc-sub">Run <code>/login</code> in a terminal to connect it here.</span>
      </span>
    `;
    return;
  }

  // Ties the raw oauthAccount email back to a managed account, if one
  // shares the login, so this reads as "which profile is the terminal on"
  // instead of a bare copy-pasted email string.
  const match = lastAccounts.find((a) => lastSurfaces[a.id]?.loggedInAsEmail === identity!.emailAddress);
  const badgeHtml = match ? accountIconBadgeHtml(match) : TERMINAL_FALLBACK_ICON_HTML;
  const subLine = match
    ? `Same login as <strong>${escapeHtml(match.label)}</strong> &middot; ${escapeHtml(identity.emailAddress)}`
    : escapeHtml(identity.emailAddress) + (identity.organizationName ? ` &middot; ${escapeHtml(identity.organizationName)}` : "");

  if (match) el.style.setProperty("--acc", match.colour);
  else el.style.removeProperty("--acc");
  el.innerHTML = `
    ${badgeHtml}
    <span class="acc-info">
      <span class="acc-label">Terminal</span>
      <span class="acc-sub">${subLine}</span>
    </span>
  `;
}

// ── API keys ──────────────────────────────────────────────────────────────
// Lists the registry (src-tauri/src/api_keys.rs) with set/not-set status;
// Add/Replace opens the shared api-key-modal.ts, which does the actual write.
// Desktop-only - hidden on the phone transport in template() below, matching
// the modal itself (set_api_key is never called over the phone transport).

function apiKeyRowHtml(k: ApiKeyStatus): string {
  return `
    <div class="kit-row api-key-row" data-env="${escapeHtml(k.env_name)}">
      <span class="kit-row-label">${escapeHtml(k.label)}</span>
      <span class="api-key-status${k.is_set ? " is-set" : ""}"><i class="ph ${k.is_set ? "ph-check-circle" : "ph-circle-dashed"}"></i>${k.is_set ? "Set" : "Not set"}</span>
      <button type="button" class="btn-secondary api-key-btn" data-env="${escapeHtml(k.env_name)}">${k.is_set ? "Replace" : "Add"}</button>
    </div>`;
}

let apiKeysWired = false;

async function refreshApiKeysSection(): Promise<void> {
  const list = document.getElementById("apiKeysList");
  if (!list) return;
  const keys = await api.listApiKeys();
  list.innerHTML = keys.map(apiKeyRowHtml).join("");

  // Delegated listener bound once to the stable container, same pattern as
  // refreshList().
  if (!apiKeysWired) {
    apiKeysWired = true;
    list.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest<HTMLButtonElement>("button.api-key-btn");
      const env = btn?.dataset.env;
      if (!env) return;
      void (async () => {
        const { openApiKeyModal } = await import("../../../../shared/api-key-modal");
        const saved = await openApiKeyModal(env);
        if (saved) await refreshApiKeysSection();
      })();
    });
  }
}

export async function renderAccountsSettingsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const addBtn = root.querySelector<HTMLButtonElement>("#acc-add-btn");
  if (addBtn) {
    addBtn.onclick = () => {
      void (async () => {
        addBtn.disabled = true;
        try {
          const existing = await api.listAccounts();
          const created = await openAddAccountFlow(existing);
          if (created) await refreshList(root);
        } finally {
          addBtn.disabled = false;
        }
      })();
    };
  }

  // Outside-click/Escape/arrow-key handling is each row's own wireKebabMenu
  // instance (wired per refreshList() call); this capture listener only adds
  // one-open-at-a-time - it closes every other row's popover before a
  // kebab's own bubble-phase click handler (set by wireKebabMenu) toggles it.
  const list = root.querySelector<HTMLElement>("#acc-list");
  const onKebabClickCapture = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".acc-btn-kebab");
    if (!btn || !list) return;
    const thisMenu = btn.nextElementSibling as HTMLElement | null;
    list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((menu) => {
      if (menu !== thisMenu) closeKebabMenu(menu);
    });
  };
  list?.addEventListener("click", onKebabClickCapture, true);

  // The inline "Connect Console" link sits inside a status line that is
  // repainted in place, so it is delegated rather than bound per render.
  const onConnectClick = (e: MouseEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".acc-credit-connect")?.dataset["id"];
    if (id) void connectConsole(root, id);
  };
  list?.addEventListener("click", onConnectClick);
  stopCreditWatch?.();
  stopCreditWatch = null;
  creditStatuses = {};

  try { await refreshList(root); }
  catch (e) { console.error("[settings-accounts] initial render failed", e); }
  try { await refreshTerminalIdentity(root); }
  catch (e) { console.error("[settings-accounts] terminal identity failed", e); }

  if (!isRemote()) {
    apiKeysWired = false;
    try { await refreshApiKeysSection(); }
    catch (e) { console.error("[settings-accounts api-keys] render failed", e); }
  }

  return () => {
    list?.removeEventListener("click", onKebabClickCapture, true);
    list?.removeEventListener("click", onConnectClick);
    stopCreditWatch?.();
    stopCreditWatch = null;
    kebabDisposers.forEach((dispose) => dispose());
    kebabDisposers = [];
    reauthPollers.forEach((dispose) => dispose());
    reauthPollers = new Map();
  };
}

function template() {
  return html`
    <div class="view view-settings-accounts">
      ${settingsHeader("Accounts")}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Claude accounts</div>
          <p class="acc-explainer">
            Each account gets its own <code>/login</code> and browser cookie, isolated from every
            other account and from your terminal's <code>~/.claude</code>.
          </p>
          <div id="acc-list" class="acc-list"></div>
          <div class="acc-add-row">
            <button class="btn-secondary" id="acc-add-btn"><i class="ph ph-plus"></i> Add account</button>
          </div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Terminal</div>
          <p class="acc-explainer">
            Your plain terminal's <code>~/.claude</code> is never an app account - it's just
            observed here so you know who it's currently logged in as.
          </p>
          <div id="acc-terminal-identity" class="acc-row acc-terminal-row">
            <span class="account-icon-badge" style="--acc:var(--sb-muted)"><i class="ph ph-circle-notch"></i></span>
            <span class="acc-info">
              <span class="acc-label">Terminal</span>
              <span class="acc-sub">Checking...</span>
            </span>
          </div>
        </div>

        ${isRemote() ? "" : html`
          <div class="kit-section" id="apiKeysSection">
            <div class="kit-section-title">API keys</div>
            <div id="apiKeysList" class="api-keys-list"></div>
          </div>
        `}

      </div>
    </div>
  `;
}
