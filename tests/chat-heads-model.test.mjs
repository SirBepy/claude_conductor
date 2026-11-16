// asserts: src/views/sessions/chat-heads-model.ts
// The pure rules of the chat heads: stack order (age, then Joe's hand), the monogram,
// the keyboard walk, the red count and the idle-freeze test.

import { describe, it, expect } from "vitest";
import {
  HEAD_ORDER_KEY,
  dropIndexFor,
  isIdleFrozen,
  monogramHue,
  monogramStyle,
  monogramText,
  orderHeads,
  readHeadOrder,
  reorderStored,
  stepHighlight,
  totalWaiting,
} from "../src/views/sessions/chat-heads-model.ts";

const item = (id, startedAt) => ({ id, startedAt });

describe("orderHeads", () => {
  it("puts the newest chat at the far end", () => {
    const out = orderHeads([item("b", "2026-11-02"), item("c", "2026-11-03"), item("a", "2026-11-01")], []);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps Joe's order for what he placed and puts the rest after it by age", () => {
    const out = orderHeads([item("a", "1"), item("b", "2"), item("c", "3"), item("d", "4")], ["c", "a"]);
    expect(out.map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores ids with no chat and does not repeat one", () => {
    const out = orderHeads([item("a", "1"), item("b", "2")], ["gone", "b", "b"]);
    expect(out.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("never re-sorts on its own: the same input gives the same stack", () => {
    const items = [item("a", "2"), item("b", "1")];
    expect(orderHeads(items, ["a"]).map((i) => i.id)).toEqual(["a", "b"]);
    expect(orderHeads(items, ["a"]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("keeps chats with the same start in their incoming order", () => {
    const out = orderHeads([item("x", ""), item("y", ""), item("z", "")], []);
    expect(out.map((i) => i.id)).toEqual(["x", "y", "z"]);
  });
});

describe("reorderStored", () => {
  it("moves a head to its new place", () => {
    expect(reorderStored(["a", "b", "c"], "c", 0, [])).toEqual(["c", "a", "b"]);
    expect(reorderStored(["a", "b", "c"], "a", 2, [])).toEqual(["b", "c", "a"]);
  });

  it("clamps an out-of-range drop", () => {
    expect(reorderStored(["a", "b"], "a", 99, [])).toEqual(["b", "a"]);
    expect(reorderStored(["a", "b"], "b", -4, [])).toEqual(["b", "a"]);
  });

  it("keeps chats that are not on screen where they were, at the end", () => {
    expect(reorderStored(["a", "b"], "b", 0, ["h1", "a", "h2"])).toEqual(["b", "a", "h1", "h2"]);
  });
});

describe("readHeadOrder", () => {
  it("reads the settings key and drops anything that is not an id", () => {
    expect(readHeadOrder({ [HEAD_ORDER_KEY]: ["a", 3, "", "b", null] })).toEqual(["a", "b"]);
    expect(readHeadOrder({})).toEqual([]);
    expect(readHeadOrder({ [HEAD_ORDER_KEY]: "nope" })).toEqual([]);
  });
});

describe("monogram", () => {
  it("takes the initials of the first two words", () => {
    expect(monogramText("claude usage in taskbar")).toBe("CU");
    expect(monogramText("my-cool_app")).toBe("MC");
  });

  it("takes the first two letters of a one-word name", () => {
    expect(monogramText("rodge")).toBe("RO");
    expect(monogramText("x")).toBe("X");
  });

  it("falls back to a question mark when the name has no letters", () => {
    expect(monogramText("---")).toBe("?");
    expect(monogramText("")).toBe("?");
  });

  it("gives the same path the same colour and different paths different ones", () => {
    expect(monogramHue("C:/a/proj")).toBe(monogramHue("C:/a/proj"));
    expect(monogramHue("C:/a/proj")).not.toBe(monogramHue("C:/a/other"));
    expect(monogramStyle("C:/a/proj")).toMatch(/^background:hsl\(\d+ 48% 34%\);color:#fff$/);
  });
});

describe("stepHighlight", () => {
  it("walks down and wraps from the last head to the first", () => {
    expect(stepHighlight(-1, 1, 3)).toBe(0);
    expect(stepHighlight(0, 1, 3)).toBe(1);
    expect(stepHighlight(2, 1, 3)).toBe(0);
  });

  it("walks up and wraps from the first head to the last", () => {
    expect(stepHighlight(-1, -1, 3)).toBe(2);
    expect(stepHighlight(0, -1, 3)).toBe(2);
    expect(stepHighlight(2, -1, 3)).toBe(1);
  });

  it("has nothing to highlight with no heads", () => {
    expect(stepHighlight(0, 1, 0)).toBe(-1);
  });
});

describe("totalWaiting", () => {
  it("adds the red counts and ignores negatives", () => {
    expect(totalWaiting([1, 0, 3, -2])).toBe(4);
    expect(totalWaiting([])).toBe(0);
  });
});

describe("isIdleFrozen", () => {
  const NOW = 1_800_000_000_000;
  it("is a freeze with no usage limit behind it", () => {
    expect(isIdleFrozen({ frozen: true, auto_frozen: true }, NOW)).toBe(true);
    expect(isIdleFrozen({ frozen: true, auto_frozen: true, rate_limited_resets_at: null }, NOW)).toBe(true);
  });

  it("is not a limit freeze that has not reset yet", () => {
    expect(isIdleFrozen({ frozen: true, auto_frozen: true, rate_limited_resets_at: NOW / 1000 + 600 }, NOW)).toBe(false);
  });

  it("reads a reset time in the past as history", () => {
    expect(isIdleFrozen({ frozen: true, auto_frozen: true, rate_limited_resets_at: NOW / 1000 - 60 }, NOW)).toBe(true);
  });

  it("is not a chat that is live or was frozen by hand", () => {
    expect(isIdleFrozen({ frozen: false, auto_frozen: true }, NOW)).toBe(false);
    expect(isIdleFrozen({ frozen: true, auto_frozen: false }, NOW)).toBe(false);
  });
});

describe("dropIndexFor", () => {
  // One column of three heads, 52px apart.
  const col = [{ id: "a", cx: 30, cy: 30 }, { id: "b", cx: 30, cy: 82 }, { id: "c", cx: 30, cy: 134 }];

  it("drops before the head the pointer is above and after the one it is below", () => {
    expect(dropIndexFor(col, 30, 20)).toBe(0);
    expect(dropIndexFor(col, 30, 40)).toBe(1);
    expect(dropIndexFor(col, 30, 140)).toBe(3);
  });

  it("goes by column first once the pointer is in another column", () => {
    const wrapped = [...col, { id: "d", cx: 82, cy: 30 }];
    // In the second column, above its first head: before it; below it: after it.
    expect(dropIndexFor(wrapped, 82, 10)).toBe(3);
    expect(dropIndexFor(wrapped, 82, 60)).toBe(4);
    // Left of the second column's head, beside the first column: after the first column's last.
    expect(dropIndexFor(wrapped, 40, 150)).toBe(3);
  });

  it("an empty stack takes the head at 0", () => {
    expect(dropIndexFor([], 5, 5)).toBe(0);
  });
});
