// Multi-account usage dials in the Chats header (remote/phone only - see
// sessions.ts's `isRemote()` mount guard). Replaces the old single-account
// text "usage-chip": Joe wanted to see BOTH configured payment accounts at a
// glance, each with its own colour icon, reusing the overlay window's exact
// dial-ring visuals (shared/usage-dial.ts + overlay.css) instead of a new
// component drifting from that look. Tapping a dial opens its real dashboard
// account card (account-selector.ts) in a popover - a phone has no hover, so
// that's the touch-reachable replacement for the desktop overlay's hover-only
// `.oc-info`. A hand-built detail layout was tried first and twice rejected
// as "ugly"/"awkward" (Joe, 2026-10-18) before landing on reusing the real,
// already-shipped home-screen component instead of a third custom one.

import { api, type UsageRecord } from "../../shared/api";
import type { Account } from "../../types/ipc.generated";
import { getSettings } from "../../shared/state";
import "../overlay/overlay.css";
import "../dashboard/dashboard.css";
import { cellHtml, tickOverlayResetPopups } from "../../shared/usage-dial";
import { buildOverlayRows, type OverlayRow } from "../overlay/overlay-logic";
import { visibleInterval } from "../../shared/visible-interval";
import { createMoreMenu } from "./more-menu-base";
import { buildAccountCardsHTML, wireAccountCardClicks, tickAccountCardCountdowns } from "../dashboard/account-selector";

const POLL_MS = 60_000;
const RESET_TICK_MS = 1_000;
// Compact size for the header row - no backing disc (the row itself sits
// inline in the header, not floating over the desktop), scaled down from the
// overlay's full-size dial.
const DIAL_SCALE = 0.6;

/** The last dials the phone showed, so a reopened app paints them before the
 *  tunnel answers. Account labels, colours and usage numbers only. */
const DIALS_CACHE_KEY = "cc_usage_dials_v1";

interface CachedDials {
  accounts: Account[];
  usageMap: Record<string, UsageRecord>;
}

function loadCachedDials(): CachedDials | null {
  try {
    const raw = localStorage.getItem(DIALS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedDials>;
    if (!Array.isArray(parsed.accounts) || !parsed.accounts.length || !parsed.usageMap) return null;
    return { accounts: parsed.accounts, usageMap: parsed.usageMap };
  } catch {
    return null;
  }
}

function saveCachedDials(accounts: Account[], usageMap: Record<string, UsageRecord>): void {
  try {
    localStorage.setItem(DIALS_CACHE_KEY, JSON.stringify({ accounts, usageMap }));
  } catch {
    // Quota or private mode: the next mount just waits for the network.
  }
}

/** Tap-opened detail panel for one account - the real dashboard account card
 *  (account-selector.ts's buildAccountCardsHTML), not a one-off layout. Built
 *  with createMoreMenu so it gets the same floating-panel chrome, outside-
 *  click dismiss, and Escape handling every other menu in this view already
 *  has. Clicking the card does the same live-refresh poll the dial itself
 *  used to do on tap (api.refreshUsageLive), via wireAccountCardClicks. */
const usageDetailMenu = createMoreMenu<[Account, UsageRecord | undefined, () => Promise<void>]>({
  className: "session-more-menu usage-detail-menu",
  build: (menu, close, account, usage, render) => {
    const settings = getSettings();
    // dashboard.css's .dash-* rules are deliberately scoped under
    // .view-dashboard (not globally) so they can't leak into other views -
    // wrap in it here too, rather than ungating the real rules, to get the
    // genuine cascade instead of an unstyled card.
    menu.innerHTML = `<div class="view-dashboard">${buildAccountCardsHTML([account], usage ? { [account.id]: usage } : {}, account.id, settings)}</div>`;
    wireAccountCardClicks(menu, () => {
      close();
      void api.refreshUsageLive(account.id)
        .catch((e) => console.error("usage-dials: refreshUsageLive failed", e))
        .then(() => render());
    });
  },
});

/** Mounts the dial row into an already-present header host element; returns a
 * teardown that stops the poll. Safe to call with a host that stays hidden
 * (no accounts yet) - it just re-checks on the next poll tick. */
export function mountUsageDials(host: HTMLElement): () => void {
  let lastAccounts: Account[] = [];
  let lastUsageMap: Record<string, UsageRecord> = {};

  const paint = (accounts: Account[], usageMap: Record<string, UsageRecord>): void => {
    lastAccounts = accounts;
    lastUsageMap = usageMap;
    const settings = getSettings();
    const rows: OverlayRow[] = buildOverlayRows(accounts, usageMap);
    host.innerHTML = rows.map((r) => cellHtml(r, settings, false, DIAL_SCALE, true)).join("");
    host.hidden = false;
  };

  const render = async (): Promise<void> => {
    let accounts: Account[];
    let usageMap: Record<string, UsageRecord>;
    try {
      [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
    } catch {
      // A failed fetch keeps whatever is painted (cached or last live): a
      // tunnel blip should not blank the dials.
      if (!lastAccounts.length) host.hidden = true;
      return;
    }
    if (!accounts.length) {
      host.hidden = true;
      return;
    }
    paint(accounts, usageMap);
    saveCachedDials(accounts, usageMap);
  };
  const cached = loadCachedDials();
  if (cached) paint(cached.accounts, cached.usageMap);
  void render();

  const onClick = (e: MouseEvent): void => {
    const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>(".oc-cell[data-acc-id]");
    const id = cell?.dataset["accId"];
    const account = lastAccounts.find((a) => a.id === id);
    if (cell && account) usageDetailMenu.toggle(cell, account, lastUsageMap[account.id], render);
  };
  host.addEventListener("click", onClick);

  // PAUSE-WHEN-HIDDEN (todo 1008): this header row has nothing to show a
  // hidden window. The existing onVisible below already re-renders on regain
  // (unconditionally, not gated on a full hidden period), so it stays - it
  // is not an exact duplicate of visibleInterval's own flush-on-return.
  const disposeRender = visibleInterval(() => void render(), POLL_MS);
  const disposeTick = visibleInterval(() => {
    tickOverlayResetPopups(host);
    const menu = usageDetailMenu.element();
    if (menu) tickAccountCardCountdowns(menu);
  }, RESET_TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void render();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    disposeRender();
    disposeTick();
    document.removeEventListener("visibilitychange", onVisible);
    host.removeEventListener("click", onClick);
    usageDetailMenu.close();
  };
}
