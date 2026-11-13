// Global rate-limit banners.
//
// The daemon is the sole source of truth for "is this chat blocked": when
// `claude -p` rejects a turn for a usage limit, it marks every live session
// on that account with `rate_limited_resets_at` / `rate_limited_type`,
// schedules the resume itself, and publishes `instances_changed`. The
// frontend NEVER fires a "continue" turn on its own any more - it only
// reflects the account-blocked state until the resets_at timestamp passes,
// at which point the predicate below expires it with no clear-event needed.
//
// This module renders ONE banner PER EXHAUSTED ACCOUNT at the top of the
// Chats window (mounted independently in both the main window and the
// detached session-chats window - safe to call on every `instances-changed`).

import { escapeHtml } from "../escape-html";
import { api } from "../api";
import { showView } from "../navigation";
import type { Instance } from "../../types/ipc.generated";
import { isSubchat } from "../../views/sessions/sessions-helpers";
import { setCachedAccounts, listCachedAccounts, getCachedAccount, capitalize } from "../accounts-cache";
import { formatRelativeMinutes } from "../formatters";
import { isApiCreditAccount } from "../account-chip";
import { openRlbMenu, type RlbMenuItem } from "./rate-limit-banner-menu";
import { visibleInterval } from "../visible-interval";
export { getCachedAccount, capitalize } from "../accounts-cache";

/** Live predicate for "is this session's account currently blocked by a
 * usage-limit rejection". Purely time-derived (no clear-event): a session
 * born already-exhausted carries the same fields, and the state expires on
 * its own once `now` passes `resets_at`. Shared by every consumer that used
 * to read the old `rateLimitBanner.interruptedSet`. */
export function isBlocked(i: Instance): boolean {
  return i.rate_limited_resets_at != null && Number(i.rate_limited_resets_at) * 1000 > Date.now();
}

/** Local 12h clock, lowercase am/pm, no leading zero ("1:50pm"). */
export function formatClockLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  const time = `${h}:${String(m).padStart(2, "0")}${ampm}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** "in 2h 14m" / "in 14m" / "in under a minute". */
function formatCountdown(remainingMs: number): string {
  const clamped = Math.max(0, remainingMs);
  if (clamped < 60_000) return "in under a minute";
  return formatRelativeMinutes(clamped);
}

/** "five_hour" -> "5-hour", "seven_day"/"weekly" -> "weekly". */
function humanWindow(t: string | null): string {
  switch (t) {
    case "five_hour": return "5-hour";
    case "seven_day":
    case "weekly": return "weekly";
    default: return "usage";
  }
}

// Refreshed on mount(); accounts change rarely enough that a stale label for
// a few seconds is a non-issue. The cache itself lives in accounts-cache.ts
// (shared with session-statusbar.ts's account chip).
async function refreshAccountsCache(): Promise<void> {
  try { setCachedAccounts(await api.listAccounts()); }
  catch { /* keep whatever we had */ }
}

export interface RateLimitBannerDeps {
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

/** localStorage key -> JSON array of `${accountId}:${resetsAtMs}`. Keyed by
 * resets_at so a fresh rejection re-shows the full card even if minimized.
 * Pruned to the currently-blocked keys on every render - self-cleans once a
 * window expires, no separate GC. */
const MINIMIZED_STORAGE_KEY = "rate-limit-banner:minimized";

function minimizedKey(accountId: string, resetsAtMs: number): string {
  return `${accountId}:${resetsAtMs}`;
}

export class RateLimitBanner {
  private host: HTMLElement | null = null;
  private instances: Instance[] = [];
  private timer: (() => void) | null = null;
  private now: () => number;
  private storage: Pick<Storage, "getItem" | "setItem"> | null;
  private minimized: Set<string>;
  // Per-card data the mobile kebab menu needs at click time, keyed by the
  // same minimizedKey() as the card - rebuilt every render().
  private kebabData = new Map<string, { accountId: string; canSwitch: boolean }>();
  private getSelectedSessionId: () => string | null = () => null;
  private onSwitchAccount: ((sessionId: string) => Promise<void>) | null = null;

  constructor(deps?: RateLimitBannerDeps) {
    this.now = deps?.now ?? (() => Date.now());
    this.storage = deps?.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    this.minimized = new Set(this.loadMinimized());
  }

  private loadMinimized(): string[] {
    try {
      const raw = this.storage?.getItem(MINIMIZED_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  private saveMinimized(): void {
    try { this.storage?.setItem(MINIMIZED_STORAGE_KEY, JSON.stringify([...this.minimized])); }
    catch { /* storage unavailable/full - minimize state just won't survive reload */ }
  }

  /** Attach to the host element, load accounts, and paint the current state. */
  mount(host: HTMLElement): void {
    this.host = host;
    void refreshAccountsCache().then(() => this.render());
    this.render();
  }

  /** Wired by the chat pane so "Switch account" knows which blocked chat to
   * move (falls back to the account's most-recently-started blocked session
   * when nothing is selected). */
  setSelectedSessionGetter(fn: () => string | null): void {
    this.getSelectedSessionId = fn;
  }

  /** Wired by the chat pane to the Change account picker, so "Switch account"
   * asks Joe which account to move to (and offers the subs switch on a main
   * chat). The banner never picks the target itself: an account it guessed
   * could be the one that is not working. Unwired, the button is not drawn. */
  setOnSwitchAccount(fn: (sessionId: string) => Promise<void>): void {
    this.onSwitchAccount = fn;
  }

  /** Feed the current live instance list and repaint. Safe to call on every
   * `instances-changed` - a no-op render when nothing is blocked. */
  update(instances: Instance[]): void {
    // "N chats affected" counts chats the user can see; hidden subs share their
    // main chat's account, so they would only inflate it.
    this.instances = instances.filter((i) => !isSubchat(i));
    this.render();
  }

  private blockedGroups(): Map<string, Instance[]> {
    const byAccount = new Map<string, Instance[]>();
    for (const i of this.instances) {
      if (!i.account_id) continue;
      if (!byAccount.has(i.account_id)) byAccount.set(i.account_id, []);
      byAccount.get(i.account_id)!.push(i);
    }
    const blocked = new Map<string, Instance[]>();
    for (const [accountId, list] of byAccount) {
      if (list.some(isBlocked)) blocked.set(accountId, list);
    }
    return blocked;
  }

  private stopTimer(): void {
    if (this.timer) {
      this.timer();
      this.timer = null;
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = visibleInterval(() => this.render(), 30_000);
  }

  private render(): void {
    if (!this.host) return;
    const groups = this.blockedGroups();
    if (groups.size === 0) {
      this.host.innerHTML = "";
      this.host.hidden = true;
      this.stopTimer();
      return;
    }
    this.host.hidden = false;
    const nowMs = this.now();

    const cards: string[] = [];
    const liveKeys = new Set<string>();
    const kebabData = new Map<string, { accountId: string; canSwitch: boolean }>();
    for (const [accountId, list] of groups) {
      const blockedInGroup = list.filter(isBlocked);
      // All rejections for one account share a resets_at in practice; take
      // the latest so a fresh rejection during an existing window wins.
      const rep = blockedInGroup.reduce((a, b) =>
        Number(b.rate_limited_resets_at) > Number(a.rate_limited_resets_at) ? b : a
      );
      const resetsAtMs = Number(rep.rate_limited_resets_at) * 1000;
      const key = minimizedKey(accountId, resetsAtMs);
      liveKeys.add(key);
      const acc = getCachedAccount(accountId);
      const label = capitalize(acc?.label ?? "Account");
      const icon = acc?.icon || "user";
      const colour = acc?.colour || "#9d7dfc";
      const windowLabel = humanWindow(rep.rate_limited_type);

      const title = `${label} hit its ${windowLabel} limit`;

      if (this.minimized.has(key)) {
        cards.push(`
          <button type="button" class="rate-limit-banner rate-limit-banner--min" data-key="${escapeHtml(key)}" style="--acc:${escapeHtml(colour)}" title="${escapeHtml(title)} - click to expand">
            <i class="ph ph-${escapeHtml(icon)} rlb-icon"></i>
          </button>`);
        continue;
      }
      const affected = blockedInGroup.length > 1 ? ` · ${blockedInGroup.length} chats affected` : "";
      const timeLine = `Resets ${formatClockLabel(resetsAtMs, nowMs)}${affected}`;
      const countdown = formatCountdown(resetsAtMs - nowMs);

      // "Switch account" opens the picker, so Joe names the target: only
      // useful when another plan account exists. API credit alone does not
      // count, since the picker leaves it out for a chat with subs, and a plain
      // chat can still pick it from the chat menu.
      const canSwitch = !!this.onSwitchAccount
        && listCachedAccounts().some((a) => a.id !== accountId && !isApiCreditAccount(a));
      const moveBtn = canSwitch ? `<button class="rlb-move"><i class="ph ph-arrow-right"></i> Switch account</button>` : "";
      kebabData.set(key, { accountId, canSwitch });

      cards.push(`
        <div class="rate-limit-banner" data-account-id="${escapeHtml(accountId)}" data-key="${escapeHtml(key)}" style="--acc:${escapeHtml(colour)}">
          <i class="ph ph-${escapeHtml(icon)} rlb-icon"></i>
          <div class="rlb-text">
            <div class="rlb-title">${escapeHtml(title)}</div>
            <div class="rlb-time">${escapeHtml(timeLine)}</div>
            <div class="rlb-countdown">${escapeHtml(countdown)}</div>
          </div>
          <div class="rlb-actions">
            ${moveBtn}
            <button class="rlb-schedule"><i class="ph ph-calendar-dots"></i> View in Schedule</button>
            <button class="rlb-minimize" title="Minimize"><i class="ph ph-minus"></i></button>
          </div>
          <button type="button" class="rlb-kebab" data-key="${escapeHtml(key)}" title="More options">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
        </div>`);
    }

    // Drop any minimized keys whose window is no longer live (reset passed,
    // or account no longer blocked) so localStorage doesn't grow forever.
    for (const key of [...this.minimized]) {
      if (!liveKeys.has(key)) this.minimized.delete(key);
    }
    this.saveMinimized();
    this.kebabData = kebabData;

    this.host.innerHTML = cards.join("");
    this.wireActions();
    this.startTimer();
  }

  private wireActions(): void {
    if (!this.host) return;
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-move").forEach((btn) => {
      btn.addEventListener("click", () => {
        const accountId = btn.closest<HTMLElement>(".rate-limit-banner")?.dataset.accountId;
        if (accountId) void this.switchAccount(accountId);
      });
    });
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-schedule").forEach((btn) => {
      btn.addEventListener("click", () => showView("schedule"));
    });
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-minimize").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.closest<HTMLElement>(".rate-limit-banner")?.dataset.key;
        if (!key) return;
        this.minimized.add(key);
        this.saveMinimized();
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLButtonElement>(".rate-limit-banner--min").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        if (!key) return;
        this.minimized.delete(key);
        this.saveMinimized();
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-kebab").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        const data = key ? this.kebabData.get(key) : undefined;
        if (!key || !data) return;
        const items: RlbMenuItem[] = [];
        if (data.canSwitch) {
          items.push({ icon: "arrow-right", label: "Switch account", onClick: () => void this.switchAccount(data.accountId) });
        }
        items.push({ icon: "calendar-dots", label: "View in Schedule", onClick: () => showView("schedule") });
        items.push({
          icon: "minus",
          label: "Minimize",
          onClick: () => {
            this.minimized.add(key);
            this.saveMinimized();
            this.render();
          },
        });
        openRlbMenu(btn, items);
      });
    });
  }

  private async switchAccount(accountId: string): Promise<void> {
    const blockedInAccount = this.instances.filter((i) => i.account_id === accountId && isBlocked(i));
    if (blockedInAccount.length === 0 || !this.onSwitchAccount) return;
    const selectedId = this.getSelectedSessionId();
    const mostRecent = blockedInAccount
      .slice()
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0]!;
    const source = blockedInAccount.find((i) => i.session_id === selectedId) ?? mostRecent;
    await this.onSwitchAccount(source.session_id);
  }
}

/** App-wide singleton. */
export const rateLimitBanner = new RateLimitBanner();
