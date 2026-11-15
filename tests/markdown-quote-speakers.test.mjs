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

  // pc-1377: the 2026-10-26 zng-biller case. Airion wrote the rule in one story's
  // description; Stevan objected two weeks later on a different story, to Joe.
  // Flattened into bold-name prose it read as Stevan answering Airion.
  describe("addressee and source", () => {
    const airion = `> **Airion -> team (sc-56277 description, Oct 8):**
> Only the PM role edits the rule.`;
    const stevan = `> **Stevan -> Joe (sc-56481 comment, Oct 26):**
> I do not think the PM should own this.`;

    it("puts the addressee and the source on the speaker line, each in its own span", () => {
      const who = quoteOf(stevan).querySelector(":scope > p.md-quote-who");
      expect(who.querySelector("strong").firstChild.textContent).toBe("Stevan");
      expect(who.querySelector(".md-quote-to").textContent).toBe(" -> Joe");
      expect(who.querySelector(".md-quote-src").textContent).toBe(" (sc-56481 comment, Oct 26)");
      expect(who.querySelector(".md-quote-colon").textContent).toBe(":");
      expect(paras(quoteOf(stevan))).toEqual(["Stevan -> Joe (sc-56481 comment, Oct 26):", "I do not think the PM should own this."]);
    });

    it("keeps two threads apart: each quote names its own addressee and ticket", () => {
      const root = document.createElement("div");
      root.innerHTML = renderMarkdown(`${airion}

A fortnight later, on another story:

${stevan}`);
      const quotes = [...root.querySelectorAll("blockquote.md-quote")];
      expect(quotes).toHaveLength(2);
      expect(quotes.map((q) => q.querySelector(".md-quote-to").textContent)).toEqual([" -> team", " -> Joe"]);
      expect(quotes.map((q) => q.querySelector(".md-quote-src").textContent)).toEqual([" (sc-56277 description, Oct 8)", " (sc-56481 comment, Oct 26)"]);
    });

    it("takes each part alone, the arrow char too, and the older **Name**: form", () => {
      const only = (md) => quoteOf(md).querySelector(".md-quote-who");
      expect(only("> **Stevan -> Joe:** hi").querySelector(".md-quote-src")).toBeNull();
      expect(only("> **Stevan (sc-1):** hi").querySelector(".md-quote-to")).toBeNull();
      expect(only("> **Stevan → Joe:** hi").querySelector(".md-quote-to").textContent).toBe(" -> Joe");
      expect(only("> **Stevan -> Joe (sc-2)**: hi").querySelector(".md-quote-src").textContent).toBe(" (sc-2)");
      expect(only("> **Airion:** hi").querySelector(".md-quote-to, .md-quote-src")).toBeNull();
    });

    it("escapes both, and an over-long note makes the line a plain lead-in, not a speaker", () => {
      const who = quoteOf("> **A -> <b>x</b> (<img src=x onerror=alert>):** hi").querySelector(".md-quote-who");
      expect(who.querySelector("img, b")).toBeNull();
      expect(who.querySelector(".md-quote-to").textContent).toBe(" -> <b>x</b>");
      expect(who.querySelector(".md-quote-src").textContent).toBe(" (<img src=x onerror=alert>)");
      expect(quoteOf(`> **A (${"n".repeat(81)}):** hi`).querySelector(".md-quote-who")).toBeNull();
      // Far past any speaker line: prose, refused before a regex looks at it.
      expect(quoteOf(`> **${"word ".repeat(400)}:** hi`).querySelector(".md-quote-who")).toBeNull();
    });

    it("survives the draft editor's round trip back to markdown", () => {
      const root = document.createElement("div");
      root.innerHTML = renderMarkdown(`Stevan wrote:

${stevan}`);
      const back = htmlToMarkdown(root);
      expect(back).toContain("**Stevan -> Joe (sc-56481 comment, Oct 26):**");
      expect(paras(quoteOf(back))).toEqual(["Stevan -> Joe (sc-56481 comment, Oct 26):", "I do not think the PM should own this."]);
    });
  });
});