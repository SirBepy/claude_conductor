import { describe, it, expect } from "vitest";
import { insertChip, moveChip, removeAt, addRow, trimRows, moveRow, removeRow } from "../src/views/sessions/statusline-dnd.ts";

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
  it("moveRow swaps a row with its neighbour", () => {
    expect(moveRow([["a"], ["b"]], 0, 1)).toEqual([["b"], ["a"]]);
  });
  it("removeRow drops a row but never the last one", () => {
    expect(removeRow([["a"], ["b"]], 0)).toEqual([["b"]]);
    expect(removeRow([["a"]], 0)).toEqual([[]]);
  });
});
