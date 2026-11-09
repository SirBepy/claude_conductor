// @vitest-environment jsdom

// An accidental Enter can be taken back: a send waits out a grace window behind
// an Undo bar, so claude never receives an undone message (it starts answering
// the instant it does). Undo puts the text back in FRONT of whatever was typed
// meanwhile, a second send fires the first, and a zero window sends at once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer as mountComposerBase, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

let invokeMock;

beforeEach(() => {
  localStorage.clear();
  invokeMock = tauriMock();
});

afterEach(async () => {
  const { flushAllGrace } = await import("../src/shared/chat/send-grace.ts");
  flushAllGrace();
  destroyMounted();
  vi.useRealTimers();
  globalThis.__ccSendGraceMs = 0;
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mountWithGrace(opts = {}, graceMs = 3000) {
  const m = await mountComposerBase(opts);
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  globalThis.__ccSendGraceMs = graceMs;
  return m;
}

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function pressKey(textarea, key, init = {}) {
  textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

const undoBtn = (root) => root.querySelector(".send-grace-undo");

describe("send grace window", () => {
  it("holds the send behind an Undo bar until the window lapses", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountWithGrace({ onSend });
    typeInto(textarea, "oops, not finished");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    expect(undoBtn(root)).not.toBeNull();
    expect(root.querySelector(".send-grace-label").textContent).toContain("oops, not finished");

    vi.advanceTimersByTime(2999);
    expect(onSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(undoBtn(root)).toBeNull();
  });

  it("Undo cancels the send and puts the text back in front of what was typed since", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountWithGrace({ onSend });
    typeInto(textarea, "sent too early");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    typeInto(textarea, "and this is what I was already typing");

    undoBtn(root).click();
    vi.advanceTimersByTime(10_000);

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("sent too early\n\nand this is what I was already typing");
    expect(undoBtn(root)).toBeNull();
  });

  it("Ctrl+Z inside the window is the same Undo, and the next one does not offer it again", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea } = await mountWithGrace({ onSend });
    typeInto(textarea, "first");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    pressKey(textarea, "z", { ctrlKey: true });

    expect(textarea.value).toBe("first");
    pressKey(textarea, "z", { ctrlKey: true });
    expect(textarea.value).toBe("first");
    vi.advanceTimersByTime(10_000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a second send fires the first at once so order holds", async () => {
    const sent = [];
    const onSend = vi.fn(async (blocks) => { sent.push(blocks[0].text); });
    const { textarea } = await mountWithGrace({ onSend });
    vi.useFakeTimers();
    typeInto(textarea, "one");
    pressKey(textarea, "Enter");
    await vi.advanceTimersByTimeAsync(0); // the first send has released its re-entry guard
    typeInto(textarea, "two");
    pressKey(textarea, "Enter");

    expect(sent).toEqual(["one"]);
    vi.advanceTimersByTime(3001);
    expect(sent).toEqual(["one", "two"]);
  });

  it("a zero window sends at once with no bar", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountWithGrace({ onSend }, 0);
    typeInto(textarea, "now");
    pressKey(textarea, "Enter");

    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(undoBtn(root)).toBeNull();
  });

  it("a failed delayed send puts the text back without clobbering a newer draft", async () => {
    const onSend = vi.fn(async () => { throw new Error("daemon gone"); });
    const { textarea } = await mountWithGrace({ onSend });
    typeInto(textarea, "lost send");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    typeInto(textarea, "newer words");
    await vi.advanceTimersByTimeAsync(3001);

    expect(textarea.value).toBe("lost send\n\nnewer words");
  });
});
