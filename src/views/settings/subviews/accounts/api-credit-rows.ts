// Settings > Accounts rows for the account kind whose chats bill the Max plan's
// monthly API credit. They have no OAuth login, so no identity/token lines, no
// Reauth, no Connect usage and never "default"; the figures come from the
// Console instead (api-credit-watch.ts), and Connect Console is their one login.

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { accountIconBadgeHtml, linkedToLabel } from "../../../../shared/account-chip";
import { apiCreditLine } from "../../../../shared/api-credit-format";
import { ensureApiCreditWatch, type ApiCreditStatusMap } from "../../../../shared/api-credit-watch";
import { showToast } from "../../../../shared/toast";
import type { ApiCreditStatus } from "../../../../types/ipc.generated";
import { openReplaceApiKeyModal } from "./add-api-credit-modal";

/** Latest Console figures per account id, fed by the credit watch. */
let creditStatuses: ApiCreditStatusMap = {};
/** Live subscription to those figures. Started only once an API-credit account
 * is in the list, so a subscription-only setup never asks for them. */
let stopCreditWatch: (() => void) | null = null;
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

export function apiCreditRowHtml(account: Account, accounts: readonly Account[]): string {
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
            <button class="menu-item acc-menu-replace-key" data-id="${id}"><i class="ph ph-key"></i> Replace API key</button>
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
 * after each turn, and a full list rebuild would rebuild every row's menu. */
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

async function replaceKey(root: HTMLElement, account: { id: string; label: string }): Promise<void> {
  if (!(await openReplaceApiKeyModal(account))) return;
  showToast("API key replaced");
  void refreshCredit(root, account.id);
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

/** Called after each list rebuild; subscribes once an API-credit account exists. */
export function ensureCreditWatch(root: HTMLElement, accounts: readonly Account[]): void {
  stopCreditWatch = ensureApiCreditWatch(stopCreditWatch, accounts, (map) => {
    creditStatuses = map;
    paintCreditStatuses(root);
  });
}

/** Binds the kebab items of the freshly rebuilt rows. */
export function wireCreditRowMenus(list: HTMLElement, root: HTMLElement): void {
  list.querySelectorAll<HTMLButtonElement>(".acc-menu-connect-console").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (id) void connectConsole(root, id);
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-replace-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const label = btn.closest(".acc-row")?.querySelector(".acc-label")?.textContent ?? "this account";
      if (id) void replaceKey(root, { id, label });
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".acc-menu-refresh-credit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (id) void refreshCredit(root, id);
    });
  });
}

/** The inline "Connect Console" link sits inside a status line that is
 * repainted in place, so it is delegated on the stable list rather than bound
 * per render. Returns the disposer. */
export function wireConnectConsoleLink(list: HTMLElement | null, root: HTMLElement): () => void {
  const onConnectClick = (e: MouseEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".acc-credit-connect")?.dataset["id"];
    if (id) void connectConsole(root, id);
  };
  list?.addEventListener("click", onConnectClick);
  return () => list?.removeEventListener("click", onConnectClick);
}

/** Drops the live subscription and the cached figures; run on mount and unmount. */
export function resetCreditRows(): void {
  stopCreditWatch?.();
  stopCreditWatch = null;
  creditStatuses = {};
}
