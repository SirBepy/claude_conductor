import { describe, it, expect } from "vitest";

const { slackPlainText } = await import("../src/shared/message-draft-utils.ts");

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
