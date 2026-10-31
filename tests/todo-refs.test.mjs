// @vitest-environment jsdom

// A device-prefixed todo id in chat text becomes a click target that asks the
// sessions view to open it in the Backlog panel; everything id-shaped but
// bare, padded short or part of a path stays plain text.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { markTodoRefs } = await import("../src/shared/chat/markdown-highlight.ts");
const { renderMarkdown } = await import("../src/shared/chat/chat-transforms.ts");
const { handleTodoRefClick } = await import("../src/views/sessions/backlog-panel/todo-ref-click.ts");
const { isTodoRefClick } = await import("../src/shared/chat/chat-click-handlers.ts");
const { BACKLOG_OPEN_EVENT, takePendingTodoId } = await import("../src/views/sessions/backlog-panel/backlog-open-event.ts");

const span = (id) => `<span class="todo-ref" data-todo-id="${id}">${id}</span>`;

describe("markTodoRefs", () => {
  it("wraps an id in prose, in inline code, and after punctuation", () => {
    expect(markTodoRefs("<p>see pc-1479.</p>")).toBe(`<p>see ${span("pc-1479")}.</p>`);
    expect(markTodoRefs("<p>(mac2-0007), pc-1508:</p>")).toBe(`<p>(${span("mac2-0007")}), ${span("pc-1508")}:</p>`);
    expect(markTodoRefs("<p><code>pc-1479</code></p>")).toBe(`<p><code>${span("pc-1479")}</code></p>`);
  });

  it("links the id alone when a title follows it, not when a slug is glued on", () => {
    expect(markTodoRefs("<p>pc-1479 - make ids clickable</p>")).toBe(`<p>${span("pc-1479")} - make ids clickable</p>`);
    expect(markTodoRefs("<p>pc-1479-make-ids-clickable</p>")).not.toContain("todo-ref");
  });

  it("leaves paths, filenames, fenced code, links and attributes alone", () => {
    for (const text of [
      ".claude/todos/pc-1479-make-ids.md",
      "C:\\proj\\.claude\\todos\\pc-1479.md",
      "pc-1479.md",
      "#pc-1479",
      "@pc-1479",
      "xpc-1479-",
    ]) {
      expect(markTodoRefs(`<p>${text}</p>`), text).not.toContain("todo-ref");
    }
    const pre = "<pre><code>git show pc-1479</code></pre>";
    expect(markTodoRefs(pre)).toBe(pre);
    const a = '<a href="https://x.dev/pc-1479">pc-1479</a>';
    expect(markTodoRefs(a)).toBe(a);
    const img = '<img alt="pc-1479" src="pc-1479.png">';
    expect(markTodoRefs(img)).toBe(img);
  });

  it("does not link bare numbers, short numbers or ordinary hyphenated words", () => {
    for (const text of ["1479", "pc-7", "pc-007", "abc-12", "utf-8", "gpt-4", "PC-1479", "pc1479", "-1479"]) {
      expect(markTodoRefs(`<p>${text}</p>`), text).not.toContain("todo-ref");
    }
  });

  it("runs as part of renderMarkdown, and not inside a markdown link", () => {
    expect(renderMarkdown("done in pc-1479")).toContain(span("pc-1479"));
    expect(renderMarkdown("see [pc-1479](https://x.dev)")).not.toContain("todo-ref");
  });
});

describe("isTodoRefClick", () => {
  // The sessions pane's click-to-reopen on a question card skips a click that
  // lands on a todo id, so the id opens its todo and the card stays put.
  it("is true for the id (or something inside it) and false elsewhere on the same card", () => {
    document.body.innerHTML = `<div class="msg question-card"><div class="tool-qa-q"><p>ship ${span("pc-1479")} first?</p></div><div class="tool-qa-a">awaiting</div></div>`;
    const seen = [];
    document.body.addEventListener("click", (e) => seen.push(isTodoRefClick(e)));
    document.querySelector(".todo-ref").click();
    document.querySelector(".tool-qa-a").click();
    document.querySelector("p").click();
    expect(seen).toEqual([true, false, false]);
  });
});

describe("handleTodoRefClick", () => {
  beforeEach(() => {
    takePendingTodoId();
    document.body.innerHTML = `<div class="msg">${markTodoRefs("<p>do <b>pc-1479</b> now</p>")}</div>`;
    document.addEventListener("click", handleTodoRefClick);
  });
  afterEach(() => document.removeEventListener("click", handleTodoRefClick));

  it("announces the id on the Backlog open event and leaves it pending for a panel mounted by the click", () => {
    const seen = vi.fn();
    window.addEventListener(BACKLOG_OPEN_EVENT, (e) => seen(e.detail.id), { once: true });
    document.querySelector(".todo-ref").click();
    expect(seen).toHaveBeenCalledWith("pc-1479");
    expect(takePendingTodoId()).toBe("pc-1479");
    expect(takePendingTodoId()).toBeNull();
  });

  it("ignores clicks elsewhere and non-primary buttons", () => {
    const seen = vi.fn();
    window.addEventListener(BACKLOG_OPEN_EVENT, seen);
    document.querySelector("p").click();
    document.querySelector(".todo-ref").dispatchEvent(new MouseEvent("click", { bubbles: true, button: 2 }));
    window.removeEventListener(BACKLOG_OPEN_EVENT, seen);
    expect(seen).not.toHaveBeenCalled();
  });
});
