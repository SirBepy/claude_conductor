// The shared mockup's row and popover rules, with no DOM: who gets which chip,
// what counts as a new control, which value is in force, and where the popover may sit.
import { describe, it, expect } from "vitest";
import { ownerChips, freshChips, controlKey, controlValue, clampPos } from "../src/views/sessions/shared-mockup-model.ts";

const select = { id: "style", label: "Style", kind: "select", options: ["a", "b"], default: "a" };
const sw = { id: "photo", label: "Photo", kind: "switch", options: [], default: "off" };
const part = (id, owner, controls) => ({ id, owner_session_id: owner, owner_name: owner, html: "", css: "", controls });
const shared = (parts) => ({ owner_session_id: "main", shell: "", parts });

describe("ownerChips", () => {
  it("puts subs with controls first and a running sub that added nothing last, dashed", () => {
    const subs = [
      { id: "s-skills", name: "Skills", kind: "working" },
      { id: "s-hero", name: "Hero", kind: "asking" },
    ];
    const chips = ownerChips(shared([part("header", "s-hero", [select, sw])]), subs);
    expect(chips.map((c) => [c.id, c.controls.length])).toEqual([["s-hero", 2], ["s-skills", 0]]);
    expect(chips[0].name).toBe("Hero");
  });

  it("leaves a finished sub out when it never wrote a part, keeps one that did", () => {
    const subs = [{ id: "done-empty", name: "A", kind: "finished" }, { id: "done-wrote", name: "B", kind: "finished" }];
    const chips = ownerChips(shared([part("p", "done-wrote", [sw])]), subs);
    expect(chips.map((c) => c.id)).toEqual(["done-wrote"]);
  });

  it("merges two parts of one sub into one chip and keeps each control's part", () => {
    const chips = ownerChips(shared([part("a", "s1", [sw]), part("b", "s1", [select])]), []);
    expect(chips).toHaveLength(1);
    expect(chips[0].controls.map((c) => c.partId)).toEqual(["a", "b"]);
  });

  it("a part with no controls is a dashed chip", () => {
    const chips = ownerChips(shared([part("a", "s1", [])]), []);
    expect(chips[0].controls).toEqual([]);
  });
});

describe("freshChips", () => {
  const chips = [
    { id: "a", name: "A", controls: [{ partId: "p", control: sw }] },
    { id: "b", name: "B", controls: [{ partId: "q", control: sw }] },
    { id: "c", name: "C", controls: [] },
  ];
  it("marks controls nobody looked at yet, never the open chip or a dashed one", () => {
    expect([...freshChips(chips, new Set(["a"]), null)]).toEqual(["b"]);
    expect([...freshChips(chips, new Set(), "b")]).toEqual(["a"]);
  });
});

describe("controlValue", () => {
  const oc = { partId: "p", control: select };
  it("is the default until the panel sets one, then that value", () => {
    const values = new Map();
    expect(controlValue(values, "snap", oc)).toBe("a");
    values.set(controlKey("snap", "p", "style"), "b");
    expect(controlValue(values, "snap", oc)).toBe("b");
    expect(controlValue(values, "other-snap", oc)).toBe("a");
  });
});

describe("clampPos", () => {
  it("keeps a popover inside the panel at its real size", () => {
    expect(clampPos({ x: 900, y: 900 }, { w: 200, h: 100 }, { w: 500, h: 400 })).toEqual({ x: 300, y: 300 });
    expect(clampPos({ x: -5, y: -5 }, { w: 200, h: 100 }, { w: 500, h: 400 })).toEqual({ x: 0, y: 0 });
  });
  it("a tall popover opened after a short one was dragged low moves up", () => {
    const low = clampPos({ x: 10, y: 360 }, { w: 200, h: 40 }, { w: 500, h: 400 });
    expect(low.y).toBe(360);
    expect(clampPos(low, { w: 200, h: 300 }, { w: 500, h: 400 }).y).toBe(100);
  });
  it("a popover taller than the panel sits at the top, the panel growing to it", () => {
    expect(clampPos({ x: 0, y: 50 }, { w: 200, h: 500 }, { w: 500, h: 400 }).y).toBe(0);
  });
});
