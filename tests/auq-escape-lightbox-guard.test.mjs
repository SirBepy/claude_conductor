// @vitest-environment jsdom
//
// Regression: Escape meant for an open image lightbox used to also cancel
// the AUQ card underneath on the same keypress, sending no answer at all
// (opts.onCancel) - unrecoverable for the user. The keydown handler now
// checks for a live `.lightbox-overlay` before treating Escape as cancel.

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

function pressEscape() {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("AUQ card Escape handling vs an open lightbox", () => {
  it("Escape cancels the card as normal when no lightbox is open", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    pressEscape();

    expect(opts.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape does NOT cancel the card while a lightbox overlay is open", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    document.body.appendChild(overlay);

    pressEscape();

    expect(opts.onCancel).not.toHaveBeenCalled();

    // Once the lightbox itself closes, Escape resumes cancelling the card
    // normally - this isn't a permanent lockout, just deferred to whichever
    // overlay is actually on top.
    overlay.remove();
    pressEscape();
    expect(opts.onCancel).toHaveBeenCalledTimes(1);
  });
});
