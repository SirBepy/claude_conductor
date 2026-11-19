// pc-1787: a ux question whose options all carry one picture draws it once.
// Model-level rule: extractQuestions hoists a shared option picture onto the
// question and drops it from the options; differing pictures stay as asked.

import { describe, it, expect } from "vitest";
import { extractQuestions } from "../src/views/sessions/permission-modal/question-ui.ts";

const ask = (q) => extractQuestions({ questions: [q] })[0];
const IMG = "<img src='file:///C:/shot.png'>";

describe("extractQuestions shared option preview", () => {
  it("hoists one picture shared by every previewed option onto the question", () => {
    const q = ask({
      question: "Is this good?", domain: "ux",
      options: [{ label: "Good", preview: IMG }, { label: "Change something", preview: IMG }],
    });
    expect(q.preview).toBe(IMG);
    expect(q.options.map((o) => o.preview)).toEqual([undefined, undefined]);
    expect(q.options.map((o) => o.label)).toEqual(["Good", "Change something"]);
  });

  it("drops an option picture the question already shows, and keeps the question's", () => {
    const q = ask({
      question: "Is this good?", domain: "ux", preview: `  ${IMG}\n`,
      options: [{ label: "Good", preview: IMG }, { label: "Change", preview: IMG }],
    });
    expect(q.preview).toBe(`  ${IMG}\n`);
    expect(q.options.every((o) => o.preview === undefined)).toBe(true);
  });

  it("drops a lone option picture that duplicates the question's own", () => {
    const q = ask({
      question: "Which?", domain: "ux", preview: IMG,
      options: [{ label: "A", preview: IMG }, { label: "B" }],
    });
    expect(q.options.map((o) => o.preview)).toEqual([undefined, undefined]);
  });

  it("leaves pictures that differ on their options, with no question picture invented", () => {
    const q = ask({
      question: "Which?", domain: "ux",
      options: [{ label: "A", preview: "<b>a</b>" }, { label: "B", preview: "<b>b</b>" }],
    });
    expect(q.preview).toBeUndefined();
    expect(q.options.map((o) => o.preview)).toEqual(["<b>a</b>", "<b>b</b>"]);
  });

  it("leaves a single previewed option alone when the question has no picture", () => {
    const q = ask({ question: "Which?", domain: "ux", options: [{ label: "A", preview: IMG }, { label: "B" }] });
    expect(q.preview).toBeUndefined();
    expect(q.options[0].preview).toBe(IMG);
  });

  it("leaves option pictures alone when the question shows a different picture", () => {
    const q = ask({
      question: "Which?", domain: "ux", preview: "<b>header</b>",
      options: [{ label: "A", preview: IMG }, { label: "B", preview: IMG }],
    });
    expect(q.preview).toBe("<b>header</b>");
    expect(q.options.map((o) => o.preview)).toEqual([IMG, IMG]);
  });

  it("keeps description and badges when it strips a picture", () => {
    const q = ask({
      question: "Is this good?", domain: "ux",
      options: [{ label: "Good", description: "d", badges: ["recommended"], preview: IMG }, { label: "No", preview: IMG }],
    });
    expect(q.options[0].description).toBe("d");
    expect(q.options[0].badges).toEqual(["recommended"]);
  });
});
