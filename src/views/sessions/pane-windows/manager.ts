// Renders the chat pane's windows (layout.ts) into the FAB host's window
// layer: one Frame per window, panels mounted once and moved only when a tab
// changes window, docked windows reserving their width as pane padding so the
// chat itself shrinks, and every drag - move, resize, tear-off - with its
// landing preview. Each chat's layout is remembered (memory.ts).

import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import { registerOverlayBack } from "../../../shared/back-button";
import type { RailTabDeps } from "../rail-panel";
import { loadPopped, savePopped, saveOpen as savePreviewOpen, loadOpen as loadPreviewOpen } from "../rail-panel";
import type { PreviewController } from "../preview-panel";
import { Frame, type FrameEvents } from "./frame";
import { GestureController, paintRect, type GestureHost } from "./gestures";
import { mountPanel, type MountedPanels, type PanelDeps, type PanelHandle } from "./panels";
import {
  centredRect, clampRect, cornerRect, dockRect, dockWidths, loadSize, stackRects, type Bounds,
} from "./geometry";
import {
  appendDock, closeWindow, dockStack, focusWindow, isShowing, openPanel, PANEL_KEYS, place, weightOf, windowOf,
  type DockSide, type PaneLayout, type PaneWindow, type PanelKey, type Rect,
} from "./layout";
import { recallLayout, rememberLayout } from "./memory";

/** Same breakpoint as sessions-mobile.css: on a phone each window is a full
 *  cover, one at a time, with no drag, dock or tear-off. */
const COMPACT_QUERY = "(max-width: 768px)";

export interface PaneWindowsDeps {
  onDraft(text: string): void;
  mountPreview: PanelDeps["mountPreview"];
  /** Fired after every layout change, so the dial can repaint its state. */
  onChange(): void;
}

export class PaneWindows implements GestureHost {
  layout: PaneLayout;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  frames = new Map<string, Frame>();
  private panelEls = new Map<PanelKey, HTMLElement>();
  private handles = new Map<PanelKey, PanelHandle>();
  private mounted: MountedPanels = { drafts: null, preview: null };
  private readonly panels: PanelKey[];
  /** Preview relocated to its own OS window for this chat (rail-panel.ts's
   *  `cc_preview_panel_popped:<id>`); the pane stops showing it. */
  private popped = false;
  private obs: ResizeObserver | null = null;
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
  /** Drives moveGesture/resizeGesture/tabGesture through this manager as a
   *  GestureHost (pane-windows/gestures.ts). */
  private readonly gestures: GestureController;
  /** Held while a phone cover is up, so hardware back closes it. */
  private disposeBack: (() => void) | null = null;

  constructor(
    private pane: HTMLElement,
    readonly layer: HTMLElement,
    private deps: PaneWindowsDeps,
  ) {
    this.panels = PANEL_KEYS.filter((p) => p !== "preview" || !!deps.mountPreview);
    this.layout = recallLayout("", this.panels);
    this.gestures = new GestureController(this);
    if (typeof ResizeObserver !== "undefined") {
      this.obs = new ResizeObserver(() => this.paint());
      this.obs.observe(layer);
    }
    if (deps.mountPreview) this.watchPopOut();
  }

  // ── Public ───────────────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null, cwd: string | null): void {
    const changed = sessionId !== this.sessionId;
    this.sessionId = sessionId;
    this.cwd = cwd;
    if (changed) {
      this.popped = !!sessionId && !!this.deps.mountPreview && loadPopped(sessionId);
      this.layout = sessionId ? recallLayout(sessionId, this.panels) : recallLayout("", this.panels);
      // Read before render() rewrites the flag from what is on screen.
      this.previewUnseen = !!sessionId && !this.popped && loadPreviewOpen(sessionId) && this.previewBusyElsewhere();
      this.pendingSnapshot = undefined;
    }
    // Before scoping: a panel mounted by render() picks the new scope up below.
    this.render(changed);
    for (const h of this.handles.values()) h.setSessionScope(sessionId, cwd);
  }

  openPanel(panel: PanelKey): void {
    if (!this.panels.includes(panel)) return;
    this.commit(openPanel(this.layout, panel));
  }

  togglePanel(panel: PanelKey): void {
    if (isShowing(this.layout, panel)) this.closePanel(panel);
    else this.openPanel(panel);
  }

  /** Closes the window a panel is showing in. */
  closePanel(panel: PanelKey): void {
    const w = windowOf(this.layout, panel);
    if (w) this.commit(closeWindow(this.layout, w.id));
  }

  isShowing(panel: PanelKey): boolean {
    return isShowing(this.layout, panel);
  }

  openDraft(id: string): void {
    this.openPanel("drafts");
    this.mounted.drafts?.openDraft(id);
  }

  /** Escape: closes the front-most open window. False when none was open. */
  closeFront(): boolean {
    const front = [...this.layout.windows].reverse().find((w) => this.visible(w));
    if (!front) return false;
    this.commit(closeWindow(this.layout, front.id));
    return true;
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
    this.obs?.disconnect();
    this.obs = null;
    if (this.storageHandler) window.removeEventListener("storage", this.storageHandler);
    this.unlistenDocked?.();
    this.disposeBack?.();
    this.disposeBack = null;
    for (const h of this.handles.values()) h.destroy();
    this.handles.clear();
    for (const f of this.frames.values()) f.destroy();
    this.frames.clear();
    this.pane.style.removeProperty("padding-left");
    this.pane.style.removeProperty("padding-right");
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
    if (this.previewBusyElsewhere()) {
      this.previewUnseen = true;
      if (snapshotId) this.pendingSnapshot = snapshotId;
      this.render();
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

  /** Preview shares an open window that is showing one of the other tabs. */
  private previewBusyElsewhere(): boolean {
    const w = windowOf(this.layout, "preview");
    return !!w && w.open && w.active !== "preview";
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
    if (w && w.open && w.active === "preview") this.layout = closeWindow(this.layout, w.id);
    this.render();
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
      this.commit(want ? openPanel(this.layout, "preview") : this.layout);
      if (!want && isShowing(this.layout, "preview")) this.closePanel("preview");
    };
    this.storageHandler = (e: StorageEvent) => {
      const sid = this.sessionId;
      if (!sid || e.key !== `cc_preview_panel_popped:${sid}`) return;
      if (e.newValue === "1") {
        this.popped = true;
        this.render();
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

  // ── Render ───────────────────────────────────────────────────────────────

  commit(next: PaneLayout): void {
    this.layout = next;
    this.render();
  }

  /** GestureHost's mid-drag path: a dock resize or stack-divider drag repaints
   *  every pointermove without the full render a commit would trigger. */
  setLayoutLive(next: PaneLayout): void {
    this.layout = next;
    this.paint();
  }

  compact(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;
  }

  private syncBack(covering: boolean): void {
    if (covering && !this.disposeBack) {
      this.disposeBack = registerOverlayBack(() => {
        const front = [...this.layout.windows].reverse().find((w) => this.visible(w));
        // offsetParent is null once the phone has gone back to the chat list.
        if (!front || !this.compact() || this.pane.offsetParent === null) return false;
        this.commit(closeWindow(this.layout, front.id));
        return true;
      });
    } else if (!covering && this.disposeBack) {
      this.disposeBack();
      this.disposeBack = null;
    }
  }

  /** Open, and not a Preview-only window whose content lives in the pop-out. */
  private visible(w: PaneWindow): boolean {
    return w.open && !(this.popped && w.tabs.length === 1 && w.tabs[0] === "preview");
  }

  private panelEl(panel: PanelKey): HTMLElement {
    let el = this.panelEls.get(panel);
    if (!el) {
      el = document.createElement("div");
      el.className = "pw-panel";
      el.dataset.panel = panel;
      this.panelEls.set(panel, el);
    }
    return el;
  }

  /** Mounted on first show; Preview at once, since it must hear a push for a
   *  chat whose Preview is closed in order to open it. */
  private ensureMounted(panel: PanelKey): void {
    if (this.handles.has(panel)) return;
    const deps: PanelDeps = {
      onDraft: this.deps.onDraft,
      mountPreview: this.deps.mountPreview,
      previewDeps: this.previewDeps(),
    };
    const h = mountPanel(panel, this.panelEl(panel), deps, this.mounted);
    this.handles.set(panel, h);
    h.setSessionScope(this.sessionId, this.cwd);
  }

  private render(scoping = false): void {
    const compact = this.compact();
    const live = new Set(this.layout.windows.map((w) => w.id));
    for (const [id, f] of this.frames) {
      if (live.has(id)) continue;
      f.destroy();
      this.frames.delete(id);
    }
    // On a phone only the front-most open window shows, as a full cover.
    const front = [...this.layout.windows].reverse().find((w) => this.visible(w));
    this.layout.windows.forEach((w, i) => {
      let f = this.frames.get(w.id);
      if (!f) {
        f = new Frame(w, this.frameEvents);
        this.frames.set(w.id, f);
        this.layer.appendChild(f.el);
      }
      f.update(w, { canPopOut: !compact, popped: this.popped, unseen: this.previewUnseen ? "preview" : null });
      // z-index, never DOM order: re-appending a frame would reload Preview's iframe.
      f.el.style.zIndex = String(i + 1);
      const wasHidden = f.el.hidden;
      f.el.hidden = !this.visible(w) || (compact && w !== front);
      // Only a real open rises in, not a chat switch landing on a window that
      // was already up there. A phone's cover just appears.
      if (wasHidden && !f.el.hidden && !scoping && !compact) riseIn(f.el);
      for (const t of w.tabs) {
        const el = this.panelEl(t);
        if (el.parentElement !== f.body) f.body.appendChild(el);
        el.hidden = t !== w.active;
        if ((w.open && t === w.active) || t === "preview") this.ensureMounted(t);
      }
      this.syncPoppedNote(f, w);
    });
    this.syncBack(compact && !!front);
    this.paint();
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
  private syncPoppedNote(f: Frame, w: PaneWindow): void {
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

  // ── Geometry ─────────────────────────────────────────────────────────────

  bounds(): Bounds {
    const box = this.layer.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  /** The windows on screen in `side`'s stack, top to bottom. */
  column(side: DockSide): PaneWindow[] {
    return dockStack(this.layout, side).filter((w) => this.visible(w));
  }

  dockPx(b: Bounds, also?: DockSide): { left: number; right: number } {
    const on = (side: DockSide) => side === also || this.column(side).length > 0;
    return dockWidths(b.w, { left: on("left"), right: on("right") }, this.layout.dockShare);
  }

  rectFor(w: PaneWindow, b: Bounds, dock: { left: number; right: number }): Rect {
    const p = w.placement;
    if (p.kind === "dock") {
      const col = this.column(p.side);
      const i = col.indexOf(w);
      if (i < 0) return dockRect(p.side, dock[p.side], b);
      return stackRects(p.side, dock[p.side], b, col.map(weightOf))[i]!;
    }
    if (p.kind === "snap") return cornerRect(p.corner, b);
    return p.rect ? clampRect(p.rect, b) : centredRect(loadSize(), b);
  }

  private paint(): void {
    const b = this.bounds();
    const compact = this.compact();
    const off = compact || b.w === 0 || b.h === 0;
    const dock = off ? { left: 0, right: 0 } : this.dockPx(b);
    // The split itself: the chat column gives up what the docks take.
    this.pane.style.paddingLeft = dock.left ? `${dock.left}px` : "";
    this.pane.style.paddingRight = dock.right ? `${dock.right}px` : "";
    this.pane.style.setProperty("--pw-dock-l", `${dock.left}px`);
    this.pane.style.setProperty("--pw-dock-r", `${dock.right}px`);
    for (const w of this.layout.windows) {
      const f = this.frames.get(w.id);
      if (!f || f.el.hidden) continue;
      const above = !off && w.placement.kind === "dock" && this.column(w.placement.side).indexOf(w) > 0;
      f.el.toggleAttribute("data-stack-above", above);
      if (off) {
        for (const k of ["left", "top", "width", "height"] as const) f.el.style.removeProperty(k);
        continue;
      }
      paintRect(f.el, this.rectFor(w, b, dock));
    }
    this.syncFabCover();
  }

  /** The FAB yields to a window lying on top of it rather than covering the
   *  window's own controls (its footer buttons sit right where the FAB rests). */
  private syncFabCover(): void {
    const host = this.layer.parentElement;
    const fab = host?.querySelector<HTMLElement>(".fab-dial-fab");
    if (!host || !fab) return;
    const fr = fab.getBoundingClientRect();
    const covered = [...this.frames.values()].some((f) => {
      if (f.el.hidden) return false;
      const r = f.el.getBoundingClientRect();
      return r.width > 0 && fr.left < r.right && fr.right > r.left && fr.top < r.bottom && fr.bottom > r.top;
    });
    host.toggleAttribute("data-fab-covered", covered);
  }

  // ── Frame wiring ─────────────────────────────────────────────────────────
  // The gestures themselves (move/resize/tab drag) live in gestures.ts;
  // this just routes a Frame's pointer events to them and to layout commits.

  private frameEvents: FrameEvents = {
    focus: (id) => {
      if (this.layout.windows[this.layout.windows.length - 1]?.id === id) return;
      this.commit(focusWindow(this.layout, id));
    },
    barDown: (id, ev) =>
      this.compact() ? this.gestures.swipeBackGesture(id, ev) : this.gestures.moveGesture(id, ev),
    resizeDown: (id, dir, ev) => this.gestures.resizeGesture(id, dir, ev),
    tabDown: (id, panel, ev) =>
      this.compact() ? this.gestures.swipeBackGesture(id, ev, panel) : this.gestures.tabGesture(id, panel, ev),
    action: (id, act) => {
      const w = this.layout.windows.find((x) => x.id === id);
      if (!w) return;
      if (act === "close") this.commit(closeWindow(this.layout, id));
      else if (act === "popout") this.popOut();
      else if (w.placement.kind === "dock") this.commit(place(this.layout, id, { kind: "float", rect: null }));
      // An empty side first; with both taken it joins the bottom of the right stack.
      else if (!this.column("right").length) this.commit(place(this.layout, id, { kind: "dock", side: "right" }));
      else if (!this.column("left").length) this.commit(place(this.layout, id, { kind: "dock", side: "left" }));
      else this.commit(appendDock(this.layout, id, "right"));
    },
  };

}

function riseIn(el: HTMLElement): void {
  // Re-armed each time: a window hidden mid-rise never fired animationend.
  el.classList.remove("is-entering");
  void el.offsetWidth;
  el.classList.add("is-entering");
  el.addEventListener("animationend", () => el.classList.remove("is-entering"), { once: true });
}
