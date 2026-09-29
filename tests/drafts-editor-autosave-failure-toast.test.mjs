// @vitest-environment jsdom
//
// Todo 1017: DraftsEditor.flush() retried a failed autosave silently
// (console.error only) - a broken connection gave no signal beyond the
// console. Now three CONSECUTIVE failures show one toast (not one per
// retry), and a success resets the counter so a later run of failures gets
// its own toast.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

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

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
});

function editWith(root, text) {
  const body = root.querySelector(".dr-body");
  body.textContent = text;
}

describe("DraftsEditor autosave - one toast after 3 consecutive failures", () => {
  it("does not toast on the 1st or 2nd consecutive failure, toasts once on the 3rd", async () => {
    invokeMock.mockRejectedValue(new Error("daemon unreachable"));

    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new DraftsEditor(root, makeDraft("original"), {
      sessionId: "s1", onBack: () => {}, onChanged: () => {},
    });

    editWith(root, "edit 1");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).not.toHaveBeenCalled();

    editWith(root, "edit 2");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).not.toHaveBeenCalled();

    editWith(root, "edit 3");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).toHaveBeenCalledTimes(1);

    // A 4th consecutive failure must not toast again.
    editWith(root, "edit 4");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("resets the failure count on a successful save", async () => {
    invokeMock.mockRejectedValueOnce(new Error("daemon unreachable"));
    invokeMock.mockRejectedValueOnce(new Error("daemon unreachable"));
    invokeMock.mockResolvedValueOnce({});

    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new DraftsEditor(root, makeDraft("original"), {
      sessionId: "s1", onBack: () => {}, onChanged: () => {},
    });

    editWith(root, "edit 1");
    editor.flush();
    await flushMicrotasks();

    editWith(root, "edit 2");
    editor.flush();
    await flushMicrotasks();

    editWith(root, "edit 3 (succeeds)");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).not.toHaveBeenCalled(); // 2 failures then a success - never hit 3

    invokeMock.mockRejectedValue(new Error("daemon unreachable"));
    editWith(root, "edit 4");
    editor.flush();
    await flushMicrotasks();
    editWith(root, "edit 5");
    editor.flush();
    await flushMicrotasks();
    editWith(root, "edit 6");
    editor.flush();
    await flushMicrotasks();
    expect(toastMock).toHaveBeenCalledTimes(1); // fresh run of 3 after the reset
  });
});
