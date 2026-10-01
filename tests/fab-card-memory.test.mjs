// @vitest-environment jsdom
//
// Each chat remembers its own open FAB card and where it was parked, so
// switching away and back (or restarting) finds it in the same place.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { recallCard, rememberCard, forgetCard } = await import("../src/views/sessions/fab-card-memory.ts");

describe("fab card memory", () => {
  beforeEach(() => localStorage.clear());

  it("recalls the panel and rect a chat left its card at", () => {
    rememberCard("a", "drafts", { x: 900, y: 20, w: 400, h: 300 });
    expect(recallCard("a")).toMatchObject({ panel: "drafts", rect: { x: 900, y: 20, w: 400, h: 300 } });
    expect(recallCard("b")).toBeNull();
  });

  it("keeps a never-dragged card as centred (null rect)", () => {
    rememberCard("a", "ask", null);
    expect(recallCard("a")?.rect).toBeNull();
  });

  it("recalls a snap zone, and drops an unknown one", () => {
    rememberCard("a", "drafts", { x: 8, y: 8, w: 400, h: 784 }, "w");
    expect(recallCard("a")?.snap).toBe("w");
    localStorage.setItem(
      "cc.fabCard.chats",
      JSON.stringify({ a: { panel: "ask", rect: null, snap: "middle", at: 1 } }),
    );
    expect(recallCard("a")?.snap).toBeNull();
  });

  it("forgets a chat whose card was closed", () => {
    rememberCard("a", "todos", null);
    forgetCard("a");
    expect(recallCard("a")).toBeNull();
  });

  it("ignores a corrupt entry instead of throwing", () => {
    localStorage.setItem("cc.fabCard.chats", JSON.stringify({ a: { panel: "bogus", rect: null, at: 1 } }));
    expect(recallCard("a")).toBeNull();
    localStorage.setItem("cc.fabCard.chats", "{not json");
    expect(recallCard("a")).toBeNull();
  });

  it("drops the oldest chats past the cap", () => {
    const now = vi.spyOn(Date, "now");
    for (let i = 0; i < 61; i++) {
      now.mockReturnValue(1000 + i);
      rememberCard(`s${i}`, "ask", null);
    }
    now.mockRestore();
    expect(recallCard("s0")).toBeNull();
    expect(recallCard("s1")).not.toBeNull();
    expect(recallCard("s60")).not.toBeNull();
  });
});
