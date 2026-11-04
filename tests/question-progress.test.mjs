import { describe, it, expect } from "vitest";
import {
  computeQuestionProgress,
  pruneLiveQuestionProgress,
  setLiveQuestionProgress,
} from "../src/views/sessions/question-progress.ts";

const draft = (freeText = [], selections = []) => ({
  freeText: new Map(freeText),
  selections: new Map(selections),
  activeTab: 0,
  additionalMessage: "",
  attachments: [],
});
const qs = [
  { question: "Scope?", options: [{ label: "A" }, { label: "B" }] },
  { question: "Which?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
  { question: "Why?" },
];

describe("computeQuestionProgress", () => {
  it("counts nothing answered with no draft", () => {
    expect(computeQuestionProgress(qs, undefined)).toMatchObject({ total: 3, answered: 0, answers: [null, null, null] });
  });

  it("reads a single-select pick, a multi-select set and typed free text as answers", () => {
    const p = computeQuestionProgress(qs, draft([[2, "because"]], [[0, "B"], [1, new Set(["X", "Y"])]]));
    expect(p.answered).toBe(3);
    expect(p.answers).toEqual(["B", "X, Y", "because"]);
  });

  it("does not count an empty multi-select or blank free text", () => {
    const p = computeQuestionProgress(qs, draft([[2, "   "]], [[1, new Set()]]));
    expect(p.answered).toBe(0);
  });

  it("joins a pick and typed text for one question", () => {
    const p = computeQuestionProgress(qs, draft([[0, "note"]], [[0, "A"]]));
    expect(p.answers[0]).toBe("A + note");
  });
});

describe("pruneLiveQuestionProgress", () => {
  it("drops the mirrored progress of sessions that are no longer listed and keeps the rest", () => {
    setLiveQuestionProgress("open", "p1", qs, undefined);
    setLiveQuestionProgress("closed", "p2", qs, undefined);

    pruneLiveQuestionProgress(["open"]);

    // setLiveQuestionProgress reports whether the entry moved: false for a kept
    // entry re-recorded unchanged, true for one that was dropped and is new again.
    expect(setLiveQuestionProgress("open", "p1", qs, undefined)).toBe(false);
    expect(setLiveQuestionProgress("closed", "p2", qs, undefined)).toBe(true);
    pruneLiveQuestionProgress([]);
  });
});
