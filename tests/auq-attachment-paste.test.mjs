// @vitest-environment jsdom
//
// Reported bug (2026-08-14): "im no longer able to paste images in question
// cards" - the built-in card never sets supportsExtras, so paste silently no-ops.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue("C:\\fake\\chat-attachments\\s1\\paste.png") }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

function baseOpts(overrides = {}) {
  return {
    questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
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

// A real ClipboardEvent-shaped paste: one DataTransferItem of kind "file",
// type "image/png" - the shape resolveClipboardAttachments reads.
function pastePngEvent() {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "paste.png", { type: "image/png" });
  const evt = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(evt, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" },
  });
  return evt;
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("AUQ card paste-to-attach", () => {
  it("attaches a pasted image end-to-end on the MCP path (supportsExtras: true)", async () => {
    renderQuestionUI(baseOpts({ supportsExtras: true }));
    const ta = document.querySelector(".prompt-q__other-input");
    expect(ta).toBeTruthy();

    ta.dispatchEvent(pastePngEvent());

    await vi.waitFor(() => {
      expect(document.querySelector(".prompt-attachments img")).toBeTruthy();
    });
  });

  it("gives visible feedback (not silence) when pasting on a card that can't accept attachments", async () => {
    renderQuestionUI(baseOpts()); // supportsExtras omitted - the built-in-tool card's shape
    const ta = document.querySelector(".prompt-q__other-input");
    expect(ta).toBeTruthy();

    ta.dispatchEvent(pastePngEvent());

    await vi.waitFor(() => {
      expect(document.querySelector(".prompt-paste-hint")).toBeTruthy();
    });
    expect(document.querySelector(".prompt-attachments img")).toBeNull();
  });
});

// Reported bug (2026-09-02): a pasted image only appeared after navigating to
// another step and back, and once it did it showed on EVERY step.
describe("AUQ card attachment placement", () => {
  it("renders a pasted image immediately while the answer field still has focus", async () => {
    renderQuestionUI(baseOpts({ supportsExtras: true }));
    const ta = document.querySelector(".prompt-q__other-input");
    ta.focus();
    expect(document.activeElement).toBe(ta);

    ta.dispatchEvent(pastePngEvent());

    await vi.waitFor(() => {
      expect(document.querySelector('.prompt-attachments[data-attach-panel="0"] img')).toBeTruthy();
    });
  });

  it("keeps the thumbnail on the step it was pasted into and chips it on review", async () => {
    renderQuestionUI(baseOpts({
      supportsExtras: true,
      questions: [
        { question: "Q1?", header: "One", options: [{ label: "A" }] },
        { question: "Q2?", header: "Two", options: [{ label: "B" }] },
      ],
    }));

    document.querySelector('.prompt-dot[data-dot="1"]').click();
    const ta = document.querySelector(".prompt-q__other-input");
    ta.focus();
    ta.dispatchEvent(pastePngEvent());

    await vi.waitFor(() => {
      expect(document.querySelector('.prompt-attachments[data-attach-panel="1"] img')).toBeTruthy();
    });
    expect(document.querySelector('.prompt-attachments[data-attach-panel="0"] img')).toBeNull();

    document.querySelector('.prompt-dot[data-dot="2"]').click();
    expect(document.querySelector('.prompt-summary-row[data-summary-tab="1"] .prompt-summary-row__attach')).toBeTruthy();
    expect(document.querySelector('.prompt-summary-row[data-summary-tab="0"] .prompt-summary-row__attach')).toBeNull();
    expect(document.querySelector('.prompt-attachments[data-attach-panel="2"] img')).toBeNull();
  });
});
