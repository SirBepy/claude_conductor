// The chat pane's windows: the kit's PaneWindowManager
// (vendor/tauri_kit/frontend/pane-windows/) hosting this app's panels
// (panels.ts), scoped per chat with each chat's layout remembered
// (memory.ts), plus the Preview adapter - its pop-out OS window, the dot on
// its tab when a push lands behind another tab, and the PreviewController
// the rest of the app holds it as.

import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import { registerOverlayBack } from "../../../shared/back-button";
import type { RailTabDeps } from "../rail-panel";
import { loadPopped, savePopped, saveOpen as savePreviewOpen, loadOpen as loadPreviewOpen } from "../rail-panel";
import type { PreviewController } from "../preview-panel";
import { PaneWindowManager } from "../../../../vendor/tauri_kit/frontend/pane-windows/manager";
import {
  closeWindow, isShowing, openPanel, windowOf, type PaneLayout, type PaneWindow,
} from "../../../../vendor/tauri_kit/frontend/pane-windows/layout";
import { mountPanel, PANEL_KEYS, PANEL_META, type MountedPanels, type PanelDeps, type PanelHandle, type PanelKey } from "./panels";
import { recallLayout, rememberLayout } from "./memory";

export interface PaneWindowsDeps {
  onDraft(text: string): void;
  mountPreview: PanelDeps["mountPreview"];
  /** Fired after every layout change, so the dial can repaint its state. */
  onChange(): void;
}

export class PaneWindows {
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private handles = new Map<PanelKey, PanelHandle>();
  private mounted: MountedPanels = { drafts: null, preview: null };
  private readonly panels: PanelKey[];
  private readonly mgr: PaneWindowManager<PanelKey>;
  /** Preview relocated to its own OS window for this chat (rail-panel.ts's
   *  `cc_preview_panel_popped:<id>`); the pane stops showing it. */
  private popped = false;
  private storageHandler: ((e: StorageEvent) => void) | null = null;
  private unlistenDocked: (() => void) | null = null;
  private destroyed = false;
  /** Whether Preview was on screen after the last render; its body only
   *  fetches when it comes into view (or on a push), so the edge matters. */
  private previewShown = false;
  /** The snapshot an open asked for, applied when Preview next comes into view. */
  private pendingSnapshot: string | undefined;
  /** A push landed while Preview's window was busy on another tab: its tab
   *  carries a dot until it is shown, rather than yanking that tab away. */
  private previewUnseen = false;

  constructor(
    pane: HTMLElement,
    readonly layer: HTMLElement,
    private deps: PaneWindowsDeps,
  ) {
    this.panels = PANEL_KEYS.filter((p) => p !== "preview" || !!deps.mountPreview);
    this.mgr = new PaneWindowManager<PanelKey>(
      pane,
      layer,
      {
        panels: this.panels,
        meta: (p) => PANEL_META[p],
        mountPanel: (p, root) => this.mountOne(p, root),
        // Preview at once: it must hear a push for a chat whose Preview is
        // closed in order to open it.
        mountEagerly: (p) => p === "preview",
        sizeKey: "cc.fabCard.size",
        dockTitle: "Dock beside the chat",
        isHidden: (w) => this.popped && w.tabs.length === 1 && w.tabs[0] === "preview",
        chrome: (w, compact) => ({
          buttons:
            w.active === "preview" && !compact && !this.popped
              ? `<button type="button" class="pw-btn" data-pw-act="popout" title="Pop out into its own window">` +
                `<i class="ph ph-arrow-square-out"></i></button>`
              : "",
          unseen: this.previewUnseen ? "preview" : null,
        }),
        onAction: (_id, act) => {
          if (act === "popout") this.popOut();
        },
        registerBack: registerOverlayBack,
        onRender: ({ scoping }) => this.afterRender(scoping),
        onPaint: () => this.syncFabCover(),
      },
      recallLayout("", this.panels),
    );
    if (deps.mountPreview) this.watchPopOut();
  }

  /** The live layout; the view specs and the dial read it. */
  get layout(): PaneLayout<PanelKey> {
    return this.mgr.layout;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null, cwd: string | null): void {
    const changed = sessionId !== this.sessionId;
    this.sessionId = sessionId;
    this.cwd = cwd;
    if (changed) {
      this.popped = !!sessionId && !!this.deps.mountPreview && loadPopped(sessionId);
      const layout = recallLayout(sessionId ?? "", this.panels);
      // Read before the render rewrites the flag from what is on screen.
      this.previewUnseen =
        !!sessionId && !this.popped && loadPreviewOpen(sessionId) && previewBusyElsewhere(layout);
      this.pendingSnapshot = undefined;
      this.mgr.load(layout);
    } else {
      this.mgr.refresh();
    }
    // After the render: a panel it mounted already picked the new scope up.
    for (const h of this.handles.values()) h.setSessionScope(sessionId, cwd);
  }

  openPanel(panel: PanelKey): void {
    this.mgr.openPanel(panel);
  }

  togglePanel(panel: PanelKey): void {
    this.mgr.togglePanel(panel);
  }

  /** Closes the window a panel is showing in. */
  closePanel(panel: PanelKey): void {
    this.mgr.closePanel(panel);
  }

  isShowing(panel: PanelKey): boolean {
    return this.mgr.isShowing(panel);
  }

  openDraft(id: string): void {
    this.openPanel("drafts");
    this.mounted.drafts?.openDraft(id);
  }

  /** Escape: closes the front-most open window. False when none was open. */
  closeFront(): boolean {
    return this.mgr.closeFront();
  }

  /** The pane's PreviewController: what sessions.ts, the overflow menu and
   *  state.ts held the old Preview side panel as. */
  previewController(): PreviewController {
    return {
      toggle: () => {
        // Popped out, so there is nothing here to toggle - surface that window.
        if (this.popped) return this.popOut();
        this.togglePanel("preview");
      },
      open: (snapshotId?: string) => this.openPreview(snapshotId),
      close: () => this.closePanel("preview"),
      isOpen: () => this.previewOpen(),
      // FabDial scopes this whole manager; state.ts calling it too is a no-op.
      setSessionScope: () => {},
      popOut: () => this.popOut(),
      dockBack: () => {},
      destroy: () => {},
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.storageHandler) window.removeEventListener("storage", this.storageHandler);
    this.unlistenDocked?.();
    this.mgr.destroy();
    this.handles.clear();
  }

  // ── Panels ───────────────────────────────────────────────────────────────

  private mountOne(panel: PanelKey, root: HTMLElement): { destroy(): void } {
    const deps: PanelDeps = {
      onDraft: this.deps.onDraft,
      mountPreview: this.deps.mountPreview,
      previewDeps: this.previewDeps(),
    };
    const h = mountPanel(panel, root, deps, this.mounted);
    this.handles.set(panel, h);
    h.setSessionScope(this.sessionId, this.cwd);
    return h;
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  private previewDeps(): RailTabDeps {
    return {
      isOpen: () => this.previewOpen(),
      isVisible: () => !this.popped && isShowing(this.layout, "preview"),
      requestOpen: (id) => this.openPreview(id),
      markOpenFor: (sid) => savePreviewOpen(sid, true),
    };
  }

  /** Popped still counts as open: the pop-out's restore needs to know to
   *  bring it back. */
  private previewOpen(): boolean {
    if (this.popped) return !!this.sessionId && loadPreviewOpen(this.sessionId);
    return isShowing(this.layout, "preview");
  }

  private openPreview(snapshotId?: string): void {
    if (!this.panels.includes("preview")) return;
    if (this.popped) {
      if (this.sessionId) savePreviewOpen(this.sessionId, true);
      return;
    }
    if (previewBusyElsewhere(this.layout)) {
      this.previewUnseen = true;
      if (snapshotId) this.pendingSnapshot = snapshotId;
      this.mgr.refresh();
      return;
    }
    if (this.previewShown) {
      this.openPanel("preview");
      this.mounted.preview?.refresh(snapshotId ? { selectId: snapshotId } : {});
      return;
    }
    this.pendingSnapshot = snapshotId;
    this.openPanel("preview");
  }

  private popOut(): void {
    const sid = this.sessionId;
    if (!sid) return;
    this.popped = true;
    savePopped(sid, true);
    savePreviewOpen(sid, true);
    // A shared window on Preview goes too, as a Preview-only one would; its
    // other tabs were behind Preview anyway.
    const w = windowOf(this.layout, "preview");
    if (w && w.open && w.active === "preview") this.mgr.commit(closeWindow(this.layout, w.id));
    else this.mgr.refresh();
    void invoke("open_preview_window", { sessionId: sid }).catch((err) => {
      console.error("[pane-windows] open_preview_window failed", err);
    });
  }

  /** The pop-out's close is a Rust-side hide that writes nothing, so this
   *  event is the only signal it is gone; the storage flip covers the
   *  pop-out's own restore and X, which write the flags before closing. */
  private watchPopOut(): void {
    const back = (sid: string) => {
      if (sid !== this.sessionId) return;
      this.popped = false;
      const want = loadPreviewOpen(sid);
      this.mgr.commit(want ? openPanel(this.layout, "preview") : this.layout);
      if (!want && isShowing(this.layout, "preview")) this.closePanel("preview");
    };
    this.storageHandler = (e: StorageEvent) => {
      const sid = this.sessionId;
      if (!sid || e.key !== `cc_preview_panel_popped:${sid}`) return;
      if (e.newValue === "1") {
        this.popped = true;
        this.mgr.refresh();
      } else back(sid);
    };
    window.addEventListener("storage", this.storageHandler);
    void listen<{ sessionId: string }>("preview-window-docked", (p) => {
      if (!p?.sessionId) return;
      savePopped(p.sessionId, false);
      back(p.sessionId);
    }).then((un) => {
      if (this.destroyed) un();
      else this.unlistenDocked = un;
    });
  }

  // ── Render hooks ─────────────────────────────────────────────────────────

  private afterRender(scoping: boolean): void {
    for (const w of this.layout.windows) this.syncPoppedNote(w);
    const shown = !this.popped && isShowing(this.layout, "preview");
    // A chat switch is the body's own setSessionScope's to fetch for.
    if (shown && !this.previewShown && !scoping) {
      const id = this.pendingSnapshot;
      this.mounted.preview?.refresh(id ? { selectId: id } : {});
    }
    if (shown) {
      this.pendingSnapshot = undefined;
      this.previewUnseen = false;
    }
    this.previewShown = shown;
    if (this.sessionId) {
      rememberLayout(this.sessionId, this.layout);
      if (!this.popped && this.panels.includes("preview")) {
        savePreviewOpen(this.sessionId, isShowing(this.layout, "preview"));
      }
    }
    this.deps.onChange();
  }

  /** Preview popped out while it shares a window: its tab says where it went. */
  private syncPoppedNote(w: PaneWindow<PanelKey>): void {
    const f = this.mgr.frames.get(w.id);
    if (!f) return;
    let note = f.body.querySelector<HTMLElement>(".pw-popped-note");
    const show = this.popped && w.active === "preview" && w.tabs.length > 1;
    if (!show) {
      note?.remove();
      return;
    }
    if (!note) {
      note = document.createElement("div");
      note.className = "pw-popped-note";
      note.innerHTML =
        `<i class="ph ph-arrow-square-out"></i><p>Preview is open in its own window.</p>` +
        `<button type="button" class="pw-note-btn">Show it</button>`;
      note.querySelector("button")!.addEventListener("click", () => this.popOut());
      f.body.appendChild(note);
    }
  }

  /** The FAB yields to a window lying on top of it rather than covering the
   *  window's own controls (its footer buttons sit right where the FAB rests). */
  private syncFabCover(): void {
    const host = this.layer.parentElement;
    const fab = host?.querySelector<HTMLElement>(".fab-dial-fab");
    if (!host || !fab) return;
    const fr = fab.getBoundingClientRect();
    const covered = [...this.mgr.frames.values()].some((f) => {
      if (f.el.hidden) return false;
      const r = f.el.getBoundingClientRect();
      return r.width > 0 && fr.left < r.right && fr.right > r.left && fr.top < r.bottom && fr.bottom > r.top;
    });
    host.toggleAttribute("data-fab-covered", covered);
  }
}

/** Preview shares an open window that is showing one of the other tabs. */
function previewBusyElsewhere(layout: PaneLayout<PanelKey>): boolean {
  const w = windowOf(layout, "preview");
  return !!w && w.open && w.active !== "preview";
}
