// @vitest-environment jsdom

// Red->green regression: typing with nothing focused lands in the composer
// (Composer._globalKeydown), but Ctrl+V is a modifier chord that handler skips,
// so a paste on a freshly-opened chat used to be swallowed by the browser.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

// Mounting a real Composer pulls its whole module graph plus the slash/file
// command fetch, which runs well past the 5s default on a cold transform.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  localStorage.clear();
  tauriMock();
});

afterEach(() => {
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mount(sessionId = "sess-paste") {
  const { composer, root, textarea } = await mountComposer({}, sessionId);
  return { composer, root, ta: textarea };
}

// jsdom has no ClipboardEvent, and the handler only reads getData/items.
function dispatchPaste(text, items = []) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: { getData: (type) => (type === "text/plain" ? text : ""), items },
  });
  document.dispatchEvent(e);
  return e;
}

describe("paste with nothing focused", () => {
  it("routes into the composer textarea", async () => {
    const { ta } = await mount();
    expect(document.activeElement).not.toBe(ta);

    const e = dispatchPaste("pasted from nowhere");

    expect(ta.value).toBe("pasted from nowhere");
    expect(document.activeElement).toBe(ta);
    expect(e.defaultPrevented).toBe(true);
  });

  it("inserts at the caret rather than replacing the draft", async () => {
    const { ta } = await mount();
    ta.value = "ab";
    ta.focus();
    ta.selectionStart = ta.selectionEnd = 1;
    ta.blur();

    dispatchPaste("X");

    expect(ta.value).toBe("aXb");
    expect(ta.selectionStart).toBe(2);
  });

  it("leaves an unrelated focused field alone", async () => {
    const { ta } = await mount();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();

    const e = dispatchPaste("not mine");

    expect(ta.value).toBe("");
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("sends an oversized paste to the log chip instead of the textarea", async () => {
    const { composer, root, ta } = await mount();
    const wall = "x".repeat(2500);

    dispatchPaste(wall);
    await new Promise((r) => setTimeout(r, 0));

    expect(ta.value).toBe("");
    expect(root.textContent).toContain("pasted_log.txt");
    expect(composer.getDraftBlocks().some((b) => b.type === "text" && b.text.includes(wall))).toBe(true);
  });
});
