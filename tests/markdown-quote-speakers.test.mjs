// @vitest-environment jsdom

// A markdown quote is a quote of a person: renderMarkdown tags every
// blockquote .md-quote (one reply-bubble style on every surface), and a quote
// that opens with **Name:** gets the name on its own speaker line. The draft
// editor saves its DOM back to markdown, so the speaker line has to survive
// that round trip.

import { describe, it, expect, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { renderMarkdown } = await import("../src/shared/chat/chat-transforms.ts");
const { htmlToMarkdown } = await import("../src/shared/chat/draft-markdown.ts");

function quoteOf(markdown, breaks = false) {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(markdown, breaks);
  return root.querySelector("blockquote");
}

const paras = (bq) => Array.from(bq.querySelectorAll(":scope > p")).map((p) => p.textContent);

describe("quote speakers", () => {
  it("lifts a leading **Name:** onto its own speaker line", () => {
    const bq = quoteOf("> **Airion:**\n> this is DOPE AF!\n>\n> ok bro this is all you");
    expect(bq.classList.contains("md-quote")).toBe(true);
    const who = bq.querySelector(":scope > p.md-quote-who");
    expect(who).not.toBeNull();
    expect(who.querySelector("strong").firstChild.textContent).toBe("Airion");
    expect(who.querySelector(".md-quote-colon").textContent).toBe(":");
    expect(paras(bq)).toEqual(["Airion:", "this is DOPE AF!", "ok bro this is all you"]);
  });

  it("reads the name on the same line as the words, and with the colon outside the bold", () => {
    expect(paras(quoteOf("> **Airion:** this is *great*"))).toEqual(["Airion:", "this is great"]);
    expect(paras(quoteOf("> **Airion**: hi"))).toEqual(["Airion:", "hi"]);
  });

  it("works with forced line breaks (user messages)", () => {
    const bq = quoteOf("> **Liv:**\n> sounds good", true);
    expect(paras(bq)).toEqual(["Liv:", "sounds good"]);
    expect(bq.querySelector("br")).toBeNull();
  });

  it("finds the speaker of a nested quote", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("> > **Liv:**\n> > nested");
    const inner = root.querySelector("blockquote blockquote");
    expect(inner.classList.contains("md-quote")).toBe(true);
    expect(paras(inner)).toEqual(["Liv:", "nested"]);
  });

  it("leaves a quote with no speaker as a plain reply bubble", () => {
    for (const md of ["> plain quote", "> **Bold lead** not a speaker", `> **${"a very long bold lead-in sentence that ends in".repeat(1)} a colon:** then words`]) {
      const bq = quoteOf(md);
      expect(bq.classList.contains("md-quote"), md).toBe(true);
      expect(bq.querySelector(".md-quote-who"), md).toBeNull();
    }
  });

  it("escapes a speaker name like any other text", () => {
    const bq = quoteOf("> **<img src=x onerror=alert(1)>:** hi");
    expect(bq.querySelector("img")).toBeNull();
    expect(bq.querySelector(".md-quote-who strong").firstChild.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("survives the draft editor's round trip back to markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("Airion said:\n\n> **Airion:**\n> ship it");
    const back = htmlToMarkdown(root);
    expect(back).toContain("**Airion:**");
    expect(paras(quoteOf(back))).toEqual(["Airion:", "ship it"]);
  });
});