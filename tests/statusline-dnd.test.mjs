// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { insertChip, moveChip, removeAt, addRow, trimRows } from "../src/views/settings/subviews/statusline/statusline-dnd.ts";

// Mock Tauri invoke so renderStatuslineView can load/save settings in jsdom.
const ipcMock = { impl: async (cmd) => (cmd === "get_settings" ? {} : null) };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));
// This DOM suite exercises the desktop drag-and-drop path specifically
// (todo 1023 made the builder read-only on the phone) - isRemote() defaults
// to true in jsdom (no window.__TAURI__), so it must be pinned to desktop here.
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
const { renderStatuslineView } = await import("../src/views/settings/subviews/statusline/statusline.ts");

describe("statusline dnd model ops", () => {
  it("inserts a palette chip at a position (dupes allowed)", () => {
    const r = insertChip([["model"]], { row: 0, index: 1 }, "model");
    expect(r).toEqual([["model", "model"]]);
  });
  it("moves a chip across rows", () => {
    const r = moveChip([["model", "branch"], ["turns"]], { row: 0, index: 1 }, { row: 1, index: 0 });
    expect(r).toEqual([["model"], ["branch", "turns"]]);
  });
  it("removes a chip (drag-out)", () => {
    expect(removeAt([["model", "branch"]], { row: 0, index: 0 })).toEqual([["branch"]]);
  });
  it("addRow respects the 5-row cap", () => {
    const five = [["model"], ["model"], ["model"], ["model"], ["model"]];
    expect(addRow(five)).toEqual(five); // no-op at cap
    expect(addRow([["model"]]).length).toBe(2);
  });
  it("trimRows drops empty rows but keeps at least one", () => {
    expect(trimRows([["model"], [], ["branch"]])).toEqual([["model"], ["branch"]]);
    expect(trimRows([[], []])).toEqual([[]]);
  });
  it("moving within the same row to a later index lands correctly", () => {
    const r = moveChip([["a", "b", "c"]], { row: 0, index: 0 }, { row: 0, index: 2 });
    expect(r).toEqual([["b", "a", "c"]]);
  });
});

describe("builder view - drag-out remove (DOM)", () => {
  it("dragging a placed chip out of the bar removes it", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await renderStatuslineView(host);

    const bar = host.querySelector("#slBar");
    const before = bar.querySelectorAll(".sl-placed").length;
    expect(before).toBeGreaterThan(0);

    const chip = bar.querySelector(".sl-placed");
    // jsdom elementFromPoint always returns null => pointerup is "outside any
    // row" => the drag-out remove path fires.
    chip.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: -50, clientY: -50, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: -50, clientY: -50, bubbles: true }));

    expect(bar.querySelectorAll(".sl-placed").length).toBe(before - 1);
  });
});
