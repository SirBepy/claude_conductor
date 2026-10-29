// @vitest-environment jsdom
//
// Regression: a question card that appeared left the keyboard on the chat
// composer, so typing went to the composer instead of the question. The first
// render now moves focus to the card's first option.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AUQ card focus", () => {
  it("takes focus from the composer when it appears", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    renderQuestionUI({
      questions: [{
        question: "Pick one?",
        header: "Choice",
        multiSelect: false,
        options: [{ label: "A" }, { label: "B" }],
      }],
      titleText: "Question",
      titleIcon: "ph-question",
      cancelLabel: "Skip",
      submitLabel: "Submit",
      submitIcon: "ph-check",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    });

    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement?.closest(".prompt-q__opts")).not.toBeNull();
  });
});
