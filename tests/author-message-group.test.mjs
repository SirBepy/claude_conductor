// Todo 777: two authored messages arriving in separate flush passes (a live
// burst outside the ~80ms throttle window, or a pagination prepend revealing
// one more authored message) must fold into the SAME chip, not spawn a second
// one. Since the peer chip moved onto the turn's shared line, "same chip" now
// means one chip per turn footer, extended in place.

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { foldAuthoredIntoStrip } from "../src/shared/chat/author-message-group.ts";

const userCssPath = fileURLToPath(new URL("../src/shared/chat/chat-messages-user.css", import.meta.url));

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  globalThis.Node = dom.window.Node;
});

// Mirrors the hidden placeholder renderMessage() produces for an authored
// user row (chat-transforms.ts) - the real shape the fold runs against in
// production, without pulling in the full render pipeline.
function authoredEl() {
  const el = document.createElement("div");
  el.className = "msg user author-marker";
  el.style.display = "none";
  return el;
}

function userMsg(authorSessionId, text) {
  return { kind: "user", content: [{ type: "text", text }], ts: 0, authorSessionId };
}

function footer() {
  const el = document.createElement("div");
  el.className = "turn-footer";
  document.body.appendChild(el);
  return el;
}

function chips(host) {
  return host.querySelectorAll('.tool-chip[data-tool="peer-msgs"]');
}

describe("foldAuthoredIntoStrip across separate flush passes", () => {
  it("extends the turn's existing chip instead of minting a second one", () => {
    const host = footer();
    const messages = [userMsg("peer-a", "first")];
    const messageEls = [authoredEl()];
    document.body.append(...messageEls);

    foldAuthoredIntoStrip(messages, messageEls, 0, 1, host);
    expect(chips(host)).toHaveLength(1);
    expect(host.querySelector(".tool-chip-count")).toBeNull(); // a single message shows no ×N

    messages.push(userMsg("peer-b", "second"));
    messageEls.push(authoredEl());
    document.body.append(messageEls[1]);
    foldAuthoredIntoStrip(messages, messageEls, 0, 2, host);

    expect(chips(host)).toHaveLength(1);
    expect(host.querySelector(".tool-chip-count").textContent).toBe("×2");
    expect(host.querySelectorAll(".author-group-row")).toHaveLength(2);
    expect(host.querySelectorAll('.tool-strip-group[data-tool="peer-msgs"]')).toHaveLength(1);
  });

  it("a turn with no authored message gets no peer chip", () => {
    const host = footer();
    const messages = [{ kind: "user", content: [{ type: "text", text: "mine" }], ts: 0, authorSessionId: null }];
    const messageEls = [authoredEl()];
    document.body.append(...messageEls);

    foldAuthoredIntoStrip(messages, messageEls, 0, 1, host);
    expect(chips(host)).toHaveLength(0);
    expect(host.querySelector(".tool-strip")).toBeNull();
  });

  it("each turn footer carries its own peer chip", () => {
    const a = footer();
    const b = footer();
    const messages = [userMsg("peer-a", "one"), userMsg("peer-a", "two")];
    const messageEls = [authoredEl(), authoredEl()];
    document.body.append(...messageEls);

    foldAuthoredIntoStrip(messages, messageEls, 0, 1, a);
    foldAuthoredIntoStrip(messages, messageEls, 1, 2, b);

    expect(chips(a)).toHaveLength(1);
    expect(chips(b)).toHaveLength(1);
  });
});

describe("todo 789: .author-group-panel's own [hidden] must actually hide it", () => {
  it("setting hidden on an isolated panel makes it display:none", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(userCssPath, "utf8");
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "author-group-panel";
    document.body.appendChild(panel);
    expect(window.getComputedStyle(panel).display).toBe("flex");

    panel.hidden = true;
    expect(window.getComputedStyle(panel).display).toBe("none");
  });
});

// Todo 790: hashStr(sessionId) % PALETTE_SIZE has no export, so this locks
// the mapping via the rendered .author-avatar class, the same surface a
// hash/palette-size change would actually break.
describe("todo 790: avatar palette mapping is stable", () => {
  const golden = [
    ["peer-a", "author-color-4"],
    ["peer-b", "author-color-3"],
    ["peer-gamma", "author-color-0"],
    ["session-xyz-123", "author-color-3"],
  ];

  it("maps fixed session ids to their expected palette class", () => {
    for (const [id, expectedClass] of golden) {
      const host = footer();
      foldAuthoredIntoStrip([userMsg(id, "hi")], [authoredEl()], 0, 1, host);
      const avatar = host.querySelector(".author-avatar");
      expect(avatar.className).toContain(expectedClass);
    }
  });

  it("the same session id maps to the same class across separate calls", () => {
    const hostA = footer();
    const hostB = footer();
    foldAuthoredIntoStrip([userMsg("peer-a", "one")], [authoredEl()], 0, 1, hostA);
    foldAuthoredIntoStrip([userMsg("peer-a", "two")], [authoredEl()], 0, 1, hostB);

    const classA = hostA.querySelector(".author-avatar").className;
    const classB = hostB.querySelector(".author-avatar").className;
    expect(classA).toBe(classB);
  });
});
