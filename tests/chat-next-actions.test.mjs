// asserts: src/shared/chat/chat-next-actions.ts
import { describe, expect, it } from "vitest";

const { parseNextActions, currentTurnNextActions } = await import("../src/shared/chat/chat-next-actions.ts");

describe("parseNextActions", () => {
  it("returns undefined when the field is absent or not a list", () => {
    expect(parseNextActions({ text: "hi" })).toBeUndefined();
    expect(parseNextActions({ next_actions: "/commit" })).toBeUndefined();
    expect(parseNextActions(null)).toBeUndefined();
  });

  it("keeps clean entries in order", () => {
    expect(parseNextActions({ next_actions: ["Yes, implement this", "/commit"] })).toEqual(["Yes, implement this", "/commit"]);
  });

  it("trims, and drops empty, non-string and over-long entries", () => {
    expect(parseNextActions({ next_actions: ["  /commit  ", "", "   ", 7, null, "x".repeat(61), "y".repeat(60)] }))
      .toEqual(["/commit", "y".repeat(60)]);
  });

  it("dedupes case-insensitively and caps at 3", () => {
    expect(parseNextActions({ next_actions: ["Go", "go", "A", "B", "C", "D"] })).toEqual(["Go", "A", "B"]);
  });

  it("returns undefined when nothing survives", () => {
    expect(parseNextActions({ next_actions: ["", 3] })).toBeUndefined();
  });
});

describe("currentTurnNextActions", () => {
  const user = { kind: "user" };
  const msg = (nextActions, extra = {}) => ({ kind: "message", nextActions, ...extra });

  it("returns the newest message's chips", () => {
    expect(currentTurnNextActions([user, msg(["Go"])])).toEqual(["Go"]);
  });

  it("is empty when the newest message has none, even if an earlier one did", () => {
    expect(currentTurnNextActions([user, msg(["Go"]), msg(undefined)])).toEqual([]);
  });

  it("is empty once Joe has written after the message", () => {
    expect(currentTurnNextActions([msg(["Go"]), user])).toEqual([]);
  });

  it("treats an answered question card as a turn boundary (its answer has no user row)", () => {
    expect(currentTurnNextActions([msg(["Go"]), { kind: "question" }])).toEqual([]);
  });

  it("treats a wake or peer turn as a boundary", () => {
    expect(currentTurnNextActions([msg(["Go"]), { kind: "system", metaKind: "peer" }])).toEqual([]);
  });

  it("ignores narration rows between the message and the end", () => {
    expect(currentTurnNextActions([user, msg(["Go"]), { kind: "assistant" }, { kind: "tool_use" }])).toEqual(["Go"]);
  });

  it("is empty for a retracted, dimmed or failed message", () => {
    for (const extra of [{ retracted: true }, { dimmed: true }, { failed: true }]) {
      expect(currentTurnNextActions([user, msg(["Go"], extra)])).toEqual([]);
    }
  });

  it("is empty with no messages at all", () => {
    expect(currentTurnNextActions([])).toEqual([]);
  });
});
