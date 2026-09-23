// @vitest-environment jsdom
//
// Regression: Android's hardware back used to SKIP the open AUQ card - it ran
// the same cancel() the Skip button does, sending no answer at all, from a
// button that is trivially easy to hit by accident. Back now only lowers the
// soft keyboard, then falls through to main.ts's mobile-pane handler (back to
// the session list) with the card left pending.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { handleBack, registerOverlayBack, resetBackButtonForTests } = await import(
  "../src/shared/back-button.ts"
);

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

/** Stand-in for main.ts's mobile-pane handler, which is registered at boot and
 *  so sits BELOW the card in the LIFO overlay stack. */
function registerPaneFallback() {
  const fallback = vi.fn(() => true);
  registerOverlayBack(fallback);
  return fallback;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetBackButtonForTests();
  invokeMock.mockClear();
});

describe("AUQ card vs the phone back button", () => {
  it("with a focused text field, back only blurs it and consumes the press", () => {
    const fallback = registerPaneFallback();
    const opts = baseOpts();
    renderQuestionUI(opts);

    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    handleBack();

    expect(document.activeElement).not.toBe(field);
    expect(opts.onCancel).not.toHaveBeenCalled();
    expect(opts.onSubmit).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("with nothing focused, back leaves the chat instead of skipping the question", () => {
    const fallback = registerPaneFallback();
    const opts = baseOpts();
    renderQuestionUI(opts);

    handleBack();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(opts.onCancel).not.toHaveBeenCalled();
    expect(opts.onSubmit).not.toHaveBeenCalled();
  });

  it("an open lightbox still swallows the press entirely", () => {
    const fallback = registerPaneFallback();
    const opts = baseOpts();
    renderQuestionUI(opts);

    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    document.body.appendChild(overlay);

    handleBack();

    expect(fallback).not.toHaveBeenCalled();
    expect(opts.onCancel).not.toHaveBeenCalled();
  });

  it("Escape still skips the card - only the back button changed", () => {
    const opts = baseOpts();
    renderQuestionUI(opts);

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(opts.onCancel).toHaveBeenCalledTimes(1);
  });
});
