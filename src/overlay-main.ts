// Dedicated entry point for the floating multi-account overlay window (see
// src-tauri/src/ipc/overlay_window.rs::build_overlay_window, which points this
// window's WebviewUrl at overlay.html instead of index.html). Split out of
// main.ts (bundle-split task) because main.ts statically imports every other
// view - even though the old overlay branch only ever dynamically imported
// views/overlay/overlay.ts, the browser still had to fetch and execute the
// whole ~770KB main chunk first to reach that branch. This entry's dependency
// graph is just the overlay view + the shared api/state/ipc plumbing it
// already imports directly, so its chunk is a small fraction of that.
//
// Mirrors the (now-removed) `isOverlayWindow` branch in main.ts:
//   - Same CSS layering (tokens -> kit settings layer + palette -> base) so
//     the overlay picks up the same --color-* theme variables the rest of the
//     app uses (overlay.css falls back to hardcoded void/dark values without
//     this, same as before - this window still doesn't react to a live theme
//     switch; that gap is pre-existing, not something this split changes).
//   - No initBoot() (that's the multi-view router's boot sequence), so
//     settings are fetched once here directly - without it, overlay.ts's
//     valueColor(...,"overlay") call would never see paceColors/paceBand/
//     colorApplyTo and readOverlayOpacity would always fall
//     back to its default (ai_todo: multi-account overlay settings bug).
//   - No router/sidemenu/back-button/permission-modal/external-link wiring -
//     this window has none of that UI, so none of it is imported here.
import "./styles/tokens.css";
import "../vendor/tauri_kit/frontend/settings/styles.css";
import "../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default.css";
import "./styles/base.css";

import { invoke } from "./shared/ipc";
import { api } from "./shared/api";
import { setSettings } from "./shared/state";
import { renderOverlay } from "./views/overlay/overlay";
import { installPrintBlock } from "./shared/print-block";

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in overlay.html");
}

// Signal to the Rust boot watchdog that this webview loaded successfully
// (same ping main.ts sends for every other window - see lib.rs's setup fn).
void invoke("frontend_ready").catch(() => {});
installPrintBlock();

void (async () => {
  try {
    const settings = await api.getSettings();
    if (settings) setSettings(settings);
  } catch (e) {
    console.error("overlay: initial settings fetch failed", e);
  }
  void renderOverlay(app);
})();
