// @vitest-environment jsdom
//
// Regression: picking an option rebuilds the card's innerHTML, which replaced
// the scrolling .prompt-panel and snapped a long question back to the top on
// every pick. render() now carries each panel's scrollTop across the rebuild.

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
  invokeMock.mockClear();
});

describe("AUQ card scroll", () => {
  it("picking an option keeps the panel's scroll position", () => {
    renderQuestionUI({
      questions: [{
        question: "Pick one?",
        header: "Choice",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      }],
      titleText: "Question",
      titleIcon: "ph-question",
      cancelLabel: "Skip",
      submitLabel: "Submit",
      submitIcon: "ph-check",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    });

    const before = document.querySelector('.prompt-panel[data-panel="0"]');
    before.scrollTop = 120;

    const input = document.querySelector(".prompt-q__opts input");
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const after = document.querySelector('.prompt-panel[data-panel="0"]');
    expect(after).not.toBe(before);
    expect(after.scrollTop).toBe(120);
  });
});
