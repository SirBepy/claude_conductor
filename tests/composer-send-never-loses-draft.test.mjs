// @vitest-environment jsdom

// Red->green regression: pressing Enter must never destroy the typed text.
// Every branch of Composer.send() clears the box, and three could end without
// the message reaching the daemon - a swallowed rejection, and an unattached
// held controller in either onStage or flushHeldWithDraft.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each case mounts a real Composer, whose first-time module graph + slash/file
// command fetch runs well past the 5s default on a cold transform.
vi.setConfig({ testTimeout: 30000 });

let invokeMock;
let mounted = [];

beforeEach(() => {
  localStorage.clear();
  invokeMock = vi.fn(async (cmd) => {
    if (cmd === "list_slash_commands") return [];
    if (cmd === "list_project_files") return [];
    return {};
  });
  globalThis.window.__TAURI__ = {
    core: { invoke: invokeMock },
    event: { listen: async () => () => {} },
  };
});

afterEach(() => {
  for (const composer of mounted) composer.destroy();
  mounted = [];
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mountComposer(opts = {}, sessionId = "sess-1") {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { Composer } = await import("../src/shared/chat/composer.ts");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const composer = new Composer(root, { onSend: vi.fn(async () => {}), ...opts });
  mounted.push(composer);
  composer.setSessionId(sessionId);
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  const textarea = root.querySelector(".composer-textarea");
  return { composer, textarea, root };
}

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function pressKey(textarea, key, init = {}) {
  textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

describe("composer send never loses the draft", () => {
  it("puts the text back when onSend rejects", async () => {
    const onSend = vi.fn(async () => { throw new Error("daemon gone"); });
    const { textarea } = await mountComposer({ onSend });

    typeInto(textarea, "the message I do not want to retype");
    pressKey(textarea, "Enter");

    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    await vi.waitFor(() => expect(textarea.value).toBe("the message I do not want to retype"));
  });

  it("keeps the text when the held controller refuses to stage it", async () => {
    const onSend = vi.fn(async () => {});
    const onStage = vi.fn(() => false);
    const { textarea } = await mountComposer({ onSend, onStage, isBusy: () => true });

    typeInto(textarea, "staged while busy");
    pressKey(textarea, "Enter");

    await vi.waitFor(() => expect(onStage).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("staged while busy");
  });

  it("clears only once the held controller has taken the message", async () => {
    const onStage = vi.fn(() => true);
    const { textarea } = await mountComposer({ onStage, isBusy: () => true });

    typeInto(textarea, "staged while busy");
    pressKey(textarea, "Enter");

    await vi.waitFor(() => expect(onStage).toHaveBeenCalled());
    await vi.waitFor(() => expect(textarea.value).toBe(""));
  });

  it("puts the text back when a held flush had no session to flush into", async () => {
    const flushHeldWithDraft = vi.fn(async () => false);
    const { textarea } = await mountComposer({ hasHeld: () => true, flushHeldWithDraft });

    typeInto(textarea, "bundled with the queue");
    pressKey(textarea, "Enter");

    await vi.waitFor(() => expect(flushHeldWithDraft).toHaveBeenCalled());
    await vi.waitFor(() => expect(textarea.value).toBe("bundled with the queue"));
  });
});

describe("sent-outbox recovery", () => {
  it("Ctrl+Z pulls back a message that already sent successfully", async () => {
    const onSend = vi.fn(async () => {});
    const { textarea } = await mountComposer({ onSend });

    typeInto(textarea, "first one");
    pressKey(textarea, "Enter");
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    typeInto(textarea, "second one");
    pressKey(textarea, "Enter");
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    pressKey(textarea, "z", { ctrlKey: true });
    expect(textarea.value).toBe("second one");
  });

  it("prefers the held queue, then falls through to the outbox", async () => {
    const popLastHeld = vi.fn(() => null);
    const { textarea } = await mountComposer({ onSend: vi.fn(async () => {}), popLastHeld });

    typeInto(textarea, "sent and gone");
    pressKey(textarea, "Enter");
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    pressKey(textarea, "z", { ctrlKey: true });
    expect(popLastHeld).toHaveBeenCalled();
    expect(textarea.value).toBe("sent and gone");
  });

  it("declines the keystroke once nothing is left to pop", async () => {
    const { textarea } = await mountComposer({ onSend: vi.fn(async () => {}) });

    typeInto(textarea, "only one");
    pressKey(textarea, "Enter");
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    pressKey(textarea, "z", { ctrlKey: true });
    expect(textarea.value).toBe("only one");
    typeInto(textarea, "");
    pressKey(textarea, "z", { ctrlKey: true });
    expect(textarea.value).toBe("");
  });
});

describe("sent-outbox store", () => {
  it("caps history, dedupes a repeat, and survives an id rename", async () => {
    const { recordSent, popLastSent, moveSentOutbox } = await import("../src/shared/chat/sent-outbox.ts");

    for (let i = 0; i < 25; i++) recordSent("s1", `msg ${i}`);
    recordSent("s1", "msg 24");
    expect(popLastSent("s1")).toBe("msg 24");
    expect(popLastSent("s1")).toBe("msg 23");

    moveSentOutbox("s1", "s2");
    expect(popLastSent("s1")).toBeNull();
    expect(popLastSent("s2")).toBe("msg 22");
  });
});
