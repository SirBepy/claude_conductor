// @vitest-environment jsdom

// A single-question prompt card (hasSummary false, totalPanels 1) rendered a
// lone .prompt-dot next to the title icon - a hollow ring with nothing to
// paginate against, read by Joe as an unexplained glyph on two surfaces
// (phone and the desktop view harness). pagerHtml() now skips the dot
// entirely when there's only one panel; same pattern as
// auq-degraded-badge-render.test.mjs (real renderQuestionUI, no mock).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

function baseOpts(overrides = {}) {
  return {
    questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("single-question prompt card header", () => {
  it("renders no pager dot when there is only one panel to show", () => {
    renderQuestionUI(baseOpts());
    expect(document.querySelector(".prompt-dot")).toBeNull();
    expect(document.querySelector(".prompt-dots")).toBeNull();
  });

  it("still renders dots once a second question makes the summary panel real", () => {
    renderQuestionUI(baseOpts({
      questions: [
        { question: "Pick one?", header: "Choice", options: [{ label: "A" }, { label: "B" }] },
        { question: "Pick two?", header: "Choice 2", options: [{ label: "C" }, { label: "D" }] },
      ],
    }));
    expect(document.querySelectorAll(".prompt-dot").length).toBeGreaterThan(0);
  });
});
