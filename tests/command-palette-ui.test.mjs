// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Ctrl+Shift+P opens one search box over every action. The overlay takes its
// sources as arguments, so these tests drive it without the Chats view.
Element.prototype.scrollIntoView ??= () => {};
const toast = vi.fn();
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toast(...a) }));

const { openPalette, closePalette, isPaletteOpen } = await import("../src/views/command-palette/palette-ui.ts");
const { findConflict } = await import("../src/shared/shortcuts.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (k, opts = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};
const input = () => document.querySelector(".cp-input");
const type = (text) => {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};
const titles = () => [...document.querySelectorAll(".cp-row .cp-title")].map((e) => e.textContent);
const cmd = (id, title, extra = {}) => ({ id, title, group: "Test", icon: "gear", run: () => {}, ...extra });

const store = new Map();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  document.body.innerHTML = "";
  toast.mockReset();
});

afterEach(() => {
  if (isPaletteOpen()) closePalette();
});

describe("Ctrl+Shift+P", () => {
  it("is bound to the command palette and collides with nothing else", () => {
    expect(findConflict("ctrl+shift+p")?.id).toBe("command-palette");
  });

  it("closes the palette when pressed again", () => {
    openPalette({ sync: () => [cmd("a", "Alpha")], later: [] });
    expect(isPaletteOpen()).toBe(true);
    key("P", { ctrlKey: true, shiftKey: true });
    expect(isPaletteOpen()).toBe(false);
    expect(document.querySelector(".cp-overlay")).toBeNull();
  });
});

describe("palette overlay", () => {
  it("filters as you type and runs the top row on Enter, closing first", async () => {
    const run = vi.fn(() => { expect(isPaletteOpen()).toBe(false); });
    openPalette({ sync: () => [cmd("a", "Alpha"), cmd("b", "Beta", { run })], later: [] });
    expect(titles()).toEqual(["Alpha", "Beta"]);
    type("bet");
    expect(titles()).toEqual(["Beta"]);
    key("Enter");
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(isPaletteOpen()).toBe(false);
  });

  it("moves the selection with the arrows and wraps", async () => {
    const second = vi.fn();
    openPalette({ sync: () => [cmd("a", "Alpha"), cmd("b", "Beta", { run: second })], later: [] });
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(second).toHaveBeenCalledOnce();
  });

  it("closes on Escape and runs nothing", () => {
    const run = vi.fn();
    openPalette({ sync: () => [cmd("a", "Alpha", { run })], later: [] });
    key("Escape");
    expect(isPaletteOpen()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("remembers what ran and lists it first, under Recent, next time", async () => {
    const rows = () => [cmd("a", "Alpha"), cmd("b", "Beta"), cmd("c", "Gamma")];
    openPalette({ sync: rows, later: [] });
    type("gam");
    key("Enter");
    await flush();
    openPalette({ sync: rows, later: [] });
    expect(titles()).toEqual(["Gamma", "Alpha", "Beta"]);
    expect([...document.querySelectorAll(".cp-section")].map((e) => e.textContent)).toEqual(["Recent", "All commands"]);
  });

  it("shows a row that cannot run greyed with its reason, and Enter on it does nothing", async () => {
    const run = vi.fn();
    openPalette({ sync: () => [cmd("d", "Deploy", { run: undefined, disabledReason: "No workflow" })], later: [] });
    const row = document.querySelector(".cp-row");
    expect(row.classList.contains("disabled")).toBe(true);
    expect(row.textContent).toContain("No workflow");
    key("Enter");
    await flush();
    expect(isPaletteOpen()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("draws a binding as keycaps", () => {
    openPalette({ sync: () => [cmd("a", "Alpha", { keys: "ctrl+shift+d" })], later: [] });
    expect([...document.querySelectorAll(".cp-key")].map((e) => e.textContent)).toEqual(["Ctrl", "Shift", "D"]);
  });

  it("adds a slow source's rows when they land and survives one that fails", async () => {
    let resolveLater;
    const later = new Promise((r) => { resolveLater = r; });
    openPalette({
      sync: () => [cmd("a", "Alpha")],
      later: [() => later, () => Promise.reject(new Error("offline"))],
    });
    expect(titles()).toEqual(["Alpha"]);
    resolveLater([cmd("p", "New chat in proj")]);
    await flush();
    expect(titles()).toEqual(["Alpha", "New chat in proj"]);
  });

  it("toasts a failing command instead of swallowing it", async () => {
    openPalette({ sync: () => [cmd("a", "Alpha", { run: () => { throw new Error("boom"); } })], later: [] });
    key("Enter");
    await flush();
    expect(toast).toHaveBeenCalledWith("Alpha failed: boom");
  });
});

describe("second-step picks", () => {
  const branches = () => [
    cmd("b1", "main", { run: vi.fn() }),
    cmd("b2", "feature/x", { run: vi.fn() }),
  ];
  const withStage = (load) => [cmd("sw", "Switch branch", { run: undefined, stage: { placeholder: "Pick a branch", load } })];

  it("swaps the list for the stage's rows, Backspace on an empty box goes back", async () => {
    openPalette({ sync: () => withStage(async () => branches()), later: [] });
    key("Enter");
    await flush();
    expect(titles()).toEqual(["main", "feature/x"]);
    expect(input().placeholder).toBe("Pick a branch");
    key("Backspace");
    expect(titles()).toEqual(["Switch branch"]);
  });

  it("runs the picked stage row and closes", async () => {
    const rows = branches();
    openPalette({ sync: () => withStage(async () => rows), later: [] });
    key("Enter");
    await flush();
    type("feat");
    key("Enter");
    await flush();
    expect(rows[1].run).toHaveBeenCalledOnce();
    expect(isPaletteOpen()).toBe(false);
  });

  it("keeps the palette open and shows the error when the pick fails", async () => {
    const rows = [cmd("b", "main", { run: () => { throw new Error("local changes would be overwritten"); } })];
    openPalette({ sync: () => withStage(async () => rows), later: [] });
    key("Enter");
    await flush();
    key("Enter");
    await flush();
    expect(isPaletteOpen()).toBe(true);
    expect(document.querySelector(".cp-error").textContent).toBe("local changes would be overwritten");
  });

  it("does not file a stage pick under recents", async () => {
    openPalette({ sync: () => withStage(async () => branches()), later: [] });
    key("Enter");
    await flush();
    key("Enter");
    await flush();
    expect(JSON.parse(store.get("cc_palette_recents"))).toEqual(["sw"]);
  });

  it("says so when the stage cannot load", async () => {
    openPalette({ sync: () => withStage(async () => { throw new Error("no repo"); }), later: [] });
    key("Enter");
    await flush();
    expect(document.querySelector(".cp-empty").textContent).toContain("no repo");
  });
});
