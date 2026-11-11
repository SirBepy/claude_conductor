// @vitest-environment jsdom

// An accidental Enter can be taken back: a send waits out a grace window behind
// a small Undo button over Send, so claude never receives an undone message (it starts answering
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
  it("holds the send behind an Undo button until the window lapses", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea, root } = await mountWithGrace({ onSend });
    typeInto(textarea, "oops, not finished");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    expect(undoBtn(root)).not.toBeNull();
    expect(undoBtn(root).title).toContain("oops, not finished");
    // It covers Send itself, so the composer layout does not move.
    expect(undoBtn(root).parentElement.classList.contains("composer-send-wrap")).toBe(true);

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

describe("a held send and its composer's lifetime", () => {
  it("tearing the composer down inside the window sends at once instead of orphaning an Undo", async () => {
    const onSend = vi.fn(async () => {});
    const { composer, textarea } = await mountWithGrace({ onSend });
    typeInto(textarea, "switching away now");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    expect(onSend).not.toHaveBeenCalled();

    composer.destroy();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0][0].text).toBe("switching away now");

    // The chat's next composer has no Undo to offer and nothing left to send.
    const next = await mountWithGrace({ onSend });
    expect(undoBtn(next.root)).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a send that fails after the teardown keeps its text in the chat's stored draft", async () => {
    const onSend = vi.fn(async () => { throw new Error("daemon gone"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { composer, textarea } = await mountWithGrace({ onSend });
    typeInto(textarea, "must survive");
    pressKey(textarea, "Enter");
    composer.destroy();

    const { loadDraft } = await import("../src/shared/chat/composer-persistence.ts");
    await vi.waitFor(() => expect(loadDraft("sess-1")).toBe("must survive"));
  });

  it("destroying a composer does not fire a send another composer is holding", async () => {
    const onSend = vi.fn(async () => {});
    const a = await mountWithGrace({ onSend });
    const b = await mountWithGrace({ onSend: vi.fn(async () => {}) });
    typeInto(a.textarea, "held by a");
    vi.useFakeTimers();
    pressKey(a.textarea, "Enter");

    b.composer.destroy();
    expect(onSend).not.toHaveBeenCalled();
    expect(undoBtn(a.root)).not.toBeNull();
  });

  it("a rename inside the window keeps the Undo button, Ctrl+Z and the timer working", async () => {
    const onSend = vi.fn(async () => {});
    const { composer, textarea, root } = await mountWithGrace({ onSend });
    typeInto(textarea, "first message of a new chat");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    await vi.advanceTimersByTimeAsync(0); // the send has released its re-entry guard
    composer.setSessionId("real-1");

    const btn = undoBtn(root);
    expect(btn).not.toBeNull();
    btn.click();
    expect(onSend).not.toHaveBeenCalled();
    expect(root.querySelector(".composer-textarea").value).toBe("first message of a new chat");

    // Same again, left alone: the timer still fires under the new id.
    pressKey(root.querySelector(".composer-textarea"), "Enter");
    await vi.advanceTimersByTimeAsync(3001);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Z after a rename undoes the held send", async () => {
    const onSend = vi.fn(async () => {});
    const { composer, textarea, root } = await mountWithGrace({ onSend });
    typeInto(textarea, "renamed then undone");
    vi.useFakeTimers();
    pressKey(textarea, "Enter");
    composer.setSessionId("real-2");

    const box = root.querySelector(".composer-textarea");
    pressKey(box, "z", { ctrlKey: true });
    expect(box.value).toBe("renamed then undone");
    vi.advanceTimersByTime(10_000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a send in a chat fires that chat's held card answer first, and a card answer on another chat stays put", async () => {
    const { startGrace } = await import("../src/shared/chat/send-grace.ts");
    const order = [];
    const onSend = vi.fn(async (blocks) => { order.push(`send:${blocks[0].text}`); });
    const { textarea } = await mountWithGrace({ onSend });
    vi.useFakeTimers();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const card = (key) => startGrace({ key, label: "Answer", mount, fire: () => { order.push(`card:${key}`); }, onUndo: () => {} });
    await card("sess-1");
    await card("other-chat");

    typeInto(textarea, "after the card");
    pressKey(textarea, "Enter");

    expect(order).toEqual(["card:sess-1"]);
    await vi.advanceTimersByTimeAsync(3001);
    expect(order).toEqual(["card:sess-1", "card:other-chat", "send:after the card"]);
    mount.remove();
  });
});
