// @vitest-environment jsdom

// DOM half of the degraded_builtin badge fix (see auq-degraded-badge-live-card
// for the payload -> opts half). Real renderQuestionUI, no mock, same pattern
// as auq-escape-lightbox-guard.test.mjs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue([]);
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

describe("live card degraded_builtin badge", () => {
  it("shows the diagnostic marker when opts.degradedBuiltin is true", () => {
    renderQuestionUI(baseOpts({ degradedBuiltin: true }));
    expect(document.querySelector(".question-card-degraded-badge")).not.toBeNull();
  });

  it("is absent when opts.degradedBuiltin is false/unset", () => {
    renderQuestionUI(baseOpts());
    expect(document.querySelector(".question-card-degraded-badge")).toBeNull();
  });
});
