// @vitest-environment jsdom
//
// Regression: Android's hardware back used to SKIP the open AUQ card - it ran
// the same cancel() the Skip button does, sending no answer at all, from a
// button that is trivially easy to hit by accident. Back now falls through to
// main.ts's mobile-pane handler (back to the session list) with the card left
// pending. It also used to spend a whole press silently blurring a field whose
// keyboard the IME had already hidden, which read as "back does nothing".

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
  it("with a focused text field, back blurs it AND leaves the chat in the same press", () => {
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
    expect(fallback).toHaveBeenCalledTimes(1);
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

  // Escape used to be the one dismiss key that still skipped; it no longer
  // does either, and its contract now lives in auq-escape-no-skip.test.mjs.
});
