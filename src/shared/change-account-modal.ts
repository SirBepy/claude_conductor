// Minimal account-picker modal shared by "Change account" (chat-menu.ts /
// active-session.ts statusline chip) and the manual-takeover account
// confirmation (active-session.ts). Reuses the generic cc-modal-* shell from
// change-character-modal.css and the account-chip visuals from account-chip.css
// rather than introducing another picker UI.

import "./change-character-modal.css";
import "./account-chip.css";
import "./change-account-modal.css";
import "./modal.css";
import "../styles/toggle-switch.css";
import "../views/overlay/overlay.css";
import { api, type UsageRecord } from "./api";
import { escapeHtml } from "./escape-html";
import { getSettings } from "./state";
import { creditDialHtml, dialHtml } from "./usage-dial";
import { apiCreditLimitStatus, subscriptionLimitStatus, type AccountLimitStatus } from "./account-limit-status";
import { grantRemainingFraction } from "./api-credit-format";
import { buildOverlayRow } from "../views/overlay/overlay-logic";
import type { ApiCreditStatus } from "../types/ipc.generated";
import type { AccountLite } from "./account-chip";
import { accountChipHtml, accountIconBadgeHtml, apiCreditLinkedName, attachChipKeyboardActivation, isApiCreditAccount, linkedPlanAccount } from "./account-chip";
import { lockInputToHost, registerSelectableOptions } from "./modal-input-lock";

/** Tooltip naming the plan an API-credit chip draws on ("API credit · personal");
 * nothing for a subscription chip or an unlinked credit one. */
function creditTitleAttr(a: AccountLite, accounts: readonly AccountLite[]): string {
  if (!isApiCreditAccount(a) || !linkedPlanAccount(a, accounts)) return "";
  return ` title="${escapeHtml(apiCreditLinkedName(a, accounts))}"`;
}

/** The figures behind each row's status line, fetched after the picker is open. */
export interface AccountLimitData {
  usage: Record<string, UsageRecord>;
  credit: Record<string, ApiCreditStatus>;
}

/** Dial scale for ~26px: the dial's viewBox is 48 units wide without a disc. */
const ROW_DIAL_SCALE = 0.54;

/** What sits left of a row's dial. A limited account shows its flag at all times
 * (a small red pill over the "back in 53m" countdown) and nothing more on hover;
 * any other account shows its figures only on hover or keyboard focus. */
function limitTextHtml(limit: AccountLimitStatus): string {
  if (limit.pill) {
    const back = limit.backIn ? `<span class="cam-back">back ${escapeHtml(limit.backIn)}</span>` : "";
    return `<span class="cam-flag"><span class="cam-pill">${escapeHtml(limit.pill)}</span>${back}</span>`;
  }
  const body = limit.figures ? limit.figures.map((f) => `<span>${escapeHtml(f)}</span>`).join(" ") : escapeHtml(limit.text);
  return `<span class="cam-limit-text">${body}</span>`;
}

/** One row's trailing status text and dial. Empty until the figures arrive, so
 * the picker never waits on the usage poller to open. */
export function limitSlotHtml(a: AccountLite, data: AccountLimitData | null): string {
  if (!data) return "";
  const settings = getSettings();
  if (isApiCreditAccount(a)) {
    const status = data.credit[a.id];
    const limit = apiCreditLimitStatus(status);
    return `<span class="cam-limit cam-limit-credit cam-limit-${limit.tone}">${limitTextHtml(limit)}${creditDialHtml(grantRemainingFraction(status), a, settings, false, ROW_DIAL_SCALE)}</span>`;
  }
  const usage = data.usage[a.id];
  const limit = subscriptionLimitStatus(usage);
  return `<span class="cam-limit cam-limit-${limit.tone}">${limitTextHtml(limit)}${dialHtml(buildOverlayRow(a, usage), settings, false, ROW_DIAL_SCALE)}</span>`;
}

/** The accounts under small section labels, subscriptions first. The labels
 * only appear when both kinds are present: one lone group needs no heading.
 * Row order (and so the number keys) follows the screen, top to bottom. */
function groupedRowsHtml(
  accounts: readonly AccountLite[],
  currentId: string | null,
  limits: AccountLimitData | null,
): string {
  const row = (a: AccountLite) =>
    accountChipHtml(a, a.id === currentId, `data-acc-id="${escapeHtml(a.id)}"${creditTitleAttr(a, accounts)}`, limitSlotHtml(a, limits));
  const subs = accounts.filter((a) => !isApiCreditAccount(a));
  const credit = accounts.filter(isApiCreditAccount);
  const label = (text: string) => (subs.length && credit.length ? `<div class="cam-group-label">${text}</div>` : "");
  return (subs.length ? label("Subscriptions") + subs.map(row).join("") : "") + (credit.length ? label("API credit") + credit.map(row).join("") : "");
}

/** The `.cc-modal-body` contents for the account list, split out so the
 * single-vs-multi-account branching is unit-testable without the modal's
 * DOM/IPC wiring. Exactly one account that is already the current one:
 * nothing to pick (a single-option picker is a confirmation, not a choice).
 * Render it as a static display, not a chip: no data-acc-id/role="button",
 * so there is nothing for the click handler in `openChangeAccountModal` to
 * wire up. A sole account that is NOT current stays pickable: a draft whose
 * only account is API credit opens with none picked, and this is the only
 * place it can opt in. */
export function renderAccountListBodyHtml(
  accounts: readonly AccountLite[],
  currentId: string | null,
  limits: AccountLimitData | null = null,
): string {
  if (accounts.length === 0) return `<div class="cc-modal-empty">No Claude accounts configured yet.</div>`;
  if (accounts.length === 1 && accounts[0]!.id === currentId) {
    const a = accounts[0]!;
    return `<div class="cam-account-list"><span class="account-chip cam-row sel cam-acc-static" style="--acc:${escapeHtml(a.colour)}"${creditTitleAttr(a, accounts)}>${accountIconBadgeHtml(a)}<span class="cam-row-name">${escapeHtml(a.label)}</span>${limitSlotHtml(a, limits)}</span></div>`;
  }
  return `<div class="cam-account-list">${groupedRowsHtml(accounts, currentId, limits)}</div>`;
}

/** The "Also move its N subchats" row under the account list, on by default:
 *  swapping a main chat's account usually means its subs should follow. */
export function subsSwitchHtml(count: number): string {
  const label = `Also move its ${count} subchat${count === 1 ? "" : "s"}`;
  return `<div class="cam-subs-row"><span class="cam-subs-label">${escapeHtml(label)}</span><label class="switch"><input type="checkbox" class="cam-subs-input" checked aria-label="${escapeHtml(label)}"><span class="slider"></span></label></div>`;
}

export interface ChatAccountPick {
  id: string;
  /** The subs switch was on. Always false when no switch was shown. */
  withSubs: boolean;
}

/** Usage and API-credit figures for this machine's accounts. The api reads
 * resolve to `{}` on failure, which the rows draw as "unknown"; null only covers a
 * read that throws anyway, leaving the rows without a status. Never a wrong figure. */
async function loadLimitData(accounts: readonly AccountLite[]): Promise<AccountLimitData | null> {
  try {
    const [usage, credit] = await Promise.all([
      api.getUsageMap(),
      accounts.some(isApiCreditAccount) ? api.getApiCreditStatus() : Promise.resolve({}),
    ]);
    return { usage, credit };
  } catch (err) {
    console.error("[change-account] limit figures unavailable", err);
    return null;
  }
}

export async function openChangeAccountModal(opts: Parameters<typeof pickAccount>[0]): Promise<string | null> {
  return (await pickAccount(opts))?.id ?? null;
}

/** The picker for one established chat: `subsCount` > 0 adds the subs switch,
 *  and `apiCreditAllowed: false` leaves API-credit accounts out (a sub, or a
 *  chat using subchats, never runs on one; the daemon refuses it too). */
export async function openChangeAccountForChat(
  opts: Parameters<typeof pickAccount>[0] & { subsCount: number; apiCreditAllowed: boolean },
): Promise<ChatAccountPick | null> {
  const accounts = opts.accounts ?? (await api.listAccounts());
  return pickAccount({
    ...opts,
    accounts: opts.apiCreditAllowed ? accounts : accounts.filter((a) => !isApiCreditAccount(a)),
    // The list was read here when the caller passed none, so it is this machine's.
    localFigures: !opts.accounts,
  });
}

async function pickAccount(opts: {
  currentId: string | null;
  title?: string;
  /** Number of subs the "Also move" switch names; 0 or absent shows no switch. */
  subsCount?: number;
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
  /** The accounts to offer instead of this machine's. A draft aimed at a paired
   *  machine passes that machine's list: account ids are per machine, so a
   *  local id picked for a peer chat would name nothing (or the wrong account)
   *  on the host. Omitted means this machine's own accounts. */
  accounts?: readonly AccountLite[];
  /** The `accounts` are this machine's own (read by `openChangeAccountForChat`), so
   *  their usage and balance figures apply. Implied when `accounts` is omitted. */
  localFigures?: boolean;
}): Promise<ChatAccountPick | null> {
  const title = opts.title ?? "Change account";
  const accounts: readonly AccountLite[] = opts.accounts ?? (await api.listAccounts());

  // A sole API-credit account is never auto-picked: it bills the monthly API
  // credit, so choosing it has to be an explicit click.
  if (opts.autoPickSole && accounts.length === 1 && !isApiCreditAccount(accounts[0])) return { id: accounts[0]!.id, withSubs: false };
  const subsCount = opts.subsCount ?? 0;

  return new Promise<ChatAccountPick | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "cc-modal-overlay";

    const unlock = lockInputToHost(overlay);

    function close(id: string | null) {
      unlock();
      const withSubs = subsCount > 0 && !!overlay.querySelector<HTMLInputElement>(".cam-subs-input")?.checked;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(id ? { id, withSubs } : null);
    }

    function render() {
      const bodyHtml = renderAccountListBodyHtml(accounts, opts.currentId) + (subsCount > 0 ? subsSwitchHtml(subsCount) : "");

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

    // Account ids are per machine, so a peer's list (`opts.accounts`) has no
    // figures here; only this machine's own accounts get a status.
    if (!opts.accounts || opts.localFigures) {
      void loadLimitData(accounts).then((data) => {
        if (!data || !overlay.isConnected) return;
        const rows = Array.from(overlay.querySelectorAll<HTMLElement>(".cam-account-list .account-chip"));
        for (const a of accounts) {
          // The sole-account display is a chip without data-acc-id.
          const row = rows.find((r) => r.dataset.accId === a.id) ?? (accounts.length === 1 ? rows[0] : undefined);
          if (row && !row.querySelector(".cam-limit")) row.insertAdjacentHTML("beforeend", limitSlotHtml(a, data));
        }
      });
    }
  });
}
