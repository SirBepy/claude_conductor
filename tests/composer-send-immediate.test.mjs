// @vitest-environment jsdom
// asserts: src/shared/chat/composer.ts

// Send reaches onSend the moment Enter or the button is pressed: no hold window,
// no Undo button over Send. A failed send still puts the text back.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  localStorage.clear();
  tauriMock();
  // A timer-based hold would leave onSend uncalled however long a test waits.
  vi.useFakeTimers();
});

afterEach(() => {
  destroyMounted();
  vi.useRealTimers();
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function pressEnter(textarea) {
  textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

describe("composer send", () => {
  it("calls onSend at once on Enter, with no Undo button and no pending timer", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountComposer({ onSend });
    typeInto(textarea, "hello now");
    pressEnter(textarea);

    // No timer advanced, no await past the handler: a hold window would fail here.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0][0].text).toBe("hello now");
    expect(textarea.value).toBe("");
    expect(root.querySelector(".send-grace-undo")).toBeNull();
  });

  it("calls onSend at once on a Send button click", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountComposer({ onSend });
    typeInto(textarea, "via the button");
    root.querySelector(".composer-send").click();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".send-grace-undo")).toBeNull();
  });

  it("lets the next message go while the first onSend is still in flight", async () => {
    let release;
    const onSend = vi.fn(() => new Promise((r) => { release = r; }));
    const { textarea } = await mountComposer({ onSend });
    typeInto(textarea, "first");
    pressEnter(textarea);
    typeInto(textarea, "second");
    pressEnter(textarea);

    expect(onSend.mock.calls.map((c) => c[0][0].text)).toEqual(["first", "second"]);
    release();
  });

  it("puts the text back when the send fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onSend = vi.fn(async () => { throw new Error("daemon gone"); });
    const { textarea } = await mountComposer({ onSend });
    typeInto(textarea, "lost send");
    pressEnter(textarea);
    await vi.advanceTimersByTimeAsync(0);

    expect(textarea.value).toBe("lost send");
  });

  it("a frozen chat's Send now clears the box quietly, so the quick-reply strip does not return over the in-flight send", async () => {
    vi.useRealTimers();
    const onSend = vi.fn(async () => {});
    const onAttachmentsChange = vi.fn();
    const { textarea, root } = await mountComposer({ onSend, isFrozen: () => true, onAttachmentsChange });
    typeInto(textarea, "unfreeze me");
    root.querySelector(".composer-send").click();
    await vi.waitFor(() => expect(document.querySelector("[data-choice='now']")).toBeTruthy());
    onAttachmentsChange.mockClear();
    document.querySelector("[data-choice='now']").click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(textarea.value).toBe("");
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});
