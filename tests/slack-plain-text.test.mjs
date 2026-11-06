import { describe, it, expect } from "vitest";

const { slackPlainText, slackHtml } = await import("../src/shared/message-draft-utils.ts");

describe("slackHtml", () => {
  it("puts an empty paragraph between two paragraphs so Slack shows the gap", () => {
    expect(slackHtml("<p>a</p><p>b</p>\n<p class=\"x\">c</p>"))
      .toBe("<p>a</p><p><br></p><p>b</p><p><br></p><p class=\"x\">c</p>");
  });

  it("leaves a single paragraph, lists and a <pre> alone", () => {
    const html = "<p>a</p><ul><li>x</li><li>y</li></ul><pre>p</pre>";
    expect(slackHtml(html)).toBe(html);
  });
});

describe("slackPlainText", () => {
  it("turns a markdown link into text plus the bare URL", () => {
    expect(slackPlainText("see [team roles](https://example.com/roles) here"))
      .toBe("see team roles (https://example.com/roles) here");
  });

  it("collapses a link whose text is its own URL to the URL alone", () => {
    expect(slackPlainText("[https://a.io/x](https://a.io/x)")).toBe("https://a.io/x");
  });

  it("rewrites double-asterisk bold into Slack's single-asterisk form", () => {
    expect(slackPlainText("the **auth migration** slips")).toBe("the *auth migration* slips");
  });

  it("keeps a URL's own balanced parentheses inside the link", () => {
    expect(slackPlainText("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) ok"))
      .toBe("Foo (https://en.wikipedia.org/wiki/Foo_(bar)) ok");
  });

  it("an unterminated link with a long URL returns at once (no regex backtracking blow-up)", () => {
    const text = "[t](https://" + "a".repeat(5000);
    const t0 = performance.now();
    expect(slackPlainText(text)).toBe(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("leaves code spans and fences untouched", () => {
    expect(slackPlainText("run `a **b** c` then **go**")).toBe("run `a **b** c` then *go*");
    const fence = "```\n**x** [l](https://a.io)\n```";
    expect(slackPlainText(fence)).toBe(fence);
  });

  it("leaves paragraphs, bullets and plain text alone", () => {
    const text = "Hi Marko,\n\n- one\n- two\n\nThanks";
    expect(slackPlainText(text)).toBe(text);
  });
});
