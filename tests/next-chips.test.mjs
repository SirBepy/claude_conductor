// asserts: src/views/sessions/next-chips.ts
import { describe, expect, it } from "vitest";

const { nextChips } = await import("../src/views/sessions/next-chips.ts");

const done = { awaiting: "done", busy: false, closing: false, ended_at: null, frozen: false, kind: "interactive" };
const ctx = (over = {}, inst = {}) => ({ enabled: true, wrapUp: false, hasHeld: false, inst: { ...done, ...inst }, ...over });

describe("nextChips", () => {
  it("offers /close once the turn finished", () => {
    expect(nextChips(ctx())).toEqual(["/close"]);
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

  it("offers no /close when the chat wraps up on its own", () => {
    expect(nextChips(ctx({ wrapUp: true }))).toEqual([]);
  });

  it("lists the model's replies after /close", () => {
    expect(nextChips(ctx({ nextActions: ["Yes, implement this", "/commit"] }))).toEqual(["/close", "Yes, implement this", "/commit"]);
  });

  it("shows all three of the model's replies after /close", () => {
    expect(nextChips(ctx({ nextActions: ["A", "B", "C"] }))).toEqual(["/close", "A", "B", "C"]);
  });

  it("never shows more than /close plus three replies", () => {
    expect(nextChips(ctx({ nextActions: ["A", "B", "C", "D"] }))).toEqual(["/close", "A", "B", "C"]);
  });

  it("drops a model-written /close, which would duplicate the built-in one", () => {
    expect(nextChips(ctx({ nextActions: ["/close it worked", "/CLOSE", "Go"] }))).toEqual(["/close", "Go"]);
  });

  it("dedupes a reply that repeats another chip", () => {
    expect(nextChips(ctx({ nextActions: ["Go", "go"] }))).toEqual(["/close", "Go"]);
  });

  it("keeps the model's replies but not /close while the chat wraps up on its own", () => {
    expect(nextChips(ctx({ wrapUp: true, nextActions: ["Go"] }))).toEqual(["Go"]);
  });

  it("hides the model's replies on every gate that hides /close", () => {
    expect(nextChips(ctx({ nextActions: ["Go"] }, { awaiting: "question" }))).toEqual([]);
    expect(nextChips(ctx({ nextActions: ["Go"], enabled: false }))).toEqual([]);
    expect(nextChips(ctx({ nextActions: ["Go"], hasHeld: true }))).toEqual([]);
  });

  it("offers nothing without a registry row (a draft)", () => {
    expect(nextChips({ enabled: true, wrapUp: false, hasHeld: false, inst: undefined })).toEqual([]);
  });
});
