// @vitest-environment jsdom
// Red->green regression for composer draft sync: debounce coalescing,
// immediate flush on blur, and the load-bearing focused-input rule (a
// reconciled remote draft must never clobber text the user is typing).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let invokeMock;
let mounted = [];

beforeEach(() => {
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
  vi.useRealTimers();
});

async function mountComposer() {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { Composer } = await import("../src/shared/chat/composer.ts");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const composer = new Composer(root, { onSend: vi.fn(async () => {}) });
  mounted.push(composer);
  composer.setSessionId("sess-1");
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  invokeMock.mockClear();
  const textarea = root.querySelector(".composer-textarea");
  return { composer, textarea, root };
}

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function draftPushCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "set_composer_draft");
}

/** Fire the same visibilitychange path setSessionId's reconcile-on-open uses,
 *  without re-invoking setSessionId (which rebuilds the composer's DOM and
 *  would invalidate the test's textarea reference / drop jsdom focus). */
function regainVisibility() {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange"));
}

describe("Composer draft sync - debounce coalescing", () => {
  it("coalesces rapid keystrokes into a single set_composer_draft call", async () => {
    const { textarea } = await mountComposer();
    vi.useFakeTimers();

    typeInto(textarea, "h");
    typeInto(textarea, "he");
    typeInto(textarea, "hel");
    typeInto(textarea, "hello");
    expect(draftPushCalls().length).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(draftPushCalls().length).toBe(1);
    expect(draftPushCalls()[0][1]).toMatchObject({ sessionId: "sess-1", text: "hello" });
  });
});

describe("Composer draft sync - flush on blur", () => {
  it("fires the pending write immediately on blur, bypassing the 500ms wait", async () => {
    const { textarea } = await mountComposer();
    vi.useFakeTimers();

    typeInto(textarea, "typed then blurred");
    expect(draftPushCalls().length).toBe(0);

    textarea.dispatchEvent(new window.Event("blur", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(draftPushCalls().length).toBe(1);
    expect(draftPushCalls()[0][1]).toMatchObject({ text: "typed then blurred" });
  });
});

describe("Composer draft sync - focused-input rule", () => {
  it("does NOT overwrite the textarea while it is focused, even when a newer remote draft arrives", async () => {
    const { textarea } = await mountComposer();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_session_drafts") {
        return { composer: { text: "REMOTE TEXT FROM ANOTHER DEVICE", updated_at: "2099-01-01T00:00:00Z" }, auq: null, held: [], held_updated_at: null };
      }
      return {};
    });

    textarea.value = "my own in-progress text";
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    regainVisibility();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_drafts", expect.anything()));
    // Let the reconcile's microtasks settle without giving it a chance to win a race.
    await new Promise((r) => setTimeout(r, 20));

    expect(textarea.value).toBe("my own in-progress text");
  });

  it("DOES apply the remote draft once the textarea is no longer focused", async () => {
    const { textarea } = await mountComposer();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_session_drafts") {
        return { composer: { text: "REMOTE TEXT", updated_at: "2099-01-01T00:00:00Z" }, auq: null, held: [], held_updated_at: null };
      }
      return {};
    });

    textarea.value = "";
    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);

    regainVisibility();
    await vi.waitFor(() => expect(textarea.value).toBe("REMOTE TEXT"));
  });
});
