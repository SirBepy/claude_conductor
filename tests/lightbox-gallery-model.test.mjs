// The pure rules behind the lightbox's gallery mode: where a step lands, the counter
// text, when a group needs arrows at all, and which arrow presses belong to the caption box.

import { describe, it, expect } from "vitest";
import {
  arrowStepsGallery, attachmentGallery, clampIndex, counterLabel, galleryOfItems, isNavigable, stepTarget,
} from "../src/shared/chat/lightbox-gallery-model.ts";

const key = (k, over = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
const free = { inTextField: false, textEmpty: false };
const typing = { inTextField: true, textEmpty: false };
const emptyBox = { inTextField: true, textEmpty: true };

describe("clampIndex", () => {
  it("keeps an index in range and pins one outside it to the nearest end", () => {
    expect(clampIndex(3, 10)).toBe(3);
    expect(clampIndex(-4, 10)).toBe(0);
    expect(clampIndex(99, 10)).toBe(9);
  });
  it("is 0 for an empty group and for a non-number, never NaN or -1", () => {
    expect(clampIndex(2, 0)).toBe(0);
    expect(clampIndex(Number.NaN, 5)).toBe(0);
    expect(clampIndex(Infinity, 5)).toBe(0);
  });
  it("floors a fraction", () => {
    expect(clampIndex(2.9, 5)).toBe(2);
  });
});

describe("stepTarget", () => {
  it("moves one step either way inside the group", () => {
    expect(stepTarget(2, 1, 5)).toBe(3);
    expect(stepTarget(2, -1, 5)).toBe(1);
  });
  it("never wraps: stepping off either end is null", () => {
    expect(stepTarget(0, -1, 5)).toBeNull();
    expect(stepTarget(4, 1, 5)).toBeNull();
  });
});

describe("counterLabel", () => {
  it("reads 1-based as 'n / total'", () => {
    expect(counterLabel(2, 35)).toBe("3 / 35");
    expect(counterLabel(0, 2)).toBe("1 / 2");
  });
  it("clamps a stale index instead of showing 0 or past the end", () => {
    expect(counterLabel(40, 35)).toBe("35 / 35");
    expect(counterLabel(-1, 35)).toBe("1 / 35");
  });
});

describe("isNavigable", () => {
  it("is true only when there is somewhere to go", () => {
    expect(isNavigable({ count: 2 })).toBe(true);
    expect(isNavigable({ count: 1 })).toBe(false);
    expect(isNavigable({ count: 0 })).toBe(false);
    expect(isNavigable(null)).toBe(false);
    expect(isNavigable(undefined)).toBe(false);
  });
});

describe("arrowStepsGallery", () => {
  it("Left is -1 and Right is +1 with focus outside any text field", () => {
    expect(arrowStepsGallery(key("ArrowLeft"), free)).toBe(-1);
    expect(arrowStepsGallery(key("ArrowRight"), free)).toBe(1);
  });
  it("ignores every other key", () => {
    expect(arrowStepsGallery(key("ArrowUp"), free)).toBeNull();
    expect(arrowStepsGallery(key("a"), free)).toBeNull();
    expect(arrowStepsGallery(key("Enter"), free)).toBeNull();
  });
  it("leaves the arrows to a caption box that has text, so the caret still moves", () => {
    expect(arrowStepsGallery(key("ArrowLeft"), typing)).toBeNull();
    expect(arrowStepsGallery(key("ArrowRight"), typing)).toBeNull();
  });
  it("steps from an empty caption box, which has no caret to move", () => {
    expect(arrowStepsGallery(key("ArrowRight"), emptyBox)).toBe(1);
  });
  it("Alt+Arrow steps even from a caption box that has text", () => {
    expect(arrowStepsGallery(key("ArrowLeft", { altKey: true }), typing)).toBe(-1);
  });
  it("a Ctrl, Meta or Shift arrow is a word jump or selection and always stays with the box", () => {
    for (const mod of ["ctrlKey", "metaKey", "shiftKey"]) {
      expect(arrowStepsGallery(key("ArrowLeft", { [mod]: true }), free)).toBeNull();
      expect(arrowStepsGallery(key("ArrowLeft", { [mod]: true, altKey: true }), typing)).toBeNull();
    }
  });
});

describe("galleryOfItems", () => {
  const items = [
    { type: "text", content: "a" },
    { type: "text", content: "b" },
    { type: "text", content: "c" },
  ];
  it("serves the item at an index and null past the ends", () => {
    const g = galleryOfItems(items, 1);
    expect(g.count).toBe(3);
    expect(g.index).toBe(1);
    expect(g.load(2)).toEqual(items[2]);
    expect(g.load(3)).toBeNull();
    expect(g.load(-1)).toBeNull();
  });
  it("clamps a start index that is out of range", () => {
    expect(galleryOfItems(items, 9).index).toBe(2);
    expect(galleryOfItems(items, -3).index).toBe(0);
  });
});

describe("attachmentGallery", () => {
  const img = (n) => ({ mime: "image/png", data: `d${n}`, filename: `${n}.png` });
  const file = { mime: "application/pdf", data: "pdf", filename: "a.pdf" };
  const pending = { mime: "image/png", data: "", filename: "wait.png" };

  it("groups only the loaded images and points at the clicked one", () => {
    const a = img(1);
    const b = img(2);
    const g = attachmentGallery([a, file, pending, b], b);
    expect(g.count).toBe(2);
    expect(g.index).toBe(1);
    expect(g.load(0)).toEqual({ type: "image", mime: "image/png", base64: "d1", filename: "1.png" });
  });
  it("is null for a lone image, so a single image shows no arrows", () => {
    const a = img(1);
    expect(attachmentGallery([a, file], a)).toBeNull();
  });
  it("is null when the clicked item is not an image of the list", () => {
    expect(attachmentGallery([img(1), img(2)], img(3))).toBeNull();
  });
});
