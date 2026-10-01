// The pane-window layout model: Ask / Todos / Drafts / Preview as tabs in
// windows that float, snap, dock as a split, and trade tabs. Pure data.
import { describe, it, expect } from "vitest";

const L = await import("../src/views/sessions/pane-windows/layout.ts");
const G = await import("../src/views/sessions/pane-windows/geometry.ts");

const tabsOf = (l) => Object.fromEntries(l.windows.map((w) => [w.id, w.tabs]));

describe("layout", () => {
  it("defaults to one closed floating window holding all four panels as tabs", () => {
    const l = L.defaultLayout();
    expect(tabsOf(l)).toEqual({ main: ["ask", "todos", "drafts", "preview"] });
    expect(l.windows[0].placement).toEqual({ kind: "float", rect: null });
    expect(l.windows[0].open).toBe(false);
  });

  it("opening a panel opens its window on that tab, in front", () => {
    const l = L.openPanel(L.defaultLayout(), "todos");
    const main = l.windows.at(-1);
    expect(main.id).toBe("main");
    expect(main.open).toBe(true);
    expect(main.active).toBe("todos");
  });

  it("tears a tab out into its own window, leaving the rest behind", () => {
    const l = L.tearOff(L.defaultLayout(), "drafts", { kind: "float", rect: null });
    const torn = l.windows.at(-1);
    expect(torn.tabs).toEqual(["drafts"]);
    expect(torn.open).toBe(true);
    expect(l.windows.find((w) => w.id === "main").tabs).toEqual(["ask", "todos", "preview"]);
  });

  it("tearing a window's only tab just moves that window", () => {
    const torn = L.tearOff(L.defaultLayout(), "preview", { kind: "float", rect: null });
    const id = torn.windows.at(-1).id;
    const l = L.tearOff(torn, "preview", { kind: "snap", corner: "se" });
    expect(l.windows.find((w) => w.id === id).placement).toEqual({ kind: "snap", corner: "se" });
    expect(l.windows).toHaveLength(2);
  });

  it("moves a tab into another window at the aimed tab slot, and drops an emptied window", () => {
    const torn = L.tearOff(L.defaultLayout(), "preview", { kind: "float", rect: null });
    const pv = torn.windows.at(-1).id;
    let l = L.moveTab(torn, "preview", "main", 1);
    expect(tabsOf(l)).toEqual({ main: ["ask", "preview", "todos", "drafts"] });
    expect(l.windows[0].active).toBe("preview");
    l = L.mergeWindows(L.tearOff(torn, "ask", { kind: "float", rect: null }), pv, "main");
    expect(tabsOf(l).main).toEqual(["todos", "drafts", "preview"]);
  });

  it("a drop on a side's edge takes the whole side: the old occupants float out", () => {
    let l = L.tearOff(L.defaultLayout(), "preview", { kind: "dock", side: "right" });
    const pv = l.windows.at(-1).id;
    l = L.tearOff(l, "drafts", { kind: "dock", side: "right" });
    expect(L.dockStack(L.openPanel(l, "drafts"), "right").map((w) => w.tabs)).toEqual([["drafts"]]);
    expect(l.windows.find((w) => w.id === pv).placement.kind).toBe("float");
    l = L.place(l, "main", { kind: "dock", side: "left" });
    expect(L.dockStack(l, "left")[0].id).toBe("main");
  });

  it("stacks a window above or below a docked one, splitting that one's height", () => {
    // Joe's flow: Preview torn out and docked right, the other three stacked under it.
    let l = L.tearOff(L.defaultLayout(), "preview", { kind: "dock", side: "right" });
    const pv = l.windows.at(-1).id;
    l = L.stackInto(l, "main", pv, "after");
    const stack = L.dockStack(l, "right");
    expect(stack.map((w) => w.id)).toEqual([pv, "main"]);
    expect(stack.map(L.weightOf)).toEqual([0.5, 0.5]);

    const torn = L.tearOff(l, "drafts", { kind: "float", rect: null });
    const dr = torn.windows.at(-1).id;
    l = L.stackInto(torn, dr, pv, "before");
    expect(L.dockStack(l, "right").map((w) => w.id)).toEqual([dr, pv, "main"]);
    expect(L.dockStack(l, "right").map(L.weightOf)).toEqual([0.25, 0.25, 0.5]);
    expect(L.dockStack(l, "right").map((w) => w.placement.slot)).toEqual([0, 1, 2]);
  });

  it("stacking a window onto itself changes nothing", () => {
    const l = L.place(L.defaultLayout(), "main", { kind: "dock", side: "left" });
    expect(L.stackInto(l, "main", "main", "before")).toBe(l);
  });

  it("appends a window to the bottom of a stack at an equal share", () => {
    let l = L.tearOff(L.defaultLayout(), "preview", { kind: "dock", side: "right" });
    const pv = l.windows.at(-1).id;
    l = L.appendDock(l, "main", "right");
    expect(L.dockStack(l, "right").map((w) => w.id)).toEqual([pv, "main"]);
    expect(L.weightOf(L.dockStack(l, "right")[1])).toBe(1);
  });

  it("a closed window leaves its stack's open list, and returns to its slot when reopened", () => {
    let l = L.tearOff(L.defaultLayout(), "preview", { kind: "dock", side: "right" });
    const pv = l.windows.at(-1).id;
    l = L.stackInto(l, "main", pv, "after");
    l = L.closeWindow(l, pv);
    expect(L.dockStack(l, "right").map((w) => w.id)).toEqual(["main"]);
    l = L.openPanel(l, "preview");
    expect(L.dockStack(l, "right").map((w) => w.id)).toEqual([pv, "main"]);
  });

  it("setWeights trades height between docked windows only", () => {
    let l = L.tearOff(L.defaultLayout(), "preview", { kind: "dock", side: "right" });
    const pv = l.windows.at(-1).id;
    l = L.stackInto(l, "main", pv, "after");
    l = L.setWeights(l, { [pv]: 0.7, main: 0.3, nope: 5 });
    expect(L.dockStack(l, "right").map(L.weightOf)).toEqual([0.7, 0.3]);
  });

  it("keeps a stored layout from the old default, Preview docked on its own", () => {
    const l = L.normalize({
      windows: [
        { id: "main", tabs: ["ask", "todos", "drafts"], active: "ask", placement: { kind: "float", rect: null }, open: false },
        { id: "preview", tabs: ["preview"], active: "preview", placement: { kind: "dock", side: "right" }, open: true },
      ],
      dockShare: { left: null, right: null },
    });
    expect(tabsOf(l)).toEqual({ main: ["ask", "todos", "drafts"], preview: ["preview"] });
    expect(L.dockStack(l, "right")[0].id).toBe("preview");
  });

  it("normalize repairs a stored layout: duplicates, unknown panels, a stack's slots and weights", () => {
    const l = L.normalize({
      windows: [
        { id: "a", tabs: ["ask", "bogus", "ask"], active: "nope", placement: { kind: "dock", side: "left", slot: 9, weight: -2 }, open: true },
        { id: "b", tabs: ["drafts"], active: "drafts", placement: { kind: "dock", side: "left", slot: 3, weight: 0.4 }, open: false },
      ],
      dockShare: { left: 7, right: 0.3 },
    });
    expect(tabsOf(l)).toEqual({ a: ["ask"], b: ["drafts"], main: ["todos", "preview"] });
    expect(l.windows.find((w) => w.id === "a").active).toBe("ask");
    expect(l.windows.find((w) => w.id === "a").placement).toEqual({ kind: "dock", side: "left", slot: 1, weight: 1 });
    expect(l.windows.find((w) => w.id === "b").placement).toEqual({ kind: "dock", side: "left", slot: 0, weight: 0.4 });
    expect(l.dockShare).toEqual({ left: null, right: 0.3 });
  });

  it("drops Preview where the pane cannot host it", () => {
    const l = L.normalize(null, ["ask", "todos", "drafts"]);
    expect(tabsOf(l)).toEqual({ main: ["ask", "todos", "drafts"] });
  });
});

describe("geometry", () => {
  const PANE = { w: 1200, h: 800 };

  it("arms corners near either edge, docks mid-edge, nothing mid-top", () => {
    expect(G.dropZoneAt(1195, 790, PANE)).toEqual({ kind: "snap", corner: "se" });
    expect(G.dropZoneAt(1100, 795, PANE)).toEqual({ kind: "snap", corner: "se" });
    expect(G.dropZoneAt(4, 400, PANE)).toEqual({ kind: "dock", side: "left" });
    expect(G.dropZoneAt(-40, 400, PANE)).toEqual({ kind: "dock", side: "left" });
    expect(G.dropZoneAt(1199, 400, PANE)).toEqual({ kind: "dock", side: "right" });
    expect(G.dropZoneAt(600, 4, PANE)).toBeNull();
    expect(G.dropZoneAt(600, 400, PANE)).toBeNull();
  });

  it("gives docks 40% by default and never squeezes the chat under its floor", () => {
    expect(G.dockWidths(1200, { left: false, right: true }, { left: null, right: null })).toEqual({ left: 0, right: 480 });
    const both = G.dockWidths(1200, { left: true, right: true }, { left: null, right: null });
    expect(1200 - both.left - both.right).toBeGreaterThanOrEqual(G.MIN_CHAT);
    expect(both.left).toBe(both.right);
  });

  it("stacks a side's windows by weight, edge to edge", () => {
    const rects = G.stackRects("right", 400, PANE, [1, 1, 2]);
    expect(rects.map((r) => [r.x, r.y, r.h])).toEqual([[800, 0, 200], [800, 200, 200], [800, 400, 400]]);
    expect(G.stackRects("left", 400, PANE, [1])[0]).toEqual({ x: 0, y: 0, w: 400, h: 800 });
  });

  it("keeps a dragged dock share", () => {
    expect(G.dockWidths(1000, { left: true, right: false }, { left: 0.5, right: null }).left).toBe(500);
  });

  it("resizes from the top-left with the opposite corner pinned, and clamps to the pane", () => {
    const start = { x: 300, y: 150, w: 600, h: 500 };
    expect(G.resizeRect(start, "nw", -100, -50, PANE)).toEqual({ x: 200, y: 100, w: 700, h: 550 });
    expect(G.resizeRect(start, "se", 5000, 5000, PANE)).toEqual({ x: 300, y: 150, w: 892, h: 642 });
    expect(G.clampRect({ x: -500, y: 5000, w: 600, h: 500 }, PANE)).toEqual({ x: 8, y: 292, w: 600, h: 500 });
  });
});
