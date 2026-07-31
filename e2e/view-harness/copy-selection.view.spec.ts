import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Native Ctrl+C selection copy must not inject newlines around inline `code`
// spans - the browser's plain-text serializer breaks on BLOCK-level boxes,
// and any block-ish descendant of an inline-code span (e.g. an absolutely
// positioned button, which blockifies per CSS display spec) forces one.
// Exercises the real pipeline directly (renderMarkdown + highlightInlineCode)
// with no session/composer mount, same dynamic-import pattern as auq-flow.

async function renderMessage(page: import("@playwright/test").Page, source: string): Promise<void> {
  await page.evaluate(async (md) => {
    const transforms = await import("/shared/chat/chat-transforms.ts");
    const highlighter = await import("/shared/chat/code-highlighter.ts");
    const container = document.createElement("div");
    // .session-messages is where chat.css turns on `user-select: text`
    // (the page default is `none`) - without it Selection.toString() is "".
    container.className = "session-messages";
    container.innerHTML = `<div class="msg assistant"><div class="block text">${transforms.renderMarkdown(md, false)}</div></div>`;
    document.body.appendChild(container);
    highlighter.highlightInlineCode(container);
  }, source);
}

test.describe("view-harness / native selection copy around inline code", () => {
  test("selecting a paragraph with inline code spans copies with no stray newlines", async ({ page }) => {
    await mountView(page);
    const source = "Backend committed (`ff79d982`) and the rest is done. `HistoryEntry` gains model.";
    await renderMessage(page, source);

    const text = await page.evaluate(() => {
      const p = document.querySelector(".msg.assistant .block.text p")!;
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });

    expect(text).toBe("Backend committed (ff79d982) and the rest is done. HistoryEntry gains model.");
  });

  test("a fenced code block's internal newlines are preserved (not the bug this guards)", async ({ page }) => {
    await mountView(page);
    const source = ["Intro `x` text.", "", "```", "line one", "line two", "```"].join("\n");
    await renderMessage(page, source);

    const text = await page.evaluate(() => {
      const container = document.querySelector(".msg.assistant")!;
      const range = document.createRange();
      range.selectNodeContents(container);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });

    expect(text).toContain("line one\nline two");
  });
});
