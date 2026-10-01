// Renders the chat pane's windows (layout.ts) into the FAB host's window
// layer: one Frame per window, panels mounted once and moved only when a tab
// changes window, docked windows reserving their width as pane padding so the
// chat itself shrinks, and every drag - move, resize, tear-off - with its
// landing preview. Each chat's layout is remembered (memory.ts).

import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import type { RailTabDeps } from "../rail-panel";
import { loadPopped, savePopped, saveOpen as savePreviewOpen, loadOpen as loadPreviewOpen } from "../rail-panel";
import type { PreviewController } from "../preview-panel";
import { Frame, type FrameEvents } from "./frame";
import { mountPanel, type MountedPanels, type PanelDeps, type PanelHandle } from "./panels";
import {
  centredRect, clampRect, cornerRect, dockRect, dockWidths, dropZoneAt, loadSize, MIN_CHAT, MIN_W, resizeRect,
  saveSize, zoneRect, type Bounds, type DropZone, type ResizeDir,
} from "./geometry";
import {
  closeWindow, dockedWindow, focusWindow, isShowing, mergeWindows, moveTab, openPanel, PANEL_KEYS, PANEL_META,
  place, setActive, setDockShare, tearOff, windowOf, type DockSide, type PaneLayout, type PaneWindow, type PanelKey,
  type Placement, type Rect,
} from "./layout";
import { recallLayout, rememberLayout } from "./memory";

/** Same breakpoint as sessions-mobile.css: on a phone each window is a sheet
 *  (Preview a full cover), one at a time, with no drag, dock or tear-off. */
const COMPACT_QUERY = "(max-width: 768px)";
/** Pointer travel before a press on a tab becomes a tear-off, not a click. */
const DRAG_SLOP = 6;
/** Matches .is-snapping's transition in pane-windows.css. */
const GLIDE_MS = 240;

export interface PaneWindowsDeps {
  onDraft(text: string): void;
  mountPreview: PanelDeps["mountPreview"];
  /** Fired after every layout change, so the dial can repaint its state. */
  onChange(): void;
}

type DropTarget = { kind: "merge"; id: string; index?: number } | { kind: "zone"; zone: DropZone } | null;

export class PaneWindows {
  private layout: PaneLayout;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private frames = new Map<string, Frame>();
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
  private ghost: HTMLElement | null = null;
  private ghostWanted = false;
  /** Whether Preview was on screen after the last render; its body only
   *  fetches when it comes into view (or on a push), so the edge matters. */
  private previewShown = false;
  /** The snapshot an open asked for, applied when Preview next comes into view. */
  private pendingSnapshot: string | undefined;
  /** A push landed while Preview's window was busy on another tab: its tab
   *  carries a dot until it is shown, rather than yanking that tab away. */
  private previewUnseen = false;

  constructor(
    private pane: HTMLElement,
    private layer: HTMLElement,
    private deps: PaneWindowsDeps,
  ) {
    this.panels = PANEL_KEYS.filter((p) => p !== "preview" || !!deps.mountPreview);
    this.layout = recallLayout("", this.panels);
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

  /** Whether the window holding `panel` is open, whatever tab it is on. */
  isWindowOpen(panel: PanelKey): boolean {
    return !!windowOf(this.layout, panel)?.open;
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

  private commit(next: PaneLayout): void {
    this.layout = next;
    this.render();
  }

  private compact(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;
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
    // On a phone only the front-most open window shows; it is a sheet.
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
      // was already up there. A phone's sheet or cover just appears.
      if (wasHidden && !f.el.hidden && !scoping && !compact) riseIn(f.el);
      for (const t of w.tabs) {
        const el = this.panelEl(t);
        if (el.parentElement !== f.body) f.body.appendChild(el);
        el.hidden = t !== w.active;
        if ((w.open && t === w.active) || t === "preview") this.ensureMounted(t);
      }
      this.syncPoppedNote(f, w);
    });
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

  private bounds(): Bounds {
    const box = this.layer.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  private dockPx(b: Bounds, also?: DockSide): { left: number; right: number } {
    const on = (side: DockSide) => {
      const w = dockedWindow(this.layout, side);
      return side === also || (!!w && this.visible(w));
    };
    return dockWidths(b.w, { left: on("left"), right: on("right") }, this.layout.dockShare);
  }

  private rectFor(w: PaneWindow, b: Bounds, dock: { left: number; right: number }): Rect {
    const p = w.placement;
    if (p.kind === "dock") return dockRect(p.side, dock[p.side], b);
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

  // ── Gestures ─────────────────────────────────────────────────────────────

  private frameEvents: FrameEvents = {
    focus: (id) => {
      if (this.layout.windows[this.layout.windows.length - 1]?.id === id) return;
      this.commit(focusWindow(this.layout, id));
    },
    barDown: (id, ev) => this.moveGesture(id, ev),
    resizeDown: (id, dir, ev) => this.resizeGesture(id, dir, ev),
    tabDown: (id, panel, ev) => this.tabGesture(id, panel, ev),
    action: (id, act) => {
      const w = this.layout.windows.find((x) => x.id === id);
      if (!w) return;
      if (act === "close") this.commit(closeWindow(this.layout, id));
      else if (act === "popout") this.popOut();
      else if (w.placement.kind === "dock") this.commit(place(this.layout, id, { kind: "float", rect: null }));
      else {
        const side: DockSide = dockedWindow(this.layout, "right") ? (dockedWindow(this.layout, "left") ? "right" : "left") : "right";
        this.commit(place(this.layout, id, { kind: "dock", side }));
      }
    },
  };

  /** Pointer capture plus move/up wiring shared by every gesture. Captured
   *  on the frame, not the pressed element: a render mid-drag can replace the
   *  bar's children, and a detached element loses the capture. */
  private track(
    target: HTMLElement,
    ev: PointerEvent,
    move: (e: PointerEvent) => void,
    up: (e: PointerEvent) => void,
  ): void {
    ev.preventDefault();
    target.setPointerCapture?.(ev.pointerId);
    const onMove = (e: Event) => move(e as PointerEvent);
    const onUp = (e: Event) => {
      target.releasePointerCapture?.((e as PointerEvent).pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      up(e as PointerEvent);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  private moveGesture(id: string, ev: PointerEvent): void {
    const f = this.frames.get(id);
    const w = this.layout.windows.find((x) => x.id === id);
    if (!f || !w || this.compact()) return;
    const b = this.bounds();
    const origin = this.layer.getBoundingClientRect();
    let start = this.rectFor(w, b, this.dockPx(b));
    let sx = ev.clientX;
    let sy = ev.clientY;
    let moved = false;
    let rect = start;
    let target: DropTarget = null;
    f.el.classList.add("is-moving");
    this.track(
      f.el,
      ev,
      (e) => {
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        if (!moved && w.placement.kind !== "float" && w.placement.kind !== "snap") {
          // Pulled off a dock: it becomes its floating size, under the pointer.
          const size = loadSize();
          const px = e.clientX - origin.left;
          start = clampRect({ x: px - size.w / 2, y: e.clientY - origin.top - 18, w: size.w, h: size.h }, b);
          sx = e.clientX;
          sy = e.clientY;
          this.commit(place(this.layout, id, { kind: "float", rect: start }));
        }
        moved = true;
        rect = clampRect({ ...start, x: start.x + e.clientX - sx, y: start.y + e.clientY - sy }, b);
        paintRect(f.el, rect);
        target = this.dropTargetAt(e, id, b);
        this.showTarget(target, b);
      },
      () => {
        f.el.classList.remove("is-moving");
        this.showTarget(null, b);
        if (!moved) return;
        const t = target as DropTarget;
        if (t?.kind === "merge") this.commit(mergeWindows(this.layout, id, t.id));
        else if (t?.kind === "zone") this.glide(f, () => this.commit(place(this.layout, id, zonePlacement(t))));
        else this.commit(place(this.layout, id, { kind: "float", rect }));
      },
    );
  }

  private resizeGesture(id: string, dir: ResizeDir, ev: PointerEvent): void {
    const f = this.frames.get(id);
    const w = this.layout.windows.find((x) => x.id === id);
    if (!f || !w || this.compact()) return;
    const b = this.bounds();
    const start = this.rectFor(w, b, this.dockPx(b));
    const rz = (ev.target as HTMLElement).closest<HTMLElement>("[data-rz]");
    rz?.classList.add("is-active");
    f.el.classList.add("is-resizing");
    const p = w.placement;
    let rect = start;
    this.track(
      f.el,
      ev,
      (e) => {
        const dx = e.clientX - ev.clientX;
        const dy = e.clientY - ev.clientY;
        if (p.kind === "dock") {
          // A docked window resizes from its inner edge only: the divider.
          const width = p.side === "left" ? start.w + dx : start.w - dx;
          const max = b.w - MIN_CHAT - (p.side === "left" ? this.dockPx(b).right : this.dockPx(b).left);
          const clamped = Math.min(Math.max(width, MIN_W), Math.max(MIN_W, max));
          this.layout = setDockShare(this.layout, p.side, clamped / b.w);
          this.paint();
          return;
        }
        rect = resizeRect(start, dir, dx, dy, b);
        paintRect(f.el, rect);
      },
      () => {
        rz?.classList.remove("is-active");
        f.el.classList.remove("is-resizing");
        if (p.kind === "dock") {
          this.commit(this.layout);
          return;
        }
        saveSize(rect);
        this.commit(place(this.layout, id, { kind: "float", rect }));
      },
    );
  }

  /** A press on a tab: released in place it switches tabs; dragged past
   *  the slop it tears the tab out, into another window or a new one. */
  private tabGesture(id: string, panel: PanelKey, ev: PointerEvent): void {
    const f = this.frames.get(id);
    if (!f) return;
    const b = this.bounds();
    let dragging = false;
    let target: DropTarget = null;
    let chip: HTMLElement | null = null;
    const origin = this.layer.getBoundingClientRect();
    this.track(
      f.el,
      ev,
      (e) => {
        if (!dragging && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < DRAG_SLOP) return;
        if (this.compact()) return;
        dragging = true;
        if (!chip) {
          chip = document.createElement("div");
          chip.className = "pw-tab-ghost";
          chip.innerHTML = `<i class="ph ${PANEL_META[panel].icon}"></i>${PANEL_META[panel].label}`;
          this.layer.appendChild(chip);
        }
        chip.style.left = `${e.clientX - origin.left + 12}px`;
        chip.style.top = `${e.clientY - origin.top + 10}px`;
        target = this.dropTargetAt(e, null, b);
        this.showTarget(target, b);
      },
      (e) => {
        chip?.remove();
        this.showTarget(null, b);
        if (!dragging) {
          this.commit(setActive(this.layout, id, panel));
          return;
        }
        if (target?.kind === "merge") {
          if (target.id !== id) this.commit(moveTab(this.layout, panel, target.id, target.index));
          else if (target.index !== undefined) this.commit(moveTab(this.layout, panel, id, target.index));
          return;
        }
        if (target?.kind === "zone") {
          this.commit(tearOff(this.layout, panel, zonePlacement(target)));
          return;
        }
        const size = loadSize();
        const rect = clampRect(
          { x: e.clientX - origin.left - 40, y: e.clientY - origin.top - 18, w: size.w, h: size.h },
          b,
        );
        this.commit(tearOff(this.layout, panel, { kind: "float", rect }));
      },
    );
  }

  /** Another window's bar merges; an edge or corner places. The
   *  window being dragged (`exclude`) is under the pointer, so frames are hit
   *  by rect, not elementFromPoint. */
  private dropTargetAt(e: PointerEvent, exclude: string | null, b: Bounds): DropTarget {
    const frontFirst = [...this.layout.windows].reverse();
    for (const w of frontFirst) {
      const f = this.frames.get(w.id);
      if (!f || f.el.hidden || w.id === exclude) continue;
      const hit = f.dropRect().some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
      if (hit) return { kind: "merge", id: w.id, index: f.tabIndexAt(e.clientX) };
    }
    const origin = this.layer.getBoundingClientRect();
    const zone = dropZoneAt(e.clientX - origin.left, e.clientY - origin.top, b);
    return zone ? { kind: "zone", zone } : null;
  }

  private showTarget(t: DropTarget, b: Bounds): void {
    for (const f of this.frames.values()) f.el.classList.toggle("pw-drop-target", t?.kind === "merge" && f.el.dataset.win === t.id);
    if (t?.kind !== "zone") {
      this.ghostWanted = false;
      this.ghost?.classList.remove("is-on");
      return;
    }
    const side = t.zone.kind === "dock" ? t.zone.side : undefined;
    const r = zoneRect(t.zone, b, side ? this.dockPx(b, side)[side] : 0);
    if (!this.ghost || !this.ghost.isConnected) {
      this.ghost = document.createElement("div");
      this.ghost.className = "fab-snap-ghost";
      this.ghost.setAttribute("aria-hidden", "true");
      this.layer.appendChild(this.ghost);
    }
    const g = this.ghost;
    paintRect(g, r);
    this.ghostWanted = true;
    requestAnimationFrame(() => {
      if (this.ghostWanted) g.classList.add("is-on");
    });
  }

  /** A drop into a zone eases into place rather than jumping. */
  private glide(f: Frame, apply: () => void): void {
    f.el.classList.add("is-snapping");
    apply();
    setTimeout(() => f.el.classList.remove("is-snapping"), GLIDE_MS);
  }
}

function riseIn(el: HTMLElement): void {
  // Re-armed each time: a window hidden mid-rise never fired animationend.
  el.classList.remove("is-entering");
  void el.offsetWidth;
  el.classList.add("is-entering");
  el.addEventListener("animationend", () => el.classList.remove("is-entering"), { once: true });
}

function zonePlacement(t: { kind: "zone"; zone: DropZone }): Placement {
  return t.zone.kind === "snap" ? { kind: "snap", corner: t.zone.corner } : { kind: "dock", side: t.zone.side };
}

function paintRect(el: HTMLElement, r: Rect): void {
  el.style.left = `${Math.round(r.x)}px`;
  el.style.top = `${Math.round(r.y)}px`;
  el.style.width = `${Math.round(r.w)}px`;
  el.style.height = `${Math.round(r.h)}px`;
}
