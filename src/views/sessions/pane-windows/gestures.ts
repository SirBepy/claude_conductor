// The pane windows' three pointer gestures - move, resize, tab drag/tear-off
// - plus the drop-target and landing-ghost helpers they share. Split out of
// manager.ts, which was pushing 760 lines: the manager keeps layout state,
// render and paint, and drives a gesture only through the narrow GestureHost
// view below - layout read/commit, frames, bounds, dockPx, rectFor.

import type { Frame } from "./frame";
import {
  clampRect, dropZoneAt, loadSize, MIN_CHAT, MIN_STACK_H, MIN_W, resizeRect, saveSize, stackRects, zoneRect,
  type Bounds, type DropZone, type ResizeDir,
} from "./geometry";
import {
  closeWindow, mergeWindows, moveTab, PANEL_META, place, setActive, setDockShare, setWeights, stackInto, tearOff,
  weightOf, windowOf, type DockSide, type PaneLayout, type PaneWindow, type PanelKey, type Placement, type Rect,
} from "./layout";

/** Pointer travel before a press on a tab becomes a tear-off, not a click. */
const DRAG_SLOP = 6;
/** Sideways travel on a phone window's bar that closes it on release. */
const SWIPE_BACK_PX = 80;
/** Matches .is-snapping's transition in pane-windows.css. */
const GLIDE_MS = 240;

type DropTarget =
  | { kind: "merge"; id: string; index?: number }
  | { kind: "zone"; zone: DropZone }
  /** Onto a docked window's upper or lower half: stack above or below it. */
  | { kind: "split"; id: string; where: "before" | "after" }
  | null;

/** What a gesture needs from the manager: layout read/commit, the live
 *  frames, and the geometry it would otherwise have to recompute. */
export interface GestureHost {
  readonly layout: PaneLayout;
  readonly layer: HTMLElement;
  readonly frames: ReadonlyMap<string, Frame>;
  compact(): boolean;
  column(side: DockSide): PaneWindow[];
  bounds(): Bounds;
  dockPx(b: Bounds, also?: DockSide): { left: number; right: number };
  rectFor(w: PaneWindow, b: Bounds, dock: { left: number; right: number }): Rect;
  /** Mid-drag layout tweak (dock resize, stack divider): repaints without a
   *  full render, since re-mounting panels on every pixel would be wasteful. */
  setLayoutLive(next: PaneLayout): void;
  /** The drop's real commit: re-renders and persists. */
  commit(next: PaneLayout): void;
}

export function paintRect(el: HTMLElement, r: Rect): void {
  el.style.left = `${Math.round(r.x)}px`;
  el.style.top = `${Math.round(r.y)}px`;
  el.style.width = `${Math.round(r.w)}px`;
  el.style.height = `${Math.round(r.h)}px`;
}

function zonePlacement(t: { kind: "zone"; zone: DropZone }): Placement {
  return t.zone.kind === "snap" ? { kind: "snap", corner: t.zone.corner } : { kind: "dock", side: t.zone.side };
}

export class GestureController {
  private ghost: HTMLElement | null = null;
  private ghostWanted = false;

  constructor(private host: GestureHost) {}

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

  moveGesture(id: string, ev: PointerEvent): void {
    const host = this.host;
    const f = host.frames.get(id);
    const w = host.layout.windows.find((x) => x.id === id);
    if (!f || !w || host.compact()) return;
    const b = host.bounds();
    const origin = host.layer.getBoundingClientRect();
    let start = host.rectFor(w, b, host.dockPx(b));
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
          host.commit(place(host.layout, id, { kind: "float", rect: start }));
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
        if (t?.kind === "merge") host.commit(mergeWindows(host.layout, id, t.id));
        else if (t?.kind === "split") this.glide(f, () => host.commit(stackInto(host.layout, id, t.id, t.where)));
        else if (t?.kind === "zone") this.glide(f, () => host.commit(place(host.layout, id, zonePlacement(t))));
        else host.commit(place(host.layout, id, { kind: "float", rect }));
      },
    );
  }

  resizeGesture(id: string, dir: ResizeDir, ev: PointerEvent): void {
    const host = this.host;
    const f = host.frames.get(id);
    const w = host.layout.windows.find((x) => x.id === id);
    if (!f || !w || host.compact()) return;
    if (w.placement.kind === "dock" && dir === "n") return this.stackDividerGesture(f, w, w.placement.side, ev);
    const b = host.bounds();
    const start = host.rectFor(w, b, host.dockPx(b));
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
          const max = b.w - MIN_CHAT - (p.side === "left" ? host.dockPx(b).right : host.dockPx(b).left);
          const clamped = Math.min(Math.max(width, MIN_W), Math.max(MIN_W, max));
          host.setLayoutLive(setDockShare(host.layout, p.side, clamped / b.w));
          return;
        }
        rect = resizeRect(start, dir, dx, dy, b);
        paintRect(f.el, rect);
      },
      () => {
        rz?.classList.remove("is-active");
        f.el.classList.remove("is-resizing");
        if (p.kind === "dock") {
          host.commit(host.layout);
          return;
        }
        saveSize(rect);
        host.commit(place(host.layout, id, { kind: "float", rect }));
      },
    );
  }

  /** The divider between a stacked window and the one above it: the pair
   *  trades height, every other window in the stack stays put. */
  private stackDividerGesture(f: Frame, w: PaneWindow, side: DockSide, ev: PointerEvent): void {
    const host = this.host;
    const col = host.column(side);
    const i = col.indexOf(w);
    const up = col[i - 1];
    if (i < 1 || !up) return;
    const rects = stackRects(side, 1, host.bounds(), col.map(weightOf));
    const upH = rects[i - 1]!.h;
    const pairH = upH + rects[i]!.h;
    const pairW = weightOf(up) + weightOf(w);
    const rz = (ev.target as HTMLElement).closest<HTMLElement>("[data-rz]");
    rz?.classList.add("is-active");
    f.el.classList.add("is-resizing");
    this.track(
      f.el,
      ev,
      (e) => {
        const h = Math.min(Math.max(upH + e.clientY - ev.clientY, MIN_STACK_H), Math.max(MIN_STACK_H, pairH - MIN_STACK_H));
        host.setLayoutLive(
          setWeights(host.layout, { [up.id]: (pairW * h) / pairH, [w.id]: (pairW * (pairH - h)) / pairH }),
        );
      },
      () => {
        rz?.classList.remove("is-active");
        f.el.classList.remove("is-resizing");
        host.commit(host.layout);
      },
    );
  }

  /** Phone only: the window follows a sideways drag on its bar and closes
   *  back to the chat past SWIPE_BACK_PX (Joe, 2026-10-05). The bar is the
   *  one strip Preview's iframe cannot swallow. Released in place on a tab,
   *  it still switches to that tab. */
  swipeBackGesture(id: string, ev: PointerEvent, panel?: PanelKey): void {
    const host = this.host;
    const f = host.frames.get(id);
    if (!f) return;
    let dx = 0;
    let travelled = false;
    this.track(
      f.el,
      ev,
      (e) => {
        dx = e.clientX - ev.clientX;
        if (Math.hypot(dx, e.clientY - ev.clientY) >= DRAG_SLOP) travelled = true;
        if (travelled) f.el.style.transform = `translateX(${dx}px)`;
      },
      () => {
        f.el.style.removeProperty("transform");
        if (Math.abs(dx) >= SWIPE_BACK_PX) host.commit(closeWindow(host.layout, id));
        else if (!travelled && panel) host.commit(setActive(host.layout, id, panel));
      },
    );
  }

  /** A press on a tab: released in place it switches tabs; dragged past
   *  the slop it tears the tab out, into another window or a new one. */
  tabGesture(id: string, panel: PanelKey, ev: PointerEvent): void {
    const host = this.host;
    const f = host.frames.get(id);
    if (!f) return;
    const b = host.bounds();
    let dragging = false;
    let target: DropTarget = null;
    let chip: HTMLElement | null = null;
    const origin = host.layer.getBoundingClientRect();
    this.track(
      f.el,
      ev,
      (e) => {
        if (!dragging && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < DRAG_SLOP) return;
        if (host.compact()) return;
        dragging = true;
        if (!chip) {
          chip = document.createElement("div");
          chip.className = "pw-tab-ghost";
          chip.innerHTML = `<i class="ph ${PANEL_META[panel].icon}"></i>${PANEL_META[panel].label}`;
          host.layer.appendChild(chip);
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
          host.commit(setActive(host.layout, id, panel));
          return;
        }
        if (target?.kind === "merge") {
          if (target.id !== id) host.commit(moveTab(host.layout, panel, target.id, target.index));
          else if (target.index !== undefined) host.commit(moveTab(host.layout, panel, id, target.index));
          return;
        }
        if (target?.kind === "zone") {
          host.commit(tearOff(host.layout, panel, zonePlacement(target)));
          return;
        }
        if (target?.kind === "split") {
          // A window's only tab dropped on its own half has nowhere new to go.
          if (target.id === id && windowOf(host.layout, panel)?.tabs.length === 1) return;
          const torn = tearOff(host.layout, panel, { kind: "float", rect: null });
          host.commit(stackInto(torn, torn.windows[torn.windows.length - 1]!.id, target.id, target.where));
          return;
        }
        const size = loadSize();
        const rect = clampRect(
          { x: e.clientX - origin.left - 40, y: e.clientY - origin.top - 18, w: size.w, h: size.h },
          b,
        );
        host.commit(tearOff(host.layout, panel, { kind: "float", rect }));
      },
    );
  }

  /** Another window's bar merges; an edge or corner places; a docked
   *  window's body splits its stack. The window being dragged (`exclude`) is
   *  under the pointer, so frames are hit by rect, not elementFromPoint. */
  private dropTargetAt(e: PointerEvent, exclude: string | null, b: Bounds): DropTarget {
    const host = this.host;
    const frontFirst = [...host.layout.windows].reverse();
    for (const w of frontFirst) {
      const f = host.frames.get(w.id);
      if (!f || f.el.hidden || w.id === exclude) continue;
      const hit = f.dropRect().some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
      if (hit) return { kind: "merge", id: w.id, index: f.tabIndexAt(e.clientX) };
    }
    const origin = host.layer.getBoundingClientRect();
    const zone = dropZoneAt(e.clientX - origin.left, e.clientY - origin.top, b);
    if (zone) return { kind: "zone", zone };
    for (const w of frontFirst) {
      const f = host.frames.get(w.id);
      if (!f || f.el.hidden || w.id === exclude || w.placement.kind !== "dock") continue;
      const r = f.el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      return { kind: "split", id: w.id, where: e.clientY < r.top + r.height / 2 ? "before" : "after" };
    }
    return null;
  }

  /** What a split drop will take: the target's upper or lower half. */
  private splitRect(t: { id: string; where: "before" | "after" }): Rect | null {
    const f = this.host.frames.get(t.id);
    if (!f) return null;
    const r = f.el.getBoundingClientRect();
    const origin = this.host.layer.getBoundingClientRect();
    const h = r.height / 2;
    return { x: r.left - origin.left, y: r.top - origin.top + (t.where === "after" ? h : 0), w: r.width, h };
  }

  private showTarget(t: DropTarget, b: Bounds): void {
    const host = this.host;
    for (const f of host.frames.values()) f.el.classList.toggle("pw-drop-target", t?.kind === "merge" && f.el.dataset.win === t.id);
    let r: Rect | null = null;
    if (t?.kind === "zone") {
      const side = t.zone.kind === "dock" ? t.zone.side : undefined;
      r = zoneRect(t.zone, b, side ? host.dockPx(b, side)[side] : 0);
    } else if (t?.kind === "split") {
      r = this.splitRect(t);
    }
    if (!r) {
      this.ghostWanted = false;
      this.ghost?.classList.remove("is-on");
      return;
    }
    if (!this.ghost || !this.ghost.isConnected) {
      this.ghost = document.createElement("div");
      this.ghost.className = "fab-snap-ghost";
      this.ghost.setAttribute("aria-hidden", "true");
      host.layer.appendChild(this.ghost);
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
