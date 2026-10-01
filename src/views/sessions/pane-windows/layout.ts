// The chat pane's window layout (Joe, 2026-10-01): Ask / Todos / Drafts /
// Preview live as tabs in one or more in-app windows. Each window floats,
// snaps to a corner, or docks to the left or right as a real split, and any
// tab can be torn out into its own window or dropped into another one.
// Pure data in, data out - manager.ts owns the DOM.

export type PanelKey = "ask" | "todos" | "drafts" | "preview";
export type Corner = "nw" | "ne" | "sw" | "se";
export type DockSide = "left" | "right";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Placement =
  /** rect null = centred at the remembered size. */
  | { kind: "float"; rect: Rect | null }
  | { kind: "snap"; corner: Corner }
  | { kind: "dock"; side: DockSide };

export interface PaneWindow {
  id: string;
  tabs: PanelKey[];
  active: PanelKey;
  placement: Placement;
  open: boolean;
}

export interface PaneLayout {
  /** Back to front: the last open window paints on top. */
  windows: PaneWindow[];
  /** Each docked side's share of the pane width, null = the default. */
  dockShare: { left: number | null; right: number | null };
}

export const PANEL_KEYS: readonly PanelKey[] = ["ask", "todos", "drafts", "preview"];

export const PANEL_META: Record<PanelKey, { label: string; icon: string }> = {
  ask: { label: "Ask", icon: "ph-chat-teardrop-dots" },
  todos: { label: "Todos", icon: "ph-list-checks" },
  drafts: { label: "Drafts", icon: "ph-note-pencil" },
  preview: { label: "Preview", icon: "ph-monitor-play" },
};

let seq = 0;
/** Unique within a layout; collisions across chats do not matter. */
export function newWindowId(): string {
  seq += 1;
  return `w${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Ask / Todos / Drafts share one floating window; Preview has its own,
 *  docked right where the old Preview side panel used to sit. */
export function defaultLayout(panels: readonly PanelKey[] = PANEL_KEYS): PaneLayout {
  const main = panels.filter((p) => p !== "preview");
  const windows: PaneWindow[] = [];
  if (main.length) {
    windows.push({ id: "main", tabs: main, active: main[0]!, placement: { kind: "float", rect: null }, open: false });
  }
  if (panels.includes("preview")) {
    windows.push({ id: "preview", tabs: ["preview"], active: "preview", placement: { kind: "dock", side: "right" }, open: false });
  }
  return { windows, dockShare: { left: null, right: null } };
}

const clone = (l: PaneLayout): PaneLayout => ({
  windows: l.windows.map((w) => ({ ...w, tabs: [...w.tabs] })),
  dockShare: { ...l.dockShare },
});

export function windowOf(l: PaneLayout, panel: PanelKey): PaneWindow | undefined {
  return l.windows.find((w) => w.tabs.includes(panel));
}

export function isShowing(l: PaneLayout, panel: PanelKey): boolean {
  const w = windowOf(l, panel);
  return !!w && w.open && w.active === panel;
}

function toFront(l: PaneLayout, id: string): void {
  const i = l.windows.findIndex((w) => w.id === id);
  if (i < 0 || i === l.windows.length - 1) return;
  const [w] = l.windows.splice(i, 1);
  l.windows.push(w!);
}

/** One window per docked side: whoever held the side floats out, centred. */
function vacate(l: PaneLayout, side: DockSide, except: string): void {
  for (const w of l.windows) {
    if (w.id !== except && w.placement.kind === "dock" && w.placement.side === side) {
      w.placement = { kind: "float", rect: null };
    }
  }
}

export function focusWindow(l: PaneLayout, id: string): PaneLayout {
  const next = clone(l);
  toFront(next, id);
  return next;
}

export function openPanel(l: PaneLayout, panel: PanelKey): PaneLayout {
  const next = clone(l);
  const w = windowOf(next, panel);
  if (!w) return next;
  w.open = true;
  w.active = panel;
  toFront(next, w.id);
  return next;
}

export function closeWindow(l: PaneLayout, id: string): PaneLayout {
  const next = clone(l);
  const w = next.windows.find((x) => x.id === id);
  if (w) w.open = false;
  return next;
}

export function setActive(l: PaneLayout, id: string, panel: PanelKey): PaneLayout {
  const next = clone(l);
  const w = next.windows.find((x) => x.id === id);
  if (w && w.tabs.includes(panel)) w.active = panel;
  toFront(next, id);
  return next;
}

export function place(l: PaneLayout, id: string, placement: Placement): PaneLayout {
  const next = clone(l);
  const w = next.windows.find((x) => x.id === id);
  if (!w) return next;
  if (placement.kind === "dock") vacate(next, placement.side, id);
  w.placement = placement;
  w.open = true;
  toFront(next, id);
  return next;
}

/** Pulls one tab out of wherever it is. A window left with no tabs is gone;
 *  one left with tabs falls back to its first. */
function detach(l: PaneLayout, panel: PanelKey): PaneWindow | undefined {
  const src = windowOf(l, panel);
  if (!src) return undefined;
  src.tabs = src.tabs.filter((t) => t !== panel);
  if (src.tabs.length === 0) l.windows = l.windows.filter((w) => w.id !== src.id);
  else if (src.active === panel) src.active = src.tabs[0]!;
  return src;
}

/** Tears a tab into its own new window. Tearing a window's only tab just
 *  moves that window, so it keeps its id and nothing flickers. */
export function tearOff(l: PaneLayout, panel: PanelKey, placement: Placement): PaneLayout {
  const src = windowOf(l, panel);
  if (src && src.tabs.length === 1) return place(l, src.id, placement);
  const next = clone(l);
  detach(next, panel);
  const id = newWindowId();
  next.windows.push({ id, tabs: [panel], active: panel, placement, open: true });
  if (placement.kind === "dock") vacate(next, placement.side, id);
  return next;
}

/** Drops a tab into another window at tab slot `index`, else last. */
export function moveTab(l: PaneLayout, panel: PanelKey, targetId: string, index?: number): PaneLayout {
  const next = clone(l);
  const target = next.windows.find((w) => w.id === targetId);
  if (!target) return next;
  if (target.tabs.includes(panel)) {
    target.tabs = target.tabs.filter((t) => t !== panel);
  } else {
    detach(next, panel);
  }
  const at = index === undefined ? target.tabs.length : Math.max(0, Math.min(index, target.tabs.length));
  target.tabs.splice(at, 0, panel);
  target.active = panel;
  target.open = true;
  toFront(next, targetId);
  return next;
}

/** Drops a whole window's tabs into another one; the dragged window is gone. */
export function mergeWindows(l: PaneLayout, fromId: string, toId: string): PaneLayout {
  if (fromId === toId) return l;
  const from = l.windows.find((w) => w.id === fromId);
  if (!from) return l;
  let next = l;
  for (const t of from.tabs) next = moveTab(next, t, toId);
  return setActive(next, toId, from.active);
}

export function setDockShare(l: PaneLayout, side: DockSide, share: number): PaneLayout {
  const next = clone(l);
  next.dockShare[side] = share;
  return next;
}

export function dockedWindow(l: PaneLayout, side: DockSide): PaneWindow | undefined {
  return l.windows.find((w) => w.open && w.placement.kind === "dock" && w.placement.side === side);
}

/** Repairs a stored or hand-edited layout: every available panel in exactly
 *  one window, no empty windows, at most one window per docked side, and
 *  panels this pane cannot host (Preview in a window with no preview) gone. */
export function normalize(l: PaneLayout | null | undefined, panels: readonly PanelKey[] = PANEL_KEYS): PaneLayout {
  const base = defaultLayout(panels);
  if (!l || !Array.isArray(l.windows)) return base;
  const seen = new Set<PanelKey>();
  const windows: PaneWindow[] = [];
  const docked = new Set<DockSide>();
  for (const raw of l.windows) {
    if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.tabs)) continue;
    const tabs: PanelKey[] = [];
    for (const t of raw.tabs) {
      if (!panels.includes(t) || seen.has(t)) continue;
      seen.add(t);
      tabs.push(t);
    }
    if (tabs.length === 0) continue;
    let placement = validPlacement(raw.placement);
    if (placement.kind === "dock") {
      if (docked.has(placement.side)) placement = { kind: "float", rect: null };
      else docked.add(placement.side);
    }
    windows.push({
      id: raw.id,
      tabs,
      active: tabs.includes(raw.active) ? raw.active : tabs[0]!,
      placement,
      open: !!raw.open,
    });
  }
  // A panel added since this layout was saved lands where the default puts it.
  for (const p of panels) {
    if (seen.has(p)) continue;
    const home = base.windows.find((w) => w.tabs.includes(p))!;
    const existing = windows.find((w) => w.id === home.id);
    if (existing) existing.tabs.push(p);
    else windows.push({ ...home, tabs: [p], active: p });
  }
  const share = (n: unknown) => (typeof n === "number" && n > 0 && n < 1 ? n : null);
  return { windows, dockShare: { left: share(l.dockShare?.left), right: share(l.dockShare?.right) } };
}

function validPlacement(p: unknown): Placement {
  const o = p as Placement | null;
  if (o?.kind === "snap" && ["nw", "ne", "sw", "se"].includes(o.corner)) return { kind: "snap", corner: o.corner };
  if (o?.kind === "dock" && (o.side === "left" || o.side === "right")) return { kind: "dock", side: o.side };
  if (o?.kind === "float") {
    const r = o.rect;
    const ok = !!r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n));
    return { kind: "float", rect: ok ? r : null };
  }
  return { kind: "float", rect: null };
}
