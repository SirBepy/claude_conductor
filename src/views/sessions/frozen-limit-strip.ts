// The strip above the composer of a chat the daemon froze because its account
// ran out of usage (`frozen && auto_frozen`). The way out is another account,
// so the strip offers it right there: "Continue on <other plan account>" in one
// click, and "Change account" for the full picker (the only door to an
// API-credit account, which a one-click suggestion must never pick).
//
// It does not depend on `rate_limited_resets_at`: the daemon keeps that stamp
// in memory only, so a chat still frozen after a daemon restart has none, and
// the global banner (which keys on it) shows nothing for it.

import { escapeHtml } from "../../shared/escape-html";
import type { Account, Instance } from "../../types/ipc.generated";
import { isApiCreditAccount } from "../../shared/account-chip";
import { capitalize, formatClockLabel, isBlocked } from "../../shared/chat/rate-limit-banner";
import "./frozen-limit-strip.css";

/** A chat frozen by a usage-limit rejection, which a move to another account
 *  resumes. A manual freeze is Joe's own choice and is left alone, and a chat
 *  mirrored from another machine cannot be moved from here. */
export function needsFrozenLimitStrip(sess: Instance | undefined, readOnly: boolean): boolean {
  return !!sess && !readOnly && sess.frozen && sess.auto_frozen && !sess.machine && !sess.ended_at;
}

/** The plan account a one-click move suggests: not the chat's own, not an
 *  API-credit account, and not one whose chats are blocked right now. */
export function suggestedAccount(sess: Instance, accounts: readonly Account[], sessions: readonly Instance[]): Account | null {
  const blocked = new Set(sessions.filter(isBlocked).map((i) => i.account_id).filter(Boolean));
  return accounts.find((a) => a.id !== sess.account_id && !isApiCreditAccount(a) && !blocked.has(a.id)) ?? null;
}

export function frozenLimitStripHtml(
  sess: Instance,
  accounts: readonly Account[],
  sessions: readonly Instance[],
  now: number = Date.now(),
): string {
  const own = accounts.find((a) => a.id === sess.account_id);
  const ownLabel = own ? capitalize(own.label) : "This account";
  const resets = isBlocked(sess)
    ? `It resumes on its own at ${formatClockLabel(Number(sess.rate_limited_resets_at) * 1000, now)}, or continue on another account now.`
    : "It resumes on its own once the limit resets, or continue on another account now.";
  const other = suggestedAccount(sess, accounts, sessions);
  const moveBtn = other
    ? `<button type="button" class="fls-move" data-account="${escapeHtml(other.id)}"><i class="ph ph-arrow-right"></i> Continue on ${escapeHtml(capitalize(other.label))}</button>`
    : "";
  return `
    <div class="frozen-limit-strip" role="status">
      <i class="ph ph-snowflake fls-icon"></i>
      <div class="fls-text">
        <div class="fls-title">${escapeHtml(ownLabel)} is out of usage, so this chat is paused</div>
        <div class="fls-sub">${escapeHtml(resets)}</div>
      </div>
      <div class="fls-actions">
        ${moveBtn}
        <button type="button" class="fls-change"><i class="ph ph-user-switch"></i> Change account</button>
      </div>
    </div>`;
}

export interface FrozenLimitStripActions {
  /** One-click move to `accountId` (a plan account), `label` for the toast.
   *  Settles once the move is done or failed. */
  moveTo: (accountId: string, label: string) => Promise<void>;
  /** Open the full account picker. */
  changeAccount: () => void;
}

/** Paint (or clear) the strip in `slot` for `sess`. Safe to call on every
 *  instances change: it repaints only when the markup would differ, so a
 *  click in flight is never torn out from under the pointer. */
export function syncFrozenLimitStrip(
  slot: HTMLElement,
  sess: Instance | undefined,
  readOnly: boolean,
  accounts: readonly Account[],
  sessions: readonly Instance[],
  actions: FrozenLimitStripActions,
): void {
  if (!needsFrozenLimitStrip(sess, readOnly)) {
    if (slot.innerHTML) slot.innerHTML = "";
    delete slot.dataset.html;
    return;
  }
  const html = frozenLimitStripHtml(sess!, accounts, sessions);
  if (slot.dataset.html === html) return;
  slot.dataset.html = html;
  slot.innerHTML = html;
  const move = slot.querySelector<HTMLButtonElement>(".fls-move");
  // A move in flight lives on the slot, not the button: an instances change
  // mid-move repaints a fresh button, which must come up disabled too. A second
  // click would ask the daemon to move a chat already on that account and
  // toast a failure after the move worked.
  if (move && slot.dataset.moving) move.disabled = true;
  move?.addEventListener("click", () => {
    const id = move.dataset.account;
    if (!id || slot.dataset.moving) return;
    slot.dataset.moving = "1";
    move.disabled = true;
    const label = accounts.find((a) => a.id === id)?.label ?? "the other account";
    // Re-enabled when the move settles: a failed move repaints nothing, so the
    // button must not stay dead.
    void actions.moveTo(id, label)
      .catch(() => { /* moveChatToAccount toasts its own failure */ })
      .finally(() => {
        delete slot.dataset.moving;
        const current = slot.querySelector<HTMLButtonElement>(".fls-move");
        if (current) current.disabled = false;
      });
  });
  slot.querySelector<HTMLButtonElement>(".fls-change")?.addEventListener("click", () => actions.changeAccount());
}
