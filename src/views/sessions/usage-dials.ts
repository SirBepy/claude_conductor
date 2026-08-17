// Multi-account usage dials in the Chats header (remote/phone only - see
// sessions.ts's `isRemote()` mount guard). Replaces the old single-account
// text "usage-chip": Joe wanted to see BOTH configured payment accounts at a
// glance, each with its own colour icon, reusing the overlay window's exact
// dial-ring visuals (shared/usage-dial.ts + overlay.css) instead of a new
// component drifting from that look. Clicking a dial does a REAL claude.ai
// poll for just that account (api.refreshUsageLive), not a cached re-read -
// see daemon/methods/usage.rs's request_live_usage_refresh for how the phone
// reaches the desktop app to do it. A per-dial spinner (the same .oc-ic-spin
// swap the overlay uses) shows while that's in flight.

import { api } from "../../shared/api";
import { getSettings } from "../../shared/state";
import "../overlay/overlay.css";
import { cellHtml, tickOverlayResetPopups } from "../../shared/usage-dial";
import { buildOverlayRows } from "../overlay/overlay-logic";

const POLL_MS = 60_000;
const RESET_TICK_MS = 1_000;
// Compact size for the header row - no backing disc (the row itself sits
// inline in the header, not floating over the desktop), scaled down from the
// overlay's full-size dial.
const DIAL_SCALE = 0.6;

async function renderUsageDials(host: HTMLElement): Promise<void> {
  let accounts: Awaited<ReturnType<typeof api.listAccounts>>;
  let usageMap: Awaited<ReturnType<typeof api.getUsageMap>>;
  try {
    [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
  } catch {
    host.hidden = true;
    return;
  }

  if (!accounts.length) {
    host.hidden = true;
    return;
  }

  const settings = getSettings();
  const rows = buildOverlayRows(accounts, usageMap);
  host.innerHTML = rows.map((r) => cellHtml(r, settings, false, DIAL_SCALE, true)).join("");
  host.hidden = false;
}

async function refreshClickedAccount(host: HTMLElement, cell: HTMLElement, accountId: string): Promise<void> {
  cell.classList.add("oc-refreshing");
  try {
    await api.refreshUsageLive(accountId);
  } catch (e) {
    console.error("usage-dials: refreshUsageLive failed", e);
  } finally {
    // A full re-render replaces `cell` outright once fresh data is in, so
    // this is a harmless no-op on the (by then detached) old node in the
    // success path - it only matters if renderUsageDials itself threw.
    cell.classList.remove("oc-refreshing");
  }
  await renderUsageDials(host);
}

/** Mounts the dial row into an already-present header host element; returns a
 * teardown that stops the poll. Safe to call with a host that stays hidden
 * (no accounts yet) - it just re-checks on the next poll tick. */
export function mountUsageDials(host: HTMLElement): () => void {
  void renderUsageDials(host);

  const onClick = (e: MouseEvent): void => {
    const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>(".oc-cell[data-acc-id]");
    const id = cell?.dataset["accId"];
    if (cell && id) void refreshClickedAccount(host, cell, id);
  };
  host.addEventListener("click", onClick);

  const timer = window.setInterval(() => void renderUsageDials(host), POLL_MS);
  const tickTimer = window.setInterval(() => tickOverlayResetPopups(host), RESET_TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void renderUsageDials(host);
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.clearInterval(timer);
    window.clearInterval(tickTimer);
    document.removeEventListener("visibilitychange", onVisible);
    host.removeEventListener("click", onClick);
  };
}
