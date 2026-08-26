// @vitest-environment jsdom

// The draft editor is a contenteditable, but the store keeps markdown so a
// later diff against Claude's own version is exact. These pin the round-trip
// the toolbar can actually produce.

import { describe, it, expect } from "vitest";

const { htmlToMarkdown } = await import("../src/shared/chat/draft-markdown.ts");

function md(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return htmlToMarkdown(root);
}

describe("htmlToMarkdown", () => {
  it("keeps paragraphs separated by a blank line", () => {
    expect(md("<p>first</p><p>second</p>")).toBe("first\n\nsecond");
  });

  it("serializes every mark the toolbar emits", () => {
    expect(md("<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>fn()</code></p>")).toBe(
      "**bold** _it_ ~~gone~~ `fn()`",
    );
  });

  it("accepts the b/i tags execCommand actually produces", () => {
    expect(md("<p><b>bold</b> and <i>it</i></p>")).toBe("**bold** and _it_");
  });

  it("pushes delimiters outside a mark's own trailing space", () => {
    // "** x **" is not emphasis in any renderer, so the space has to move out.
    expect(md("<p>a<strong> x </strong>b</p>")).toBe("a **x** b");
  });

  it("keeps consecutive list items in one list", () => {
    expect(md("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("numbers an ordered list", () => {
    expect(md("<ol><li>one</li><li>two</li></ol>")).toBe("1. one\n2. two");
  });

  it("indents a nested list under its item", () => {
    expect(md("<ul><li>outer<ul><li>inner</li></ul></li></ul>")).toBe("- outer\n  - inner");
  });

  it("separates a paragraph from a list that follows it", () => {
    expect(md("<p>intro</p><ul><li>one</li></ul>")).toBe("intro\n\n- one");
  });

  it("fences a pre block and never escapes inside it", () => {
    expect(md("<pre><code>a*b_c</code></pre>")).toBe("```\na*b_c\n```");
  });

  it("does not escape inside an inline code span", () => {
    expect(md("<p><code>a_b*c</code></p>")).toBe("`a_b*c`");
  });

  it("escapes markdown characters in plain text", () => {
    expect(md("<p>2 * 3 and _under_</p>")).toBe("2 \\* 3 and \\_under\\_");
  });

  it("renders a link with its href", () => {
    expect(md('<p><a href="https://x.dev">docs</a></p>')).toBe("[docs](https://x.dev)");
  });

  it("falls back to the text when an anchor has no href", () => {
    expect(md("<p><a>bare</a></p>")).toBe("bare");
  });

  it("quotes a blockquote line by line", () => {
    expect(md("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n\n> two");
  });

  it("turns a br into a newline rather than dropping it", () => {
    expect(md("<p>one<br>two</p>")).toBe("one\ntwo");
  });

  it("flattens an unknown wrapper to its contents", () => {
    expect(md("<p><span><strong>kept</strong></span></p>")).toBe("**kept**");
  });

  it("descends through a div that only wraps blocks", () => {
    expect(md("<div><p>one</p><p>two</p></div>")).toBe("one\n\ntwo");
  });

  it("returns an empty string for an empty editor", () => {
    expect(md("")).toBe("");
    expect(md("<p><br></p>")).toBe("");
  });
});
