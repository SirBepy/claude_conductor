// @vitest-environment jsdom
// An emptied statusline layout (Clear all, or the last chip removed) is a
// deliberate choice: the live bar shows nothing, and a reload must agree
// instead of bringing the default chips back.
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
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/shared/mobile-viewport.ts", () => ({
  MOBILE_MQ: "(max-width: 768px)",
  isMobileViewport: () => false,
  onMobileViewportChange: () => () => {},
}));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: vi.fn(async () => true) }));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { loadStatuslineRows, profileDefaultRows } = await import("../src/views/sessions/session-statusbar-helpers.ts");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

async function enterEdit(rows) {
  store.settings = { statuslineRows: rows.map((r) => [...r]) };
  const el = document.createElement("div");
  document.body.appendChild(el);
  new SessionStatusbar(el, null, rows.map((r) => [...r]), { sessionId: "s1", hideZero: true, layoutEditable: true });
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 5));
  return el;
}

beforeEach(() => {
  store.settings = {};
  store.saves = [];
  document.body.innerHTML = "";
});

describe("an emptied statusline layout", () => {
  it("Clear all reloads as empty, matching the live bar", async () => {
    const el = await enterEdit([["clock", "duration"]]);
    click(el.querySelector('[data-act="palette"]'));
    click(document.querySelector('.sb-edit-palette [data-act="clear"]'));
    await flush();
    expect(el.querySelectorAll(".sb-edit-chip").length).toBe(0);
    click(el.querySelector('[data-act="done"]'));
    await flush();
    expect(el.querySelector(".sb-chip")).toBeNull(); // live bar: nothing
    const reloaded = await loadStatuslineRows("desktop");
    expect(reloaded.flat()).toEqual([]);
  });

  it("removing the last chip with x reloads as empty", async () => {
    const el = await enterEdit([["clock"]]);
    click(el.querySelector(".sb-edit-x"));
    await flush();
    expect((await loadStatuslineRows("desktop")).flat()).toEqual([]);
  });

  it("an empty bar keeps a right-clickable element to re-enter edit mode", async () => {
    const el = await enterEdit([["clock"]]);
    click(el.querySelector(".sb-edit-x"));
    await flush();
    click(el.querySelector('[data-act="done"]'));
    await flush();
    expect(el.querySelector(".sb-empty")).not.toBeNull();
    el.querySelector(".sb-empty").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(el.classList.contains("sb-editing")).toBe(true);
  });

  it("a never-saved layout still falls back to the defaults", async () => {
    store.settings = {};
    expect(await loadStatuslineRows("desktop")).toEqual(profileDefaultRows("desktop"));
  });

  it("a layout of only unknown chips still falls back to the defaults", async () => {
    store.settings = { statuslineRows: [["no_such_chip"]] };
    expect(await loadStatuslineRows("desktop")).toEqual(profileDefaultRows("desktop"));
  });
});
