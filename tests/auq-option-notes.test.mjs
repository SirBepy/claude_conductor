// @vitest-environment jsdom
//
// Per-option notes on the AUQ card (Joe, 2026-10-26): a pencil on every TICKED
// option opens a note box under it, and the note ships inside that option's
// answer string. Review drops the footer answer box for a single Submit button
// plus an "Add a note" row, and Skip moved to the minimized bar.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI, computeAnswer } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { serializeQuestionDraft, deserializeQuestionDraft } = await import("../src/views/sessions/permission-modal/draft-persistence.ts");

const MULTI = {
  question: "Which sections?",
  header: "Sections",
  multiSelect: true,
  options: [{ label: "Top strip" }, { label: "Vazno" }, { label: "Kalendar" }],
};
const SINGLE = { question: "Range?", header: "Range", options: [{ label: "6 months" }, { label: "12 months" }] };

function baseOpts(overrides = {}) {
  return {
    questions: [MULTI, SINGLE],
    titleIcon: "ph-question",
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
const pencil = (label) => document.querySelector(`[data-note-toggle="${label}"]`);
const pencilLabels = (qi) => Array.from(panel(qi).querySelectorAll("[data-note-toggle]"), (b) => b.dataset.noteToggle);

function writeNote(label, text) {
  pencil(label).click();
  const field = document.querySelector(`.prompt-opt__note-input[data-note-for="${label}"]`);
  field.value = text;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function goToReview() {
  // Next twice: the multi-select question, then the single one.
  document.querySelector('[data-act="primary"]').click();
  tick(1, "6 months");
  document.querySelector('[data-act="primary"]').click();
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("AUQ per-option notes", () => {
  it("shows a pencil only on ticked options, never on None of the above", () => {
    renderQuestionUI(baseOpts());
    expect(pencilLabels(0)).toEqual([]);
    tick(0, "Top strip");
    tick(0, "Kalendar");
    expect(pencilLabels(0)).toEqual(["Top strip", "Kalendar"]);
    tick(0, "None of the above");
    expect(pencilLabels(0)).toEqual([]);
  });

  it("ships a ticked option's note inside its answer, and drops an unticked one's", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);
    tick(0, "Top strip");
    tick(0, "Vazno");
    writeNote("Top strip", "feels meh");
    writeNote("Vazno", "ugly");
    tick(0, "Vazno");
    goToReview();
    document.querySelector('[data-act="primary"]').click();

    expect(opts.onSubmit).toHaveBeenCalledTimes(1);
    const [answers] = opts.onSubmit.mock.calls[0];
    expect(answers["Which sections?"]).toEqual(["Top strip (note: feels meh)"]);
    expect(answers["Range?"]).toBe("6 months");
  });

  it("keeps the note box open across a pick, and closes it when its option is unticked", () => {
    renderQuestionUI(baseOpts());
    tick(0, "Top strip");
    pencil("Top strip").click();
    tick(0, "Kalendar");
    expect(document.querySelector('.prompt-opt__note-input[data-note-for="Top strip"]')).not.toBeNull();
    tick(0, "Top strip");
    expect(document.querySelector(".prompt-opt__note-input")).toBeNull();
  });

  it("notes a single-select pick, combined with typed text", () => {
    const notes = new Map([["6 months", "plenty"]]);
    expect(computeAnswer(SINGLE, "", "6 months", notes)).toBe("6 months (note: plenty)");
    expect(computeAnswer(SINGLE, "also this", "6 months", notes)).toEqual(["6 months (note: plenty)", "also this"]);
    expect(computeAnswer(SINGLE, "", "12 months", notes)).toBe("12 months");
  });

  it("round-trips notes through the draft payload, and leaves a note-free draft unchanged", () => {
    const base = { freeText: new Map(), selections: new Map([[0, new Set(["Top strip"])]]), activeTab: 0, additionalMessage: "", attachments: [] };
    expect(serializeQuestionDraft(base)).not.toHaveProperty("notes");
    const withNotes = { ...base, notes: new Map([[0, new Map([["Top strip", "meh"], ["Vazno", "  "]])]]) };
    const back = deserializeQuestionDraft(JSON.parse(JSON.stringify(serializeQuestionDraft(withNotes))));
    expect(Array.from(back.notes.get(0))).toEqual([["Top strip", "meh"]]);
  });

  it("restores a draft's note on the option it belongs to", () => {
    renderQuestionUI(baseOpts({
      id: "p1",
      initialDraft: {
        freeText: new Map(), selections: new Map([[0, new Set(["Top strip"])]]), activeTab: 0,
        additionalMessage: "", attachments: [], notes: new Map([[0, new Map([["Top strip", "from draft"]])]]),
      },
    }));
    expect(panel(0).querySelector(".prompt-opt__note").textContent).toBe("from draft");
  });
});

describe("AUQ review step", () => {
  it("is one Submit button, lists option notes, and keeps the message behind Add a note", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);
    tick(0, "Top strip");
    writeNote("Top strip", "feels meh");
    goToReview();

    const footer = document.querySelector(".prompt-card__footer");
    expect(footer.querySelector('[data-act="primary"]').classList.contains("prompt-submit-cta")).toBe(true);
    expect(footer.querySelectorAll("button").length).toBe(1);
    expect(footer.querySelector("textarea")).toBeNull();
    expect(document.querySelector(".prompt-summary-row__note").textContent).toBe("Top strip: feels meh");

    expect(document.querySelector(".prompt-extra-input")).toBeNull();
    document.querySelector('[data-act="add-note"]').click();
    const field = document.querySelector(".prompt-summary__note .prompt-extra-input");
    expect(field).not.toBeNull();
    expect(document.querySelector(".prompt-summary__note .composer-field-send")).toBeNull();
    field.value = "one more thing";
    field.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector('[data-act="primary"]').click();
    expect(opts.onSubmit.mock.calls[0][1].additionalMessage).toBe("one more thing");
  });
});

describe("AUQ Skip on the minimized bar", () => {
  it("is absent from the open card and skips only from the bar", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);
    expect(document.querySelector('[data-act="cancel"], [data-act="skip"], [data-act="back"]')).toBeNull();

    document.querySelector('[data-act="minimize"]').click();
    const skip = document.querySelector('.prompt-collapsed [data-act="cancel"]');
    expect(skip.textContent).toBe("Skip");
    skip.click();
    expect(opts.onCancel).toHaveBeenCalledTimes(1);
  });

  it("restores from the bar without skipping", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);
    document.querySelector('[data-act="minimize"]').click();
    document.querySelector('.prompt-collapsed [data-act="restore"]').click();
    expect(document.querySelector(".prompt-card")).not.toBeNull();
    expect(opts.onCancel).not.toHaveBeenCalled();
  });
});
