// The pane-window layout model: Ask / Todos / Drafts / Preview as tabs in
// windows that float, snap, dock as a split, and trade tabs. Pure data.
import { describe, it, expect } from "vitest";

const L = await import("../src/views/sessions/pane-windows/layout.ts");
const G = await import("../src/views/sessions/pane-windows/geometry.ts");

const tabsOf = (l) => Object.fromEntries(l.windows.map((w) => [w.id, w.tabs]));

describe("layout", () => {
  it("defaults to one window for Ask/Todos/Drafts and Preview docked right on its own", () => {
    const l = L.defaultLayout();
    expect(tabsOf(l)).toEqual({ main: ["ask", "todos", "drafts"], preview: ["preview"] });
    expect(l.windows.find((w) => w.id === "preview").placement).toEqual({ kind: "dock", side: "right" });
    expect(l.windows.every((w) => !w.open)).toBe(true);
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
    expect(l.windows.find((w) => w.id === "main").tabs).toEqual(["ask", "todos"]);
  });

  it("tearing a window's only tab just moves that window", () => {
    const l = L.tearOff(L.defaultLayout(), "preview", { kind: "snap", corner: "se" });
    expect(tabsOf(l).preview).toEqual(["preview"]);
    expect(l.windows.find((w) => w.id === "preview").placement).toEqual({ kind: "snap", corner: "se" });
  });

  it("moves a tab into another window at the aimed spine slot, and drops an emptied window", () => {
    let l = L.moveTab(L.defaultLayout(), "preview", "main", 1);
    expect(tabsOf(l)).toEqual({ main: ["ask", "preview", "todos", "drafts"] });
    expect(l.windows[0].active).toBe("preview");
    l = L.mergeWindows(L.tearOff(L.defaultLayout(), "ask", { kind: "float", rect: null }), "preview", "main");
    expect(tabsOf(l).main).toEqual(["todos", "drafts", "preview"]);
  });

  it("keeps one window per docked side: the old occupant floats out", () => {
    let l = L.tearOff(L.defaultLayout(), "drafts", { kind: "dock", side: "right" });
    expect(L.dockedWindow(L.openPanel(l, "drafts"), "right").tabs).toEqual(["drafts"]);
    expect(l.windows.find((w) => w.id === "preview").placement.kind).toBe("float");
    l = L.place(l, "main", { kind: "dock", side: "left" });
    expect(L.dockedWindow(l, "left").id).toBe("main");
  });

  it("normalize repairs a stored layout: duplicates, unknown panels, two windows on one dock", () => {
    const l = L.normalize({
      windows: [
        { id: "a", tabs: ["ask", "bogus", "ask"], active: "nope", placement: { kind: "dock", side: "left" }, open: true },
        { id: "b", tabs: ["drafts"], active: "drafts", placement: { kind: "dock", side: "left" }, open: false },
      ],
      dockShare: { left: 7, right: 0.3 },
    });
    expect(tabsOf(l)).toEqual({ a: ["ask"], b: ["drafts"], main: ["todos"], preview: ["preview"] });
    expect(l.windows.find((w) => w.id === "a").active).toBe("ask");
    expect(l.windows.find((w) => w.id === "b").placement.kind).toBe("float");
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
