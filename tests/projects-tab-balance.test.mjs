import { describe, expect, it } from "vitest";
import { assignColumns } from "../src/views/sessions/projects-tab/balance.ts";

describe("assignColumns", () => {
  it("puts each section in whichever column is shorter so far, ties to the left", () => {
    // Next up tall, Ship short, then two medium custom cards: both cards join
    // Ship's column while it stays the shorter one.
    expect(assignColumns([300, 120, 160, 60])).toEqual([0, 1, 1, 1]);
    expect(assignColumns([100, 100, 100, 100])).toEqual([0, 1, 0, 1]);
  });

  it("adds each section's height to its column, so one tall section can hold a column", () => {
    expect(assignColumns([100, 110, 50])).toEqual([0, 1, 0]);
    expect(assignColumns([400, 100, 100, 100])).toEqual([0, 1, 1, 1]);
  });

  it("all-zero heights (nothing measured) keep reading order in the first column", () => {
    expect(assignColumns([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
