// Each chat's window layout (Joe, 2026-10-01): leave a chat with Drafts
// parked top-right and Preview docked, come back, and it is all still there,
// across chat switches and app restarts.

import { loadOpen as loadPreviewOpen } from "../rail-panel";
import {
  isShowing, normalize, openPanel, windowOf, type PaneLayout,
} from "../../../../vendor/tauri_kit/frontend/pane-windows/layout";
import { createLayoutStore } from "../../../../vendor/tauri_kit/frontend/pane-windows/memory";
import type { PanelKey } from "./panels";

/** Oldest chats fall off first past 60; one untouched that long is not coming back. */
const store = createLayoutStore<PanelKey>({ key: "cc.paneWindows.chats", max: 60 });
/** The single-card memory this replaced, read once so a chat's open card
 *  survives the upgrade. */
const LEGACY_CARD_KEY = "cc.fabCard.chats";

function legacyCard(sessionId: string): { panel: PanelKey; open: boolean } | null {
  try {
    const all = JSON.parse(localStorage.getItem(LEGACY_CARD_KEY) ?? "{}");
    const hit = all?.[sessionId];
    if (hit && ["ask", "todos", "drafts"].includes(hit.panel)) return { panel: hit.panel, open: true };
  } catch {
    /* ignore */
  }
  return null;
}

/** This chat's layout, repaired against the panels this pane can host.
 *  Preview's open flag (`cc_preview_panel_open:<id>`) wins over the stored
 *  layout: the pop-out window and a background chat's push both write that
 *  flag without touching the layout. */
export function recallLayout(sessionId: string, panels: readonly PanelKey[]): PaneLayout<PanelKey> {
  const hit = store.recall(sessionId, panels);
  if (hit) return reconcilePreview(hit, sessionId);
  const layout = normalize(null, panels);
  const old = legacyCard(sessionId);
  if (old) {
    const main = layout.windows.find((w) => w.tabs.includes(old.panel));
    if (main) {
      main.open = true;
      main.active = old.panel;
    }
  }
  return reconcilePreview(layout, sessionId);
}

function reconcilePreview(layout: PaneLayout<PanelKey>, sessionId: string): PaneLayout<PanelKey> {
  const pv = windowOf(layout, "preview");
  if (!pv) return layout;
  const want = loadPreviewOpen(sessionId);
  if (want && !isShowing(layout, "preview")) {
    // A shared window left on another tab keeps it; the manager dots Preview's tab.
    return pv.open ? layout : openPanel(layout, "preview");
  }
  // Closed elsewhere: only a window Preview has to itself closes with it.
  if (!want && pv.open && pv.tabs.length === 1) pv.open = false;
  return layout;
}

export function rememberLayout(sessionId: string, layout: PaneLayout<PanelKey>): void {
  store.remember(sessionId, layout);
}
