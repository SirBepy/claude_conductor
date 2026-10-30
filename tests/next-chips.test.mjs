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

  it("offers nothing without a registry row (a draft)", () => {
    expect(nextChips({ enabled: true, wrapUp: false, hasHeld: false, inst: undefined })).toEqual([]);
  });
});
