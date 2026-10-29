// @vitest-environment jsdom
//
// Red->green regression (reported 2026-10-29): a pasted image on the question
// card only appeared once its upload finished, and a Submit pressed before
// then shipped the answer without it (no path yet). The chip must show at
// once as uploading, and Submit must wait for the upload.

import { describe, it, expect, vi, beforeEach } from "vitest";

const UPLOADED = "/data/chat-attachments/sess-1/paste.png";

const { invokeMock, upload } = vi.hoisted(() => {
  const upload = { resolve: null, promise: null };
  return { upload, invokeMock: vi.fn() };
});
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

function pastePng(target) {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "paste.png", { type: "image/png" });
  const evt = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(evt, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" },
  });
  target.dispatchEvent(evt);
}

beforeEach(() => {
  document.body.innerHTML = "";
  upload.promise = new Promise((r) => { upload.resolve = r; });
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd) => (cmd === "paste_attachment" ? upload.promise : Promise.resolve([])));
});

describe("AUQ card attachment upload progress", () => {
  it("shows the chip as uploading and holds Submit until the upload lands", async () => {
    const onSubmit = vi.fn();
    renderQuestionUI({
      questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
      sessionId: "sess-1",
      supportsExtras: true,
      titleIcon: "ph-question",
      cancelLabel: "Skip",
      submitLabel: "Submit",
      submitIcon: "ph-check",
      onCancel: vi.fn(),
      onSubmit,
    });
    const ta = document.querySelector(".prompt-q__other-input");
    ta.focus();
    pastePng(ta);

    await vi.waitFor(() => expect(document.querySelector(".prompt-attachments .attachment.uploading")).toBeTruthy());
    expect(document.querySelector(".prompt-attachments .attachment-progress")).toBeTruthy();

    document.querySelector('.prompt-panel[data-panel="0"] input[data-label="A"]').click();
    // Next to review, then Submit. A second click while held is ignored.
    document.querySelector('[data-act="primary"]').click();
    document.querySelector('[data-act="primary"]')?.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).not.toHaveBeenCalled();

    upload.resolve(UPLOADED);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].attachments.map((a) => a.path)).toEqual([UPLOADED]);
  });
});
