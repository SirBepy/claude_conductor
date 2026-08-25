// Todo 777: two authored messages arriving in separate flush passes (a live
// burst outside the ~80ms throttle window, or a pagination prepend revealing
// one more authored message next to an already-grouped run) must fold into
// the SAME chip, not spawn a second one.

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { groupAuthoredMessages } from "../src/shared/chat/author-message-group.ts";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
});

// Mirrors the hidden placeholder renderMessage() produces for an authored
// user row (chat-transforms.ts) - the real shape groupAuthoredMessages runs
// against in production, without pulling in the full render pipeline.
function authoredEl() {
  const el = document.createElement("div");
  el.className = "msg user author-marker";
  el.style.display = "none";
  return el;
}

function userMsg(authorSessionId, text) {
  return { kind: "user", content: [{ type: "text", text }], ts: 0, authorSessionId };
}

describe("groupAuthoredMessages across separate flush passes", () => {
  it("folds a second authored message appended in a later pass into the first chip", () => {
    const messages = [userMsg("jarvis-1", "build the login page")];
    const messageEls = [authoredEl()];
    document.body.append(...messageEls);

    groupAuthoredMessages(messages, messageEls);
    expect(document.querySelectorAll(".author-group-host")).toHaveLength(1);

    // Second flush pass: a peer message arrives later, appended to the same
    // arrays (as chat-dom-renderer.ts always passes the full accumulated
    // messages/messageEls, not just the new slice).
    messages.push(userMsg("scout-1", "found the root cause"));
    messageEls.push(authoredEl());
    document.body.append(messageEls[1]);

    groupAuthoredMessages(messages, messageEls);

    const hosts = document.querySelectorAll(".author-group-host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].querySelectorAll(".tool-chip")).toHaveLength(1);
    expect(hosts[0].querySelectorAll(".tool-strip-group.author-group-panel")).toHaveLength(1);
    expect(hosts[0].querySelectorAll(".author-group-row")).toHaveLength(2);
    expect(hosts[0].querySelector(".tool-chip-count").textContent).toBe("×2");
  });

  it("still starts a fresh chip when the prior run was not authored", () => {
    const messages = [
      { kind: "user", content: [{ type: "text", text: "Joe's own message" }], ts: 0, authorSessionId: null },
      userMsg("jarvis-1", "one more thing"),
    ];
    const joeEl = document.createElement("div");
    joeEl.className = "msg user";
    const messageEls = [joeEl, authoredEl()];
    document.body.append(...messageEls);

    groupAuthoredMessages(messages, messageEls);

    expect(document.querySelectorAll(".author-group-host")).toHaveLength(1);
  });
});
