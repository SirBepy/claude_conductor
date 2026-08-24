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
