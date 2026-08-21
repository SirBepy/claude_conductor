// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { CaretSuggestPopup } from "../src/shared/chat/caret-popup/popup.ts";

function setup() {
  const anchor = document.createElement("div");
  const ta = document.createElement("textarea");
  anchor.appendChild(ta);
  document.body.appendChild(anchor);
  const items = ["commit", "caveman", "close"];
  const provider = {
    triggerChar: "/",
    shouldTrigger: ({ textBefore }) => /(^|\s)\/[^\s]*$/.test(textBefore),
    query: (token) => items.filter((i) => i.startsWith(token.slice(1))),
    renderRow: (i, sel) => {
      const el = document.createElement("div");
      el.textContent = (sel ? "> " : "  ") + i;
      el.className = sel ? "row selected" : "row";
      return el;
    },
    onPick: vi.fn(),
  };
  const popup = new CaretSuggestPopup({ anchor, textarea: ta, providers: [provider] });
  return { popup, ta, provider };
}

describe("CaretSuggestPopup", () => {
  it("opens on '/' at start of textarea", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
  });

  it("does not open mid-word (no whitespace before /)", () => {
    const { popup, ta } = setup();
    ta.value = "hello/c";
    ta.selectionStart = ta.selectionEnd = 7;
    popup.handleInput();
    expect(popup.isOpen()).toBe(false);
  });

  it("opens after whitespace mid-line", () => {
    const { popup, ta } = setup();
    ta.value = "hello /c";
    ta.selectionStart = ta.selectionEnd = 8;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
  });

  it("opens after newline", () => {
    const { popup, ta } = setup();
    ta.value = "hello\n/c";
    ta.selectionStart = ta.selectionEnd = 8;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
  });

  it("closes when whitespace ends the token", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
    ta.value = "/c ";
    ta.selectionStart = ta.selectionEnd = 3;
    popup.handleInput();
    expect(popup.isOpen()).toBe(false);
  });

  it("picks up the rest of an already-typed word when '/' lands at its start", () => {
    const { popup, ta, provider } = setup();
    ta.value = "/close";
    ta.selectionStart = ta.selectionEnd = 1; // caret right after the "/", before "close"
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    popup.handleKey(e);
    expect(provider.onPick).toHaveBeenCalledWith("close", ta, [0, 6]);
  });

  it("handleKey returns false when closed", () => {
    const { popup } = setup();
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    expect(popup.handleKey(e)).toBe(false);
  });

  it("Enter picks selected item when open", () => {
    const { popup, ta, provider } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    expect(popup.handleKey(e)).toBe(true);
    expect(provider.onPick).toHaveBeenCalled();
  });

  it("Esc closes", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "Escape" });
    expect(popup.handleKey(e)).toBe(true);
    expect(popup.isOpen()).toBe(false);
  });

  it("ArrowDown advances selection", () => {
    const { popup, ta, provider } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "ArrowDown" });
    expect(popup.handleKey(e)).toBe(true);
    const pick = new KeyboardEvent("keydown", { key: "Enter" });
    popup.handleKey(pick);
    expect(provider.onPick).toHaveBeenCalled();
    const [picked] = provider.onPick.mock.calls[0];
    expect(picked).toBe("caveman");
  });
});

describe("CaretSuggestPopup multi-provider", () => {
  it("routes / and @ to the right provider", () => {
    const anchor = document.createElement("div");
    const ta = document.createElement("textarea");
    anchor.appendChild(ta);
    document.body.appendChild(anchor);

    const slash = {
      triggerChar: "/",
      shouldTrigger: ({ textBefore }) => /(^|\s)\/[^\s]*$/.test(textBefore),
      query: (t) => [`SLASH:${t}`],
      renderRow: (i, sel) => {
        const el = document.createElement("div");
        el.textContent = String(i);
        el.className = sel ? "selected" : "";
        return el;
      },
      onPick: vi.fn(),
    };
    const file = {
      triggerChar: "@",
      shouldTrigger: ({ textBefore }) => /(^|\s)@[^\s]*$/.test(textBefore),
      query: (t) => [`FILE:${t}`],
      renderRow: (i, sel) => {
        const el = document.createElement("div");
        el.textContent = String(i);
        el.className = sel ? "selected" : "";
        return el;
      },
      onPick: vi.fn(),
    };
    const popup = new CaretSuggestPopup({ anchor, textarea: ta, providers: [slash, file] });

    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    popup.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(slash.onPick).toHaveBeenCalled();
    expect(file.onPick).not.toHaveBeenCalled();

    ta.value = "@f";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    popup.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(file.onPick).toHaveBeenCalled();
  });
});
