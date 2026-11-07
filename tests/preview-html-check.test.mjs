// One definition of "this preview value counts" serves the question's own
// picture, an option's picture, and the payload normaliser, so the three can
// never disagree about what a blank or non-string preview means.
import { describe, expect, it } from "vitest";
import { isPreviewHtml, extractQuestions } from "../src/views/sessions/permission-modal/question-state.ts";
import { hasQuestionPreview, previewedOptions } from "../src/views/sessions/permission-modal/option-previews.ts";

describe("isPreviewHtml", () => {
  it("accepts a non-blank string", () => {
    expect(isPreviewHtml("<b>x</b>")).toBe(true);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(isPreviewHtml("")).toBe(false);
    expect(isPreviewHtml("  \n\t ")).toBe(false);
  });

  it("rejects anything that is not a string", () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], ["<b>x</b>"]]) {
      expect(isPreviewHtml(v)).toBe(false);
    }
  });
});

describe("every preview site uses it", () => {
  it("hasQuestionPreview follows it", () => {
    expect(hasQuestionPreview({ question: "q", preview: "<i>p</i>" })).toBe(true);
    expect(hasQuestionPreview({ question: "q", preview: "  " })).toBe(false);
    expect(hasQuestionPreview(undefined)).toBe(false);
  });

  it("previewedOptions keeps only options with a usable preview", () => {
    const q = {
      question: "q",
      options: [
        { label: "a", preview: "<b>a</b>" },
        { label: "b", preview: "   " },
        { label: "c" },
      ],
    };
    expect(previewedOptions(q).map((o) => o.label)).toEqual(["a"]);
  });

  it("extractQuestions drops blank and non-string previews at both levels, keeping real ones as given", () => {
    const out = extractQuestions({
      questions: [
        { question: "q1", preview: "  <b>p</b> ", options: [{ label: "a", preview: "<i>o</i>" }, { label: "b", preview: " " }, { label: "c", preview: 5 }] },
        { question: "q2", preview: "" },
      ],
    });
    expect(out[0].preview).toBe("  <b>p</b> ");
    expect(out[0].options.map((o) => o.preview)).toEqual(["<i>o</i>", undefined, undefined]);
    expect(out[1].preview).toBeUndefined();
  });
});
