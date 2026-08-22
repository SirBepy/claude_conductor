// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ComposerCore } from "../src/shared/chat/composer-core/core.ts";
import { setSlashEntries } from "../src/shared/chat/slash-registry.ts";

function mount(root, opts) {
  const wrap = document.createElement("div");
  const highlightEl = document.createElement("div");
  const ta = document.createElement("textarea");
  wrap.appendChild(highlightEl);
  wrap.appendChild(ta);
  (root ?? document.body).appendChild(wrap);
  return { core: new ComposerCore({ textarea: ta, highlightEl, anchor: wrap, ...opts }), ta, highlightEl, wrap };
}

describe("ComposerCore highlight", () => {
  it("paints a known /skill token as a colored cm-slash span", () => {
    setSlashEntries([{ name: "close", source: { kind: "user-skill" } }]);
    const { core, ta, highlightEl } = mount();
    ta.value = "/close please";
    core.updateHighlight();
    expect(highlightEl.innerHTML).toContain("cm-slash");
    expect(highlightEl.innerHTML).toContain("cm-slash-user-skill");
    setSlashEntries([]);
  });

  it("leaves an unknown /token plain (no cm-slash span)", () => {
    setSlashEntries([]);
    const { core, ta, highlightEl } = mount();
    ta.value = "/notarealcommand";
    core.updateHighlight();
    expect(highlightEl.innerHTML).not.toContain("cm-slash");
  });

  it("computeHighlightHtml override bypasses the default painter", () => {
    const wrap = document.createElement("div");
    const highlightEl = document.createElement("div");
    const ta = document.createElement("textarea");
    wrap.append(highlightEl, ta);
    document.body.appendChild(wrap);
    const core = new ComposerCore({
      textarea: ta,
      highlightEl,
      anchor: wrap,
      computeHighlightHtml: () => '<span class="custom">x</span>',
    });
    ta.value = "anything";
    core.updateHighlight();
    expect(highlightEl.innerHTML).toBe('<span class="custom">x</span>');
  });

  it("no-ops when no highlightEl was supplied", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    const core = new ComposerCore({ textarea: ta });
    expect(() => core.updateHighlight()).not.toThrow();
  });
});

describe("ComposerCore paste routing", () => {
  it("forwards a paste event to the supplied adapter", () => {
    const handlePaste = vi.fn();
    const { ta } = mount(undefined, { paste: { handlePaste } });
    const evt = new Event("paste");
    Object.defineProperty(evt, "clipboardData", { value: { items: [] } });
    ta.dispatchEvent(evt);
    expect(handlePaste).toHaveBeenCalledTimes(1);
    expect(handlePaste.mock.calls[0][0]).toBe(evt);
  });

  it("does not attach a paste listener when no adapter is given", () => {
    const { ta } = mount();
    // No adapter -> dispatching paste must not throw and nothing to assert
    // beyond "no crash", since there's no adapter to have been called.
    expect(() => ta.dispatchEvent(new Event("paste"))).not.toThrow();
  });
});

describe("ComposerCore popup lifecycle", () => {
  it("destroy() is idempotent", () => {
    const { core } = mount();
    expect(() => {
      core.destroy();
      core.destroy();
    }).not.toThrow();
  });

  it("destroy() is safe after the textarea leaves the DOM", () => {
    const { core, wrap } = mount();
    wrap.remove();
    expect(() => core.destroy()).not.toThrow();
  });

  it("mounts a popup only when providers are given", () => {
    const provider = {
      triggerChar: "/",
      shouldTrigger: () => false,
      query: () => [],
      renderRow: () => document.createElement("div"),
      onPick: vi.fn(),
    };
    const { wrap: wrapNoProvider } = mount();
    expect(wrapNoProvider.querySelector(".caret-popup")).toBeNull();

    const { wrap: wrapWithProvider } = mount(undefined, { providers: [provider] });
    expect(wrapWithProvider.querySelector(".caret-popup")).not.toBeNull();
  });

  it("closes the popup when the caret moves off the token without typing", () => {
    const provider = {
      triggerChar: "/",
      shouldTrigger: ({ textBefore }) => /(^|\s)\/[^\s]*$/.test(textBefore),
      query: (t) => (t ? ["close"] : []),
      renderRow: () => document.createElement("div"),
      onPick: vi.fn(),
    };
    const { ta, wrap } = mount(undefined, { providers: [provider] });
    ta.value = "/close say hi";
    ta.selectionStart = ta.selectionEnd = 6;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(wrap.querySelector(".caret-popup").hidden).toBe(false);

    // Move the caret past "say" via a click - no "input" event fires, but the
    // popup must still resync and close since the caret left the /-token.
    ta.selectionStart = ta.selectionEnd = 13;
    ta.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrap.querySelector(".caret-popup").hidden).toBe(true);
  });
});

describe("ComposerCore keyboard", () => {
  it("fires onEnter on a bare Enter", () => {
    const onEnter = vi.fn();
    const { ta } = mount(undefined, { onEnter });
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter does not fire onEnter (newline instead)", () => {
    const onEnter = vi.fn();
    const { ta } = mount(undefined, { onEnter });
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("isMobileViewport override suppresses onEnter (newline instead, like a soft keyboard)", () => {
    const onEnter = vi.fn();
    const { ta } = mount(undefined, { onEnter, isMobileViewport: () => true });
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe("ComposerCore Ctrl+Z", () => {
  it("consumes Ctrl+Z when onUndoQueued returns true", () => {
    const onUndoQueued = vi.fn(() => true);
    const { ta } = mount(undefined, { onUndoQueued });
    const evt = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(evt);
    expect(onUndoQueued).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("lets Ctrl+Z fall through to native undo when onUndoQueued declines", () => {
    const onUndoQueued = vi.fn(() => false);
    const { ta } = mount(undefined, { onUndoQueued });
    const evt = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it("ignores Ctrl+Shift+Z (redo) - never calls onUndoQueued", () => {
    const onUndoQueued = vi.fn(() => true);
    const { ta } = mount(undefined, { onUndoQueued });
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(onUndoQueued).not.toHaveBeenCalled();
  });
});

describe("ComposerCore autoResize", () => {
  it("onResize fires with the textarea's scrollHeight", () => {
    const onResize = vi.fn();
    const { core } = mount(undefined, { onResize });
    core.autoResize();
    expect(onResize).toHaveBeenCalled();
    expect(typeof onResize.mock.calls[0][0]).toBe("number");
  });
});
