// @vitest-environment jsdom
//
// The phone question page's send arrow forwards a click to the footer's
// primary button, which is Next on a non-final question. The arrow carries
// that button's label and is disabled whenever it is, so it never reads as
// "Send" while it only advances, or looks live while the click does nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/shared/mobile-viewport.ts", () => ({
  MOBILE_MQ: "(max-width: 768px)",
  isMobileViewport: () => true,
  onMobileViewportChange: () => () => {},
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

function opts() {
  return {
    questions: [
      { question: "First?", header: "One", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second?", header: "Two", options: [{ label: "C" }, { label: "D" }] },
    ],
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
  };
}

const arrow = () => document.querySelector(".prompt-answer-send");
const primary = () => document.querySelector('.prompt-card__footer [data-act="primary"]');

function type(text) {
  const field = document.querySelector(".prompt-q__other-input");
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '<div class="session-pane"></div>';
});

describe("phone question page send arrow", () => {
  it("is labelled Next on a non-final question and enables once text is typed", () => {
    renderQuestionUI(opts());
    expect(arrow()).not.toBeNull();
    expect(arrow().disabled).toBe(true);
    type("my own answer");
    expect(primary().disabled).toBe(false);
    expect(arrow().disabled).toBe(false);
    expect(arrow().title).toBe("Next");
  });

  it("stays disabled while the primary button is, even with text typed", () => {
    renderQuestionUI(opts());
    // Pin the primary disabled so updatePrimaryButton's own write is ignored;
    // the arrow must follow it on the next keystroke.
    Object.defineProperty(primary(), "disabled", { get: () => true, set: () => {}, configurable: true });
    type("xy");
    expect(arrow().disabled).toBe(true);
  });
});
