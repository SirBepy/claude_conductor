import { describe, expect, it } from "vitest";
import { assignColumns } from "../src/views/sessions/projects-tab/balance.ts";

describe("assignColumns", () => {
  it("puts each section in whichever column is shorter so far, ties to the left", () => {
    // Chats tall, Next up short, Ship medium, Running tiny: Ship joins Next up's
    // column, and Running then goes under Chats only if that column is shorter.
    expect(assignColumns([300, 120, 160, 60], 0)).toEqual([0, 1, 1, 1]);
    expect(assignColumns([100, 100, 100, 100], 0)).toEqual([0, 1, 0, 1]);
  });

  it("counts the gap under every section", () => {
    // Without the gap the third would tie and go left; with it the left column is taller.
    expect(assignColumns([100, 110, 50], 0)).toEqual([0, 1, 0]);
    expect(assignColumns([100, 90, 50], 32)).toEqual([0, 1, 1]);
  });

  it("all-zero heights (nothing measured) keep reading order in the first column", () => {
    expect(assignColumns([0, 0, 0], 0)).toEqual([0, 0, 0]);
  });
});
