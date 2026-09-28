// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdown, renderPrPreviewCard } from "../src/shared/chat/chat-transforms.ts";

// The PR-preview card used to render its body through a second markdown-it
// instance configured `html: true`, justified in a comment as safe because the
// body is "Claude-authored". Assistant text is not a trust boundary: it is
// shaped by whatever files, tool results and web pages the session read, and
// the card is triggered by three literal `<cc-pr-*>` markers in ordinary
// assistant text. With CSP allowing 'unsafe-inline' and no sanitizer anywhere
// in the repo, an `onerror=` attribute in that body executed in the main frame.
//
// These pin the property, not the one call site: no argument to renderMarkdown
// may produce a live element. The payload's own text surviving as escaped
// CHARACTER DATA is correct and expected - `&lt;img ... onerror=&quot;` is inert
// text, so these assert on parsed DOM rather than on substrings.

const PAYLOADS = [
  `<img src=x onerror="globalThis.__pwned = 1">`,
  `<svg onload="globalThis.__pwned = 1"></svg>`,
  `<a href="javascript:globalThis.__pwned=1">click</a>`,
  `<script>globalThis.__pwned = 1</script>`,
  `<iframe src="data:text/html,x"></iframe>`,
  `<div><object data="x"></object></div>`,
];

const LIVE = "img, svg, script, iframe, object, embed, form, style, link";

function b64(s) {
  return Buffer.from(s, "utf-8").toString("base64");
}

/** Parses `html` and returns every element and inline-handler the payload
 *  managed to create. Empty means the markup stayed inert text. */
function liveMarkup(html) {
  const host = document.createElement("div");
  host.innerHTML = html;
  const tags = [...host.querySelectorAll(LIVE)].map((el) => el.tagName.toLowerCase());
  const handlers = [...host.querySelectorAll("*")].flatMap((el) =>
    [...el.attributes].filter((a) => a.name.startsWith("on")).map((a) => a.name),
  );
  const jsHrefs = [...host.querySelectorAll("[href], [src]")]
    .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "")
    .filter((v) => v.trim().toLowerCase().startsWith("javascript:"));
  return [...tags, ...handlers, ...jsHrefs];
}

describe("renderMarkdown never produces live markup", () => {
  for (const payload of PAYLOADS) {
    it(`neutralises ${payload.slice(0, 26)}...`, () => {
      const out = renderMarkdown(payload);
      expect(liveMarkup(out)).toEqual([]);
      expect(out).toContain("&lt;");
    });
  }

  it("neutralises the same way with breaks enabled", () => {
    expect(liveMarkup(renderMarkdown(PAYLOADS[0], true))).toEqual([]);
  });

  it("still renders ordinary markdown", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>");
  });
});

describe("the PR preview card cannot smuggle live markup through its base64 body", () => {
  for (const payload of PAYLOADS) {
    it(`neutralises ${payload.slice(0, 26)}... in the card body`, () => {
      const html = renderPrPreviewCard("A title", b64(payload), b64("[]"));
      const host = document.createElement("div");
      host.innerHTML = html;
      // The body is pre-baked into a <template>, so it lives in the template's
      // own DocumentFragment - querySelector on the host never descends into it.
      const tpl = host.querySelector("template.pr-modal-tpl");
      expect(tpl, "card template missing").toBeTruthy();
      const body = tpl.content.querySelector(".pr-modal-body-content");
      expect(body, "card body missing").toBeTruthy();
      expect(liveMarkup(body.innerHTML)).toEqual([]);
    });
  }

  it("escapes the title into an attribute rather than closing it", () => {
    const html = renderPrPreviewCard(`" onmouseover="x`, b64("body"), b64("[]"));
    const host = document.createElement("div");
    host.innerHTML = html;
    const card = host.querySelector(".pr-preview-card");
    expect(card.getAttribute("data-pr-title")).toBe(`" onmouseover="x`);
    expect(card.hasAttribute("onmouseover")).toBe(false);
  });

  it("renders a normal body as markdown", () => {
    expect(renderPrPreviewCard("t", b64("**bold**"), b64("[]"))).toContain("<strong>");
  });
});
