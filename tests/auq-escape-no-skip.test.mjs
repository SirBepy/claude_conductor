// @vitest-environment jsdom
//
// Escape must never skip an AUQ card. A skipped card sends no answer at all
// (opts.onCancel) and the key is reflexive enough to burn a whole prompt by
// accident - the footer's "Skip" button is the one explicit route. Escape's
// only remaining job is dropping focus out of a text field, mirroring the
// phone back button (see auq-back-button-no-skip.test.mjs).
//
// Absorbed the earlier lightbox-guard regression: Escape meant for an open
// image lightbox used to cancel the card underneath on the same keypress.

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

describe("AUQ card Escape handling", () => {
  it("never cancels the card, no matter how many times it is pressed", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    pressEscape();
    pressEscape();
    pressEscape();

    expect(opts.onCancel).not.toHaveBeenCalled();
    expect(opts.onSubmit).not.toHaveBeenCalled();
  });

  it("blurs a focused text field instead of cancelling", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    pressEscape();

    expect(document.activeElement).not.toBe(input);
    expect(opts.onCancel).not.toHaveBeenCalled();
  });

  it("does not cancel the card while a lightbox overlay is open", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    document.body.appendChild(overlay);

    pressEscape();
    expect(opts.onCancel).not.toHaveBeenCalled();

    overlay.remove();
    pressEscape();
    expect(opts.onCancel).not.toHaveBeenCalled();
  });

  it("leaves the explicit Skip button as the one route to answering nothing", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    const skipBtn = document.querySelector('button[data-act="cancel"]');
    expect(skipBtn).toBeTruthy();
    expect(skipBtn.textContent.trim()).toBe("Skip");

    skipBtn.click();

    expect(opts.onCancel).toHaveBeenCalledTimes(1);
  });
});
