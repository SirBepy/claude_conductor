// Settings > Accounts & models: every account a chat can run on, grouped by
// company (Accounts tab), and the routing rules per payment group (Who does what
// tab, mounted from models-providers.ts the first time its tab opens). Claude
// plan and API-credit rows keep their per-button wiring; Endpoint rows (Kimi
// Code, DeepSeek, OpenRouter, custom) use `data-act` buttons handled by one
// delegate. The API keys list is its own page (api-keys/api-keys.ts).

import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account, AccountIdentity, AuthState, OauthAccountInfo } from "../../../../shared/api";
import { accountIconBadgeHtml, isApiCreditAccount, isEndpointAccount } from "../../../../shared/account-chip";
import { openAddAccountFlow } from "./add-account-flow";
import { openEditAccountModal } from "./edit-account-modal";
import { apiCreditRowHtml, ensureCreditWatch, resetCreditRows, wireConnectConsoleLink, wireCreditRowMenus } from "./api-credit-rows";
import { askConfirm } from "../../../../shared/confirm";
import { showToast } from "../../../../shared/toast";
import { wireKebabMenu, closeKebabMenu } from "../../../../shared/kebab-menu";
import { buildIdentitySurface, LOGIN_POLL_INTERVAL_MS } from "./wizard-logic";
import { visibleInterval } from "../../../../shared/visible-interval";
import { settingsHeader } from "../../ui";
import { isRemote } from "../../../../shared/transport";
import { billChipHtml } from "../../../../shared/provider-meta";
import { takeRequestedGroupTab } from "../../../../shared/routing-rules";
import { accountRowHtml as endpointRowHtml } from "../models-providers/account-rows";
import { ensureProviderUsage, stopProviderUsage } from "../models-providers/provider-usage-rows";
import { openAddEndpointModal, openEditEndpointModal, openReplaceEndpointKeyModal } from "../models-providers/provider-modals";
import { sheetTemplate, whoTemplate, type WhoHandle } from "../models-providers/who-does-what";
import { ENDPOINT_COMPANIES, codexSectionHtml, legendHtml, sectionHtml, type AddTarget } from "./company-sections";
import "../../../../shared/account-chip.css";
import "../../../../shared/billing-chip.css";
import "../../../../shared/kebab-menu.css";
import "../models-providers/models-providers.css";
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

const isPlan = (a: Account): boolean => !isApiCreditAccount(a) && !isEndpointAccount(a);

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
        <span class="acc-label">${escapeHtml(account.label)}${billChipHtml("Subscription")}${isDefault ? `<span class="acc-default-badge">default</span>` : ""}</span>
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
    // An API-credit or Endpoint account has no OAuth login to read an identity
    // from; asking would reject and turn the whole list into the error card.
    const [fetched, authStateMap] = await Promise.all([
      Promise.all(accounts.map((a) => (isPlan(a) ? api.getAccountIdentity(a.id) : null))),
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
      .filter(isPlan)
      .map((a) => [a.id, buildIdentitySurface(a, identities[a.id] ?? null, authStates[a.id])]),
  );

  // The phone has no Endpoint path (the key never crosses that transport), so it
  // never lists one even when the PC has some.
  const shown = isRemote() ? accounts.filter((a) => !isEndpointAccount(a)) : accounts;
  const rowsOf = (pick: (a: Account) => boolean, draw: (a: Account) => string): string[] => shown.filter(pick).map(draw);
  list.innerHTML = legendHtml(isRemote())
    + sectionHtml({
      target: "anthropic",
      rows: [
        ...rowsOf(isPlan, (a) => accountRowHtml(a, defaultAccountId, lastSurfaces[a.id]!)),
        ...rowsOf(isApiCreditAccount, (a) => apiCreditRowHtml(a, accounts)),
      ],
      trailing: TERMINAL_ROW_HTML,
    })
    + (isRemote() ? "" : ENDPOINT_COMPANIES.map((preset) => sectionHtml({
      target: preset,
      rows: rowsOf((a) => isEndpointAccount(a) && (a.endpoint?.preset ?? "custom") === preset, endpointRowHtml),
    })).join("") + codexSectionHtml());
  ensureCreditWatch(root, accounts);
  if (!isRemote()) ensureProviderUsage(root, accounts);
  paintTerminal(root);
  const count = root.querySelector<HTMLElement>("#acm-cnt-accounts");
  if (count) count.textContent = String(shown.length);
  root.dispatchEvent(new CustomEvent("accounts-changed", { detail: accounts }));

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

  wireCreditRowMenus(list, root);

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

/** What the Terminal row last read; the list rebuild redraws the row from it, so a refresh never blanks it. */
let terminal: { loaded: boolean; identity: OauthAccountInfo | null } = { loaded: false, identity: null };

const TERMINAL_NOTE = `<span class="acc-sub">Your plain <code>~/.claude</code> is only observed here, never an app account.</span>`;

// Placeholder until the first read lands. Not an account: it is never counted
// toward "this company has accounts" and never offers the row's actions.
const TERMINAL_ROW_HTML = `<div id="acc-terminal-identity" class="acc-row acc-terminal-row mp-static">
  <span class="account-icon-badge" style="--acc:var(--sb-muted)"><i class="ph ph-circle-notch"></i></span>
  <span class="acc-info"><span class="acc-label">Terminal</span><span class="acc-sub">Checking...</span></span>
</div>`;

function paintTerminal(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>("#acc-terminal-identity");
  if (!el || !terminal.loaded) return;
  const identity = terminal.identity;

  if (!identity) {
    el.style.removeProperty("--acc");
    el.innerHTML = `
      ${TERMINAL_FALLBACK_ICON_HTML}
      <span class="acc-info">
        <span class="acc-label">Not logged in</span>
        <span class="acc-sub">Run <code>/login</code> in a terminal to connect it here.</span>
        ${TERMINAL_NOTE}
      </span>
    `;
    return;
  }

  // Ties the raw oauthAccount email back to a managed account, if one
  // shares the login, so this reads as "which profile is the terminal on"
  // instead of a bare copy-pasted email string.
  const match = lastAccounts.find((a) => lastSurfaces[a.id]?.loggedInAsEmail === identity.emailAddress);
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
      ${TERMINAL_NOTE}
    </span>
  `;
}

async function refreshTerminalIdentity(root: HTMLElement): Promise<void> {
  let identity: OauthAccountInfo | null = null;
  try { identity = await api.getTerminalIdentity(); }
  catch (e) { console.error("[settings-accounts] getTerminalIdentity failed", e); }
  terminal = { loaded: true, identity };
  paintTerminal(root);
}

// ── Endpoint rows ─────────────────────────────────────────────────────────
// Kimi Code, DeepSeek, OpenRouter and custom accounts: their kebab items carry
// `data-act`, handled by one delegate on the list.

async function runEndpointAction(root: HTMLElement, act: string, account: Account): Promise<void> {
  try {
    if (act === "edit") {
      if (await openEditEndpointModal(account)) await refreshList(root);
    } else if (act === "key") {
      if (await openReplaceEndpointKeyModal(account)) showToast("API key replaced.");
    } else if (act === "remove") {
      const text = `Remove ${account.label}? Its stored key is deleted. A role that uses it goes back to the default.`;
      if (!(await askConfirm(text, { confirmLabel: "Remove" }))) return;
      await api.removeAccount(account.id);
      await refreshList(root);
    }
  } catch (e) {
    console.error("[settings-accounts] endpoint action failed", act, e);
    showToast(e instanceof Error ? e.message : String(e));
  }
}

/** Opens the add flow of one company: Anthropic's kind card, or that provider's own form. */
async function addFor(root: HTMLElement, target: AddTarget): Promise<void> {
  const existing = await api.listAccounts();
  const created = target === "anthropic" ? await openAddAccountFlow(existing) : await openAddEndpointModal(target);
  if (created) await refreshList(root);
}

// ── Page ──────────────────────────────────────────────────────────────────

type PageTab = "accounts" | "who";

export async function renderAccountsSettingsView(root: HTMLElement): Promise<() => void> {
  const remote = isRemote();
  terminal = { loaded: false, identity: null };
  render(template(remote), root);
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const list = q("#acc-list");

  // One Add open at a time: a second click while the first card is up would stack two flows.
  let adding = false;
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const add = target.closest<HTMLElement>("[data-add]");
    if (add) {
      if (adding) return;
      adding = true;
      void addFor(root, add.dataset["add"] as AddTarget)
        .catch((err) => {
          console.error("[settings-accounts] add flow failed", err);
          showToast(err instanceof Error ? err.message : String(err));
        })
        .finally(() => { adding = false; });
      return;
    }
    const item = target.closest<HTMLElement>(".menu-item[data-act]");
    if (!item) return;
    const account = lastAccounts.find((a) => a.id === item.dataset["id"]);
    list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((p) => closeKebabMenu(p));
    if (account) void runEndpointAction(root, item.dataset["act"]!, account);
  });

  // Outside-click/Escape/arrow-key handling is each row's own wireKebabMenu
  // instance (wired per refreshList() call); this capture listener only adds
  // one-open-at-a-time - it closes every other row's popover before a
  // kebab's own bubble-phase click handler (set by wireKebabMenu) toggles it.
  const onKebabClickCapture = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".acc-btn-kebab");
    if (!btn) return;
    const thisMenu = btn.nextElementSibling as HTMLElement | null;
    list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((menu) => {
      if (menu !== thisMenu) closeKebabMenu(menu);
    });
  };
  list.addEventListener("click", onKebabClickCapture, true);

  resetCreditRows();
  stopProviderUsage();
  const unwireConnectLink = wireConnectConsoleLink(list, root);

  // Who does what loads the first time its tab opens (or at once when a link asked for a group).
  let who: Promise<WhoHandle> | null = null;
  let disposed = false;
  const mountWho = (initialGroup: string | null): Promise<WhoHandle> => {
    who ??= import("../models-providers/models-providers")
      .then((m) => m.mountWhoDoesWhat(root, { initialGroup }))
      // A failed load is not kept, so the next click on the tab tries again.
      .catch((e: unknown) => { who = null; throw e; });
    return who;
  };

  let tab: PageTab = "accounts";
  const tabsEl = root.querySelector<HTMLElement>("#acm-tabs");
  const moveInd = (): void => {
    const t = root.querySelector<HTMLElement>(".acm-tab.on");
    const ind = root.querySelector<HTMLElement>("#acm-ind");
    if (!t || !ind || !t.offsetWidth) return;
    ind.style.width = `${t.offsetWidth}px`;
    ind.style.transform = `translateX(${t.offsetLeft}px)`;
  };
  const selectTab = (next: PageTab, initialGroup: string | null = null): void => {
    tab = next;
    root.querySelectorAll<HTMLElement>(".acm-tab").forEach((t) => {
      const on = t.dataset["tab"] === next;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>(".acm-panel").forEach((p) => {
      const on = p.dataset["tab"] === next;
      p.hidden = !on;
      p.toggleAttribute("inert", !on);
    });
    moveInd();
    if (next === "who") {
      void mountWho(initialGroup)
        .then((h) => { if (!disposed) h.fit(); })
        .catch((e) => console.error("[settings-accounts] who does what failed", e));
    }
  };
  tabsEl?.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".acm-tab");
    if (t) selectTab(t.dataset["tab"] as PageTab);
  });
  tabsEl?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next: PageTab = tab === "accounts" ? "who" : "accounts";
    selectTab(next);
    q(`#acm-tab-${next}`).focus();
  });
  const onResize = (): void => moveInd();
  window.addEventListener("resize", onResize);
  // The account count in the tab changes its width, and so where the underline sits.
  root.addEventListener("accounts-changed", onResize);

  // A link from a project's rail names a group: land on its tab, not the accounts.
  const asked = remote ? null : takeRequestedGroupTab();
  if (asked) selectTab("who", asked);
  requestAnimationFrame(() => requestAnimationFrame(moveInd));

  try { await refreshList(root); }
  catch (e) { console.error("[settings-accounts] initial render failed", e); }
  try { await refreshTerminalIdentity(root); }
  catch (e) { console.error("[settings-accounts] terminal identity failed", e); }

  return () => {
    disposed = true;
    window.removeEventListener("resize", onResize);
    root.removeEventListener("accounts-changed", onResize);
    list.removeEventListener("click", onKebabClickCapture, true);
    unwireConnectLink();
    resetCreditRows();
    stopProviderUsage();
    kebabDisposers.forEach((dispose) => dispose());
    kebabDisposers = [];
    reauthPollers.forEach((dispose) => dispose());
    reauthPollers = new Map();
    void who?.then((h) => h.dispose()).catch(() => { /* never mounted, nothing to dispose */ });
  };
}

function template(remote: boolean) {
  return html`
    <div class="view view-settings-accounts view-settings-models-providers">
      <div class="mp-page" id="mp-page">
        ${settingsHeader("Accounts & models")}
        <div class="view-body">
          <div class="view-body-inner mp-inner">
            ${remote ? "" : html`
              <div class="mp-tabs acm-tabs" id="acm-tabs" role="tablist">
                <button type="button" class="mp-tab acm-tab on" role="tab" id="acm-tab-accounts" data-tab="accounts" aria-selected="true" aria-controls="acm-panel-accounts"><i class="ph ph-user-circle"></i> Accounts <span class="cnt" id="acm-cnt-accounts"></span></button>
                <button type="button" class="mp-tab acm-tab" role="tab" id="acm-tab-who" data-tab="who" aria-selected="false" aria-controls="acm-panel-who" tabindex="-1"><i class="ph ph-plugs-connected"></i> Who does what</button>
                <span class="mp-ind" id="acm-ind"></span>
              </div>`}
            <div class="acm-panel" id="acm-panel-accounts" role="tabpanel" data-tab="accounts">
              <div id="acc-list" class="acm-companies"></div>
            </div>
            ${remote ? "" : html`
              <div class="acm-panel" id="acm-panel-who" role="tabpanel" data-tab="who" hidden inert aria-labelledby="acm-tab-who">
                ${whoTemplate()}
              </div>`}
          </div>
        </div>
      </div>
      ${remote ? "" : sheetTemplate()}
    </div>
  `;
}
