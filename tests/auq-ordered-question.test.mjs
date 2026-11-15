// @vitest-environment jsdom
//
// An `ordered` question on the AUQ card (pc-1751): Joe taps options in sequence
// to number them, taps a numbered one again to take it out (the rest renumber),
// and anything left out is named "Unmarked" in the answer. A single-select and
// a multi-select question stay exactly as they were.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI, computeAnswer, isQuestionAnswered, extractQuestions } = await import(
  "../src/views/sessions/permission-modal/question-ui.ts"
);
const { serializeQuestionDraft, deserializeQuestionDraft } = await import(
  "../src/views/sessions/permission-modal/draft-persistence.ts"
);

const ORDER = {
  question: "What does the run build first?",
  header: "Build order",
  ordered: true,
  options: [{ label: "Stage 7" }, { label: "Stage 8" }, { label: "Polish" }, { label: "Docs" }],
};
const MULTI = { question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };
const SINGLE = { question: "One?", options: [{ label: "x" }, { label: "y" }] };

function baseOpts(questions, overrides = {}) {
  return {
    questions,
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    supportsExtras: true,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    onDraftChange: vi.fn(),
    ...overrides,
  };
}

const panel = (qi) => document.querySelector(`.prompt-panel[data-panel="${qi}"]`);
const tick = (qi, label) => panel(qi).querySelector(`input[data-label="${label}"]`).click();
const ranks = () =>
  Array.from(document.querySelectorAll(".prompt-opt--ordered"), (row) => [
    row.querySelector(".prompt-opt__label").textContent,
    row.querySelector(".prompt-opt__rank").textContent,
  ]);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("computeAnswer for an ordered question", () => {
  it("lists the placed options in tap order, then names every option left out", () => {
    const picked = new Set(["Polish", "Stage 7"]);
    expect(computeAnswer(ORDER, "", picked)).toEqual(["1. Polish", "2. Stage 7", "Unmarked: Stage 8, Docs"]);
  });

  it("has no Unmarked entry when every option was placed", () => {
    const all = new Set(["Docs", "Polish", "Stage 8", "Stage 7"]);
    expect(computeAnswer(ORDER, "", all)).toEqual(["1. Docs", "2. Polish", "3. Stage 8", "4. Stage 7"]);
  });

  it("appends typed text last, and answers with it alone when nothing was placed", () => {
    expect(computeAnswer(ORDER, "none of these", new Set(["Docs"]))).toEqual([
      "1. Docs",
      "Unmarked: Stage 7, Stage 8, Polish",
      "none of these",
    ]);
    expect(computeAnswer(ORDER, "none of these", new Set())).toEqual(["none of these"]);
    expect(computeAnswer(ORDER, "", new Set())).toEqual(["Unmarked: Stage 7, Stage 8, Polish, Docs"]);
  });

  it("leaves a multi-select answer exactly as before (no numbers, no Unmarked)", () => {
    expect(computeAnswer(MULTI, "", new Set(["B"]))).toEqual(["B"]);
  });
});

describe("isQuestionAnswered on the raw payload question", () => {
  it("an ordered question needs a placed option or typed text, with no multiSelect flag set", () => {
    expect(ORDER.multiSelect).toBeUndefined();
    expect(isQuestionAnswered(ORDER, "", new Set())).toBe(false);
    expect(isQuestionAnswered(ORDER, "", new Set(["Docs"]))).toBe(true);
    expect(isQuestionAnswered(ORDER, "typed", new Set())).toBe(true);
  });
});

describe("extractQuestions", () => {
  it("keeps ordered and leaves it off every other question", () => {
    const out = extractQuestions({ questions: [ORDER, MULTI, SINGLE] });
    expect(out.map((q) => q.ordered)).toEqual([true, undefined, undefined]);
  });
});

describe("the ordered card", () => {
  it("numbers taps in sequence, renumbers when one is taken out, and submits the ordered answer", () => {
    const opts = baseOpts([ORDER]);
    renderQuestionUI(opts);
    expect(ranks()).toEqual([["Stage 7", ""], ["Stage 8", ""], ["Polish", ""], ["Docs", ""]]);
    // No "None of the above": an empty order is just nothing placed.
    expect(document.body.textContent).not.toContain("None of the above");

    tick(0, "Polish");
    tick(0, "Stage 7");
    tick(0, "Docs");
    expect(ranks()).toEqual([["Stage 7", "2"], ["Stage 8", ""], ["Polish", "1"], ["Docs", "3"]]);

    tick(0, "Polish"); // taken out: the others close up
    expect(ranks()).toEqual([["Stage 7", "1"], ["Stage 8", ""], ["Polish", ""], ["Docs", "2"]]);

    document.querySelector('[data-act="primary"]').click();
    expect(opts.onSubmit).toHaveBeenCalledTimes(1);
    expect(opts.onSubmit.mock.calls[0][0]).toEqual({
      [ORDER.question]: ["1. Stage 7", "2. Docs", "Unmarked: Stage 8, Polish"],
    });
  });

  it("submitting with nothing placed says everything is unmarked, not an empty list", () => {
    const opts = baseOpts([ORDER]);
    renderQuestionUI(opts);
    document.querySelector('[data-act="primary"]').click();
    expect(opts.onSubmit.mock.calls[0][0]).toEqual({ [ORDER.question]: ["Unmarked: Stage 7, Stage 8, Polish, Docs"] });
  });

  it("keeps the order across a saved draft", () => {
    let draft;
    renderQuestionUI(baseOpts([ORDER], { onDraftChange: (d) => { draft = d; } }));
    tick(0, "Docs");
    tick(0, "Stage 7");
    const restored = deserializeQuestionDraft(JSON.parse(JSON.stringify(serializeQuestionDraft(draft))));
    document.body.innerHTML = "";
    renderQuestionUI(baseOpts([ORDER], { initialDraft: restored }));
    expect(ranks()).toEqual([["Stage 7", "2"], ["Stage 8", ""], ["Polish", ""], ["Docs", "1"]]);
  });

  it("a single-select and a multi-select question render as before, no ranks", () => {
    renderQuestionUI(baseOpts([SINGLE, MULTI]));
    expect(document.querySelectorAll(".prompt-opt__rank")).toHaveLength(0);
    expect(document.querySelectorAll(".prompt-opt--ordered")).toHaveLength(0);
    expect(panel(1).textContent).toContain("None of the above");
  });
});
