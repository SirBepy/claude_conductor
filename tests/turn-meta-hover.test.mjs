/**
 * footerOfTurn / handleTurnMetaHover: hovering an assistant bubble marks ITS
 * turn's footer, never a later turn's (the reason this is JS, not a CSS
 * general-sibling selector).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { footerOfTurn, handleTurnMetaHover, handleTurnMetaHoverOut } from "../src/shared/chat/turn-meta-hover.ts";

let doc;

function build(html) {
  const dom = new JSDOM(`<div id="c">${html}</div>`);
  doc = dom.window.document;
  return doc.getElementById("c");
}

const over = (el) => handleTurnMetaHover({ target: el });
const out = (el, relatedTarget = null) => handleTurnMetaHoverOut({ target: el, relatedTarget });

describe("turn meta hover", () => {
  let c;
  beforeEach(() => {
    c = build(`
      <div class="msg user" id="u1"></div>
      <div class="msg assistant" id="a1"><span id="a1-child">hi</span></div>
      <div class="turn-footer" id="f1"></div>
      <div class="msg user" id="u2"></div>
      <div class="msg assistant" id="a2"></div>
      <div class="turn-footer" id="f2"></div>`);
  });

  it("finds the footer of the bubble's own turn, not a later one", () => {
    expect(footerOfTurn(c.querySelector("#a1")).id).toBe("f1");
    expect(footerOfTurn(c.querySelector("#a2")).id).toBe("f2");
  });

  it("a turn with no footer yet resolves to null instead of the next turn's", () => {
    c.querySelector("#f1").remove();
    expect(footerOfTurn(c.querySelector("#a1"))).toBeNull();
  });

  it("a hidden author marker does not end the turn", () => {
    c.querySelector("#a1").insertAdjacentHTML("afterend", '<div class="msg user author-marker"></div>');
    expect(footerOfTurn(c.querySelector("#a1")).id).toBe("f1");
  });

  it("hover marks only that turn's footer; leaving the bubble clears it", () => {
    over(c.querySelector("#a1-child"));
    expect(c.querySelector("#f1").classList.contains("turn-footer--hot")).toBe(true);
    expect(c.querySelector("#f2").classList.contains("turn-footer--hot")).toBe(false);
    out(c.querySelector("#a1-child"), c.querySelector("#u2"));
    expect(c.querySelector("#f1").classList.contains("turn-footer--hot")).toBe(false);
  });

  it("moving between a bubble's own children keeps the footer marked", () => {
    over(c.querySelector("#a1"));
    out(c.querySelector("#a1"), c.querySelector("#a1-child"));
    expect(c.querySelector("#f1").classList.contains("turn-footer--hot")).toBe(true);
  });

  it("hovering something that is not an assistant bubble does nothing", () => {
    over(c.querySelector("#u1"));
    expect(c.querySelector(".turn-footer--hot")).toBeNull();
  });
});
