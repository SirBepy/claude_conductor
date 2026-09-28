// @vitest-environment jsdom
//
// Audit finding: DraftsEditor.flush() set `this.saved = markdown` BEFORE
// awaiting the write. If the write rejected, `saved` already equalled the
// current text, so the next flush saw no diff and never retried - the user's
// edit was gone with no signal. This pins the fix: `saved` only advances once
// the write actually resolves, so a failed autosave stays retryable.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { DraftsEditor } = await import("../src/views/sessions/drafts-editor.ts");

function makeDraft(body) {
  return {
    id: "d1",
    topic: "Ship it",
    brief: "",
    receipts: [],
    variants: [
      {
        recipient: "bruno",
        handle_n: 1,
        current: 1,
        versions: [{ n: 1, body, author: "user", note: "", created_at: "2026-09-01T00:00:00Z" }],
      },
    ],
    state: "needs-you",
    origin_session_id: "s1",
    origin_label: "repo",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    seen_by_origin: false,
  };
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("DraftsEditor.flush - a rejected autosave is retryable", () => {
  it("re-sends the same markdown on the next flush after a failed write", async () => {
    invokeMock.mockRejectedValueOnce(new Error("daemon unreachable"));

    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new DraftsEditor(root, makeDraft("original"), {
      sessionId: "s1",
      onBack: () => {},
      onChanged: () => {},
    });

    const body = root.querySelector(".dr-body");
    body.textContent = "edited text";

    editor.flush(); // first attempt - rejects
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("set_draft_body");
    expect(invokeMock.mock.calls[0][1].body).toBe("edited text");

    invokeMock.mockResolvedValueOnce({});
    editor.flush(); // must retry - `saved` never advanced past the failed write
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1][0]).toBe("set_draft_body");
    expect(invokeMock.mock.calls[1][1].body).toBe("edited text");
  });

  it("does not retry once a write has actually succeeded", async () => {
    invokeMock.mockResolvedValueOnce({});

    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new DraftsEditor(root, makeDraft("original"), {
      sessionId: "s1",
      onBack: () => {},
      onChanged: () => {},
    });

    const body = root.querySelector(".dr-body");
    body.textContent = "edited text";

    editor.flush();
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    editor.flush(); // no further edits since the successful write - no-op
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
