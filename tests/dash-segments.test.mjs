// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "lit-html";

// The segmented bar (`_card.segments`): slices sized against the bar's max, a
// label inside a slice wide enough for one and a chip under the bar for one
// that is not, a pace tick, and a toned note.

const { segmentsBar, sliceColors, MIN_LABEL_SHARE } = await import("../src/views/sessions/project-dashboard/dash-segments.ts");

const seg = (items, extra = {}) => ({ items, max: 20, marker: null, note: "", note_tone: null, ...extra });
const item = (label, value, text = "") => ({ label, value, text });
function draw(s) {
  const host = document.createElement("div");
  render(segmentsBar(s), host);
  return host;
}
const slices = (h) => [...h.querySelectorAll(".pd-seg-slice")];
const chips = (h) => [...h.querySelectorAll(".pd-seg-chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim());

describe("segments bar", () => {
  it("sizes each slice as its share of the bar's max", () => {
    const h = draw(seg([item("Mon", 5, "5:00"), item("Tue", 10, "10:00")]));
    expect(slices(h).map((s) => s.style.width)).toEqual(["25%", "50%"]);
  });

  it("scales to the slices' sum when they overshoot the max, so the bar never overflows", () => {
    const h = draw(seg([item("Mon", 15), item("Tue", 15)], { max: 20 }));
    expect(slices(h).map((s) => s.style.width)).toEqual(["50%", "50%"]);
  });

  it("prints day over figure in a slice wide enough, and nothing in a thin one", () => {
    const h = draw(seg([item("Mon", 3.75, "3:45"), item("Tue", 0.2, "0:12")]));
    const [wide, thin] = slices(h);
    expect(wide.querySelector("em").textContent).toBe("Mon");
    expect(wide.querySelector("b").textContent).toBe("3:45");
    expect(thin.textContent.trim()).toBe("");
  });

  it("moves a thin slice to a chip under the bar, keeping its own colour", () => {
    const h = draw(seg([item("Mon", 3.75, "3:45"), item("Tue", 0.2, "0:12")]));
    expect(chips(h)).toEqual(["Tue 0:12"]);
    expect(h.querySelector(".pd-seg-chip i").style.background).toBe(sliceColors(1).bg);
  });

  it("draws no slice and no chip for a day with nothing logged", () => {
    const h = draw(seg([item("Mon", 4, "4:00"), item("Tue", 0, "0:00")]));
    expect(slices(h)).toHaveLength(1);
    expect(chips(h)).toEqual([]);
    expect(h.querySelector(".pd-seg-foot")).toBeNull();
  });

  it("keeps a day's colour tied to its position even when an earlier day is empty", () => {
    const h = draw(seg([item("Mon", 0), item("Tue", 5, "5:00")]));
    expect(slices(h)[0].style.background).toBe(sliceColors(1).bg);
  });

  it("falls back to the raw value when a slice has no text", () => {
    const h = draw(seg([item("Mon", 6)]));
    expect(h.querySelector(".pd-seg-slice b").textContent).toBe("6");
  });

  it("places the pace tick at its share of the bar and caps it at the end", () => {
    expect(draw(seg([item("Mon", 4)], { marker: 5 })).querySelector(".pd-seg-marker").style.left).toBe("25%");
    expect(draw(seg([item("Mon", 4)], { marker: 99 })).querySelector(".pd-seg-marker").style.left).toBe("100%");
    expect(draw(seg([item("Mon", 4)])).querySelector(".pd-seg-marker")).toBeNull();
  });

  it("shows the note with its tone", () => {
    const h = draw(seg([item("Mon", 4)], { note: "4:15 behind pace", note_tone: "warn" }));
    const note = h.querySelector(".pd-seg-note");
    expect(note.textContent).toBe("4:15 behind pace");
    expect(note.classList.contains("warn")).toBe(true);
  });

  it("describes the bar for a screen reader, thin slices included", () => {
    const h = draw(seg([item("Mon", 3.75, "3:45"), item("Tue", 0.2, "0:12")]));
    expect(h.querySelector(".pd-seg-bar").getAttribute("aria-label")).toBe("Mon 3:45, Tue 0:12");
  });

  it("the label threshold is the share a two-line cell needs", () => {
    const edge = MIN_LABEL_SHARE * 20;
    expect(slices(draw(seg([item("A", edge + 0.01)])))[0].querySelector("em")).not.toBeNull();
    expect(slices(draw(seg([item("A", edge - 0.01)])))[0].querySelector("em")).toBeNull();
  });
});

describe("slice colours", () => {
  it("steps lightness up through the week on one hue and holds the lightest past the ramp", () => {
    const l = (i) => Number(/oklch\(([\d.]+)/.exec(sliceColors(i).bg)[1]);
    expect(l(0)).toBeLessThan(l(1));
    expect(l(5)).toBeLessThan(l(6));
    expect(sliceColors(9)).toEqual(sliceColors(6));
    expect(sliceColors(-3)).toEqual(sliceColors(0));
  });

  it("sets the text to a dark shade of the fill's own hue", () => {
    const hue = (c) => /oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(c)[1];
    const { bg, fg } = sliceColors(2);
    expect(hue(fg)).toBe(hue(bg));
    expect(Number(/oklch\(([\d.]+)/.exec(fg)[1])).toBeLessThan(0.35);
  });
});
