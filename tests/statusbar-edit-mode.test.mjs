// @vitest-environment jsdom
// In-place statusline editing: right-click / chat menu enters it, the real bar
// shows editable chips, every change saves through updateSettings, and none of
// it exists on the phone (updateSettings is refused there).
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { settings: {}, saves: [] };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    if (cmd === "get_settings") return JSON.parse(JSON.stringify(store.settings));
    if (cmd === "save_settings") {
      store.settings = JSON.parse(JSON.stringify(args.updated));
      store.saves.push(store.settings);
      return null;
    }
    return null;
  }),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));
vi.mock("../src/shared/mobile-viewport.ts", () => ({
  MOBILE_MQ: "(max-width: 768px)",
  isMobileViewport: () => false,
  onMobileViewportChange: () => () => {},
}));
const confirmMock = { answer: true };
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: vi.fn(async () => confirmMock.answer) }));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");

// clock renders with no async data; separator is always a placeholder chip.
const ROWS = [["clock", "separator", "duration"]];

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const flushOutsideListener = () => new Promise((r) => setTimeout(r, 5));

async function mount(opts = {}) {
  // The editor loads the SAVED layout (what the bar was mounted from in the app).
  store.settings = { statuslineRows: ROWS.map((r) => [...r]), ...store.settings };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, "2026-01-01T00:00:00Z", ROWS.map((r) => [...r]), {
    sessionId: "s1", hideZero: true, layoutEditable: true, ...opts,
  });
  return { el, sb };
}

async function enterByRightClick(el) {
  el.querySelector(".sb-chip").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await flush();
  await flushOutsideListener();
}

const lastRows = (key = "statuslineRows") => store.saves.at(-1)?.[key];
const palette = () => document.querySelector(".sb-edit-palette");

beforeEach(() => {
  store.settings = {};
  store.saves = [];
  remote = false;
  confirmMock.answer = true;
  document.body.innerHTML = "";
});

describe("statusbar in-place layout edit", () => {
  it("right-click on the bar enters edit mode and shows x buttons", async () => {
    const { el } = await mount();
    expect(el.classList.contains("sb-editing")).toBe(false);
    await enterByRightClick(el);
    expect(el.classList.contains("sb-editing")).toBe(true);
    expect(el.querySelectorAll(".sb-edit-x").length).toBe(3);
  });

  it("right-click on an input is left to the browser", async () => {
    const { el } = await mount();
    const input = document.createElement("input");
    el.appendChild(input);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    expect(el.classList.contains("sb-editing")).toBe(false);
  });

  it("Esc leaves edit mode", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(el.classList.contains("sb-editing")).toBe(false);
    expect(el.querySelector(".sb-edit-x")).toBeNull();
  });

  it("Done leaves edit mode", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('[data-act="done"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.classList.contains("sb-editing")).toBe(false);
  });

  it("a click outside the bar and palette leaves edit mode; inside does not", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector(".sb-edit-chip").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.classList.contains("sb-editing")).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.classList.contains("sb-editing")).toBe(false);
  });

  it("x removes the chip and saves the layout", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('.sb-edit-chip[data-type="separator"] .sb-edit-x').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastRows()).toEqual([["clock", "duration"]]);
    expect(el.querySelectorAll(".sb-edit-chip").length).toBe(2);
  });

  it("adding from the palette saves and the chip leaves the palette", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('[data-act="palette"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(palette()).not.toBeNull();
    expect(palette().querySelector('.sb-edit-source[data-type="clock"]')).toBeNull(); // already placed
    palette().querySelector('.sb-edit-source[data-type="turns"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastRows()).toEqual([["clock", "separator", "duration", "turns"]]);
    // Palette stays open across the repaint and no longer lists it.
    expect(palette()).not.toBeNull();
    expect(palette().querySelector('.sb-edit-source[data-type="turns"]')).toBeNull();
  });

  it("Desktop/Mobile switch edits the other profile's key", async () => {
    store.settings = { statuslineRowsMobile: [["git"]] };
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('[data-act="palette"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    palette().querySelector('[data-profile="mobile"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    // The bar now shows the mobile layout, not the desktop one.
    expect([...el.querySelectorAll(".sb-edit-chip")].map((c) => c.dataset.type)).toEqual(["git"]);
    palette().querySelector('.sb-edit-source[data-type="turns"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(store.settings.statuslineRowsMobile).toEqual([["git", "turns"]]);
    expect(store.settings.statuslineRows).toEqual(ROWS); // desktop untouched
  });

  it("hide-zero checkbox saves statuslineHideZero", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('[data-act="palette"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const box = palette().querySelector('[data-act="hidezero"]');
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(store.settings.statuslineHideZero).toBe(false);
  });

  it("Reset restores the default rows", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    el.querySelector('[data-act="palette"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    palette().querySelector('[data-act="reset"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastRows()).toEqual([["git", "context_pct", "ai_todos", "overflow"]]);
  });

  it("dragging a placed chip out of the bar removes it", async () => {
    const { el } = await mount();
    await enterByRightClick(el);
    const chip = el.querySelector('.sb-edit-chip[data-type="duration"]');
    // jsdom's elementFromPoint is absent => "not over a row" => drag-out path.
    chip.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: -50, clientY: -50, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: -50, clientY: -50, bubbles: true }));
    await flush();
    expect(lastRows()).toEqual([["clock", "separator"]]);
  });

  it("a chip click opens no popover while editing", async () => {
    const rows = [["overflow", "git"]];
    store.settings = { statuslineRows: rows };
    const el = document.createElement("div");
    document.body.appendChild(el);
    const sb = new SessionStatusbar(el, null, rows, { sessionId: "s1", hideZero: true, layoutEditable: true });
    sb.updateGitInfo({ branch: "main", repo: "r", ahead: 1, behind: 0, sha: "abc", insertions: null, deletions: null });
    // Control: outside edit mode the overflow chip opens its panel.
    el.querySelector(".sb-overflow-btn").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelectorAll(".sb-popover").length).toBeGreaterThan(0);
    document.querySelectorAll(".sb-popover").forEach((p) => p.remove());

    await enterByRightClick(el);
    expect(document.querySelectorAll(".sb-popover:not(.sb-edit-palette)").length).toBe(0);
    for (const sel of [".sb-overflow-btn", ".sb-git-btn"]) {
      el.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(document.querySelectorAll(".sb-popover").length).toBe(0);
  });

  it("a chip with nothing to show is dimmed, not dropped", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // No git info loaded and the branch is unknown: the live bar prints nothing.
    store.settings = { statuslineRows: [["thinking"]] };
    new SessionStatusbar(el, null, [["thinking"]], { sessionId: "s1", hideZero: true, layoutEditable: true });
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(el.querySelector(".sb-edit-chip.sb-edit-dim")).not.toBeNull();
  });

  it("menu entry point enters edit mode via beginLayoutEdit", async () => {
    const { el, sb } = await mount();
    sb.beginLayoutEdit();
    await flush();
    expect(el.classList.contains("sb-editing")).toBe(true);
  });
});

describe("entry points are hidden on the phone", () => {
  it("right-click does nothing when isRemote()", async () => {
    remote = true;
    const { el } = await mount();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.querySelector(".sb-chip").dispatchEvent(ev);
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    expect(el.classList.contains("sb-editing")).toBe(false);
  });

  it("beginLayoutEdit is a no-op when isRemote()", async () => {
    remote = true;
    const { el, sb } = await mount();
    expect(sb.canEditLayout()).toBe(false);
    sb.beginLayoutEdit();
    await flush();
    expect(el.classList.contains("sb-editing")).toBe(false);
  });

  it("a bar not marked layoutEditable (history viewer) never edits", async () => {
    const { el, sb } = await mount({ layoutEditable: false });
    expect(sb.canEditLayout()).toBe(false);
    el.querySelector(".sb-chip").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(el.classList.contains("sb-editing")).toBe(false);
  });
});
