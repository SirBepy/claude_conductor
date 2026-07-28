// Floating multi-account overlay (milestone 06), circle-dial layout (see
// .for_bepy/overlay-circle-mockup.html — the approved design this ports).
// Rendered into the always-on-top `session-overlay` Tauri window (see
// src-tauri/src/ipc/overlay_window.rs::toggle_overlay_window), toggled by a
// tray left-click. One dial per account: the OUTER thick ring is the 5h
// session window, the INNER thin ring is the 7d weekly window, and the
// account-coloured icon sits in the centre (identity), on a per-dial disc
// (circles mode) or a shared row card (card mode). Hovering a dial fades out
// its graph + icon and shows an info circle in its place: the account name and
// both windows' current%/safe%.

import "./overlay.css";
import { api } from "../../shared/api";
import { getSettings, setSettings } from "../../shared/state";
import type { SettingsShape } from "../../shared/state";
import { buildOverlayRows } from "./overlay-logic";
import { cellHtml, tickOverlayResetPopups } from "../../shared/usage-dial";
import { initOverlayDrag, resizeOverlayToContent } from "./overlay-drag";

const DEFAULT_OVERLAY_OPACITY = 0.72;
const REFRESH_INTERVAL_MS = 30_000;
// Separate from the 30s data refresh: just re-paints the reset popup's own
// countdown text/near-hot classes in place, so a countdown someone's actually
// watching (via the hover popup) doesn't sit frozen between refreshes.
const RESET_TICK_INTERVAL_MS = 1_000;
// Local IPC refreshes are usually near-instant; only show the spinner if one
// runs long enough to actually be worth signalling, so a normal 30s tick
// doesn't flash the icon for a frame.
const REFRESH_SPINNER_DELAY_MS = 150;

function readOverlayOpacity(settings: SettingsShape): number {
  const raw = settings["overlayOpacity"];
  const n = typeof raw === "number" ? raw : DEFAULT_OVERLAY_OPACITY;
  return Math.max(0, Math.min(1, n));
}

/** Overlay backing style: per-dial circular discs ("circles", default) or one
 * shared rounded card behind the whole row ("card"). */
function readBackgroundStyle(settings: SettingsShape): "circles" | "card" {
  return settings["overlayBackgroundStyle"] === "card" ? "card" : "circles";
}

/** Mirror the user's chosen theme/mode onto this window's <html>. The overlay
 * skips initBoot(), so it never runs boot.ts's applyThemeFromSettings and would
 * otherwise stay stuck on overlay.html's static `data-theme="void"` default.
 * Replicated (not imported) to keep boot.ts's heavy view graph out of the
 * overlay chunk (see overlay-main.ts). Runs from refresh(), which fires on both
 * initial render and the settings-changed path, so live theme switches follow. */
function applyOverlayTheme(settings: SettingsShape): void {
  const fullId = (settings.theme as string) || "void";
  const isLight = fullId.endsWith("-light");
  const el = document.documentElement;
  el.dataset.theme = isLight ? fullId.replace("-light", "") : fullId;
  el.dataset.mode = isLight ? "light" : "dark";
}

export async function renderOverlay(root: HTMLElement): Promise<() => void> {
  // Off-hover the dials carry only their (semi-transparent) backing disc/card
  // so the window reads mostly through to the desktop. Deliberately NOT a
  // whole-body `opacity` dim - setting `opacity` on the root of a transparent
  // WebView2 window forces the body onto its own compositing layer with a black
  // backing, so the panel goes *darker* instead of see-through (the exact bug
  // this used to have). Backgrounds use rgba/color-mix instead, which composite
  // correctly over the transparent window.

  // Transparent panel: just a horizontal row of account dials, window sized to
  // hug that row (see overlay.css + overlay-drag.ts). The WHOLE panel is the
  // drag surface now (no separate grip) — press-and-move drags/flicks it, a
  // plain click (no movement past a small threshold) opens the dashboard for
  // the clicked account instead.
  root.innerHTML = `<div id="ocPanel">
    <div id="ocRows" class="oc-dial-row"><div class="oc-empty">Loading…</div></div>
  </div>`;
  const panelEl = root.querySelector<HTMLElement>("#ocPanel");
  const rowsEl = root.querySelector<HTMLElement>("#ocRows");

  function syncSize(): void {
    if (panelEl) requestAnimationFrame(() => void resizeOverlayToContent(panelEl));
  }

  // Click (a press that didn't turn into a drag) on a dial → live-refresh
  // just that account (Joe 2026-07-27: he rarely clicked through to the
  // dashboard - when he did, it was only to trigger a refresh - so the click
  // now does that directly instead). Routed through the drag handler's
  // pointerup rather than a native `click` listener: the whole panel is the
  // drag surface and takes pointer capture on press, which would redirect the
  // synthesized click away from the dial's cell.
  const refreshClickedAccount = (target: EventTarget | null): void => {
    const cell = (target as HTMLElement | null)?.closest<HTMLElement>(".oc-cell[data-acc-id]");
    const id = cell?.dataset["accId"];
    if (!id) return;
    cell.classList.add("oc-refreshing");
    api
      .refreshUsageLive(id)
      .catch((e) => console.error("overlay: refreshUsageLive failed", e))
      .then(() => refresh())
      .finally(() => cell.classList.remove("oc-refreshing"));
  };

  async function refresh(): Promise<void> {
    const settings = getSettings();
    applyOverlayTheme(settings);
    document.documentElement.style.setProperty("--overlay-opacity", `${readOverlayOpacity(settings) * 100}%`);
    if (!rowsEl) return;
    // Only spin existing dials — the very first load already shows the
    // "Loading…" placeholder text, which the spinner would be redundant with.
    const hasDials = !!rowsEl.querySelector(".oc-cell");
    const spinnerTimer = hasDials
      ? window.setTimeout(() => rowsEl.classList.add("oc-refreshing"), REFRESH_SPINNER_DELAY_MS)
      : undefined;
    const [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
    if (spinnerTimer != null) window.clearTimeout(spinnerTimer);
    rowsEl.classList.remove("oc-refreshing");
    if (!accounts.length) {
      rowsEl.innerHTML = `<div class="oc-empty">No accounts yet</div>`;
      syncSize();
      return;
    }
    const cardMode = readBackgroundStyle(settings) === "card";
    rowsEl.classList.toggle("oc-card", cardMode);
    const rows = buildOverlayRows(accounts, usageMap);
    rowsEl.innerHTML = rows.map((r) => cellHtml(r, settings, !cardMode)).join("");
    syncSize();
  }

  await refresh();
  const cleanupDrag = panelEl ? initOverlayDrag(panelEl, refreshClickedAccount) : () => {};
  const unlistenHistory = api.onHistoryUpdated(() => void refresh());
  // The overlay window skips initBoot(), so it has no other subscription to
  // settings changes made elsewhere (e.g. Settings > Visuals color rules) -
  // without this, the panel would keep rendering with whatever settings were
  // in effect at window-open time until the window is recreated.
  let unlistenSettings: (() => void) | null = null;
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    unlistenSettings = await ev.listen("settings-changed", async () => {
      try {
        const settings = await api.getSettings();
        if (settings) setSettings(settings);
      } catch (e) {
        console.error("overlay: settings refresh failed", e);
      }
      void refresh();
    });
  }
  const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  const tickTimer = window.setInterval(() => {
    if (rowsEl) tickOverlayResetPopups(rowsEl);
  }, RESET_TICK_INTERVAL_MS);

  return () => {
    try { unlistenHistory(); } catch { /* ignore */ }
    if (unlistenSettings) { try { unlistenSettings(); } catch { /* ignore */ } }
    try { cleanupDrag(); } catch { /* ignore */ }
    window.clearInterval(timer);
    window.clearInterval(tickTimer);
  };
}
