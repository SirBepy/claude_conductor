// asserts: src/views/sessions/next-chips.ts
import { describe, expect, it } from "vitest";

const { nextChips, withReply } = await import("../src/views/sessions/next-chips.ts");

const done = { awaiting: "done", busy: false, closing: false, ended_at: null, frozen: false, kind: "interactive" };
const ctx = (over = {}, inst = {}) => ({ enabled: true, hasHeld: false, inst: { ...done, ...inst }, ...over });

describe("nextChips", () => {
  it("offers nothing of its own once the turn finished: /close is not a command", () => {
    expect(nextChips(ctx())).toEqual([]);
  });

  it.each(["question", "working", "waiting", null])("offers nothing while awaiting is %s", (awaiting) => {
    expect(nextChips(ctx({}, { awaiting }))).toEqual([]);
  });

  it.each([
    ["busy", { busy: true }],
    ["closing", { closing: true }],
    ["frozen", { frozen: true }],
    ["ended", { ended_at: "2026-10-30T10:00:00Z" }],
    ["external (read-only)", { kind: "external" }],
    ["automated (read-only)", { kind: "automated" }],
  ])("offers nothing for a %s chat", (_label, inst) => {
    expect(nextChips(ctx({}, inst))).toEqual([]);
  });

  it("offers nothing with the setting off", () => {
    expect(nextChips(ctx({ enabled: false }))).toEqual([]);
  });

  it("offers nothing while a held message waits to send", () => {
    expect(nextChips(ctx({ hasHeld: true }))).toEqual([]);
  });

  it("lists the model's replies", () => {
    expect(nextChips(ctx({ nextActions: ["Yes, implement this", "/commit"] }))).toEqual(["Yes, implement this", "/commit"]);
  });

  it("shows all three of the model's replies", () => {
    expect(nextChips(ctx({ nextActions: ["A", "B", "C"] }))).toEqual(["A", "B", "C"]);
  });

  it("never shows more than three replies", () => {
    expect(nextChips(ctx({ nextActions: ["A", "B", "C", "D"] }))).toEqual(["A", "B", "C"]);
  });

  it("drops a model-written /close, which an old chat still has stored", () => {
    expect(nextChips(ctx({ nextActions: ["/close it worked", "/CLOSE", "Go"] }))).toEqual(["Go"]);
    expect(nextChips(ctx({ nextActions: ["/close"] }))).toEqual([]);
  });

  it("drops a /close with leading whitespace", () => {
    expect(nextChips(ctx({ nextActions: [" /close", "	/close --now", "Go"] }))).toEqual(["Go"]);
  });

  it("keeps a reply that only starts like /close", () => {
    expect(nextChips(ctx({ nextActions: ["/closet", "Go"] }))).toEqual(["/closet", "Go"]);
  });

  it("dedupes a reply that repeats another chip", () => {
    expect(nextChips(ctx({ nextActions: ["Go", "go"] }))).toEqual(["Go"]);
  });

  it("hides the model's replies on every gate that hides the strip", () => {
    expect(nextChips(ctx({ nextActions: ["Go"] }, { awaiting: "question" }))).toEqual([]);
    expect(nextChips(ctx({ nextActions: ["Go"], enabled: false }))).toEqual([]);
    expect(nextChips(ctx({ nextActions: ["Go"], hasHeld: true }))).toEqual([]);
  });

  it("offers nothing without a registry row (a draft)", () => {
    expect(nextChips({ enabled: true, hasHeld: false, inst: undefined })).toEqual([]);
  });
});

describe("withReply", () => {
  it("fills an empty box with the reply", () => {
    expect(withReply("", "Yes, implement this")).toBe("Yes, implement this");
    expect(withReply("  \n", "Yes, implement this")).toBe("Yes, implement this");
  });

  it("puts a reply above typed text, once", () => {
    const once = withReply("also add tests", "Yes, implement this");
    expect(once).toBe("Yes, implement this\nalso add tests");
    expect(withReply(once, "Yes, implement this")).toBe(once);
  });

  it("keeps a leading slash command first so it still runs as a command", () => {
    const once = withReply("/commit ", "Yes, implement this");
    expect(once.startsWith("/commit")).toBe(true);
    expect(once).toBe("/commit\nYes, implement this");
    expect(withReply(once, "Yes, implement this")).toBe(once);
    expect(withReply("/commit fix typo", "Yes, implement this")).toBe("/commit fix typo\nYes, implement this");
  });
});
