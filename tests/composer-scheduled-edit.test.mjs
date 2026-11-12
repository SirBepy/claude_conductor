// @vitest-environment jsdom

// Editing a scheduled message must not cost the schedule: Send saves the new
// text back onto the same item (onSave, not onSend) and Cancel edit leaves the
// original untouched. A refused save keeps the edit open with the text back.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

beforeAll(async () => {
  await import("../src/shared/transport.ts");
  await import("../src/shared/chat/composer.ts");
}, 30000);

afterEach(() => {
  destroyMounted();
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

const bar = (root) => root.querySelector(".composer-edit-bar");
const sendClick = (root) => root.querySelector(".composer-send").click();

describe("composer scheduled-message edit mode", () => {
  it("shows the bar with the schedule label and the original text", async () => {
    tauriMock();
    const { composer, root, textarea } = await mountComposer();
    composer.beginScheduledEdit("remind me", { label: "Tue 14:00, daily", onSave: vi.fn(async () => {}) });
    expect(bar(root).hidden).toBe(false);
    expect(bar(root).textContent).toContain("Tue 14:00, daily");
    expect(textarea.value).toBe("remind me");
  });

  it("Send saves onto the schedule instead of sending now, then leaves edit mode", async () => {
    tauriMock();
    const onSend = vi.fn(async () => {});
    const onSave = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSend });
    composer.beginScheduledEdit("remind me", { label: "x", onSave });
    textarea.value = "remind me twice";
    sendClick(root);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([{ type: "text", text: "remind me twice" }]);
    expect(onSend).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(bar(root).hidden).toBe(true));
    expect(textarea.value).toBe("");
  });

  it("a refused save keeps the edit open and puts the text back", async () => {
    tauriMock();
    const onSend = vi.fn(async () => {});
    const onSave = vi.fn(async () => {
      throw new Error("nope");
    });
    const { composer, root, textarea } = await mountComposer({ onSend });
    vi.spyOn(console, "error").mockImplementation(() => {});
    composer.beginScheduledEdit("remind me", { label: "x", onSave });
    sendClick(root);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    await vi.waitFor(() => expect(textarea.value).toBe("remind me"));
    expect(bar(root).hidden).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("an open edit never reaches storage or the draft sync, so a reload cannot bring it back as a draft", async () => {
    const invoke = tauriMock();
    const { composer, textarea } = await mountComposer();
    composer.beginScheduledEdit("remind me", { label: "x", onSave: vi.fn(async () => {}) });
    textarea.value = "remind me, edited";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));

    const { loadDraft } = await import("../src/shared/chat/composer-persistence.ts");
    expect(loadDraft("sess-1")).toBe("");
    destroyMounted(); // flushes the draft sync's debounce, as a teardown does
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "set_composer_draft")).toEqual([]);

    // The chat reopening after a reload that skipped nothing: an empty box, no edit bar.
    const next = await mountComposer();
    expect(next.textarea.value).toBe("");
    expect(bar(next.root).hidden).toBe(true);
  });

  it("an edit abandoned by a teardown leaves the draft that was stored before it untouched", async () => {
    tauriMock();
    const { composer, textarea } = await mountComposer();
    textarea.value = "half-written note";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    composer.beginScheduledEdit("remind me", { label: "x", onSave: vi.fn(async () => {}) });
    destroyMounted();

    const next = await mountComposer();
    expect(next.textarea.value).toBe("half-written note");
    expect(bar(next.root).hidden).toBe(true);
  });

  it("Cancel edit clears the draft and never saves or sends", async () => {
    tauriMock();
    const onSend = vi.fn(async () => {});
    const onSave = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSend });
    composer.beginScheduledEdit("remind me", { label: "x", onSave });
    root.querySelector(".composer-edit-cancel").click();
    expect(bar(root).hidden).toBe(true);
    expect(textarea.value).toBe("");
    sendClick(root);
    expect(onSave).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("the Send menu offers no Schedule while an edit is open, so no second item can be made", async () => {
    tauriMock();
    const onSchedule = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSchedule });
    composer.beginScheduledEdit("remind me", { label: "x", onSave: vi.fn(async () => {}) });
    textarea.value = "remind me";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    root.querySelector(".composer-send").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const rows = [...document.querySelectorAll(".composer-menu-popover [data-idx]")];
    expect(rows.some((b) => b.textContent.includes("Schedule message"))).toBe(false);
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("an item that fired or was deleted ends the edit and keeps the text as a plain draft", async () => {
    tauriMock();
    const { ScheduledEditGoneError } = await import("../src/shared/chat/scheduled-edit-gone.ts");
    const onSend = vi.fn(async () => {});
    const onSave = vi.fn(async () => {
      throw new ScheduledEditGoneError();
    });
    const { composer, root, textarea } = await mountComposer({ onSend });
    vi.spyOn(console, "error").mockImplementation(() => {});
    composer.beginScheduledEdit("remind me", { label: "x", onSave });
    sendClick(root);
    await vi.waitFor(() => expect(bar(root).hidden).toBe(true));
    expect(textarea.value).toBe("remind me");
    sendClick(root);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
