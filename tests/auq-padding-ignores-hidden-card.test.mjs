// @vitest-environment jsdom
// Regression: the transcript padding that keeps the last message clear of the
// question card was measured from a card whose pane was display:none. Its
// all-zero rect read as "card top = 0", so the padding jumped to ~1300px, the
// composer scrolled off the bottom and the pane's ancestor scrolled. It stuck
// until Ctrl+R (app log: `composer below the viewport ... transcriptPadBottom=1334`).

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/chat/chat-dom-renderer.ts", () => ({ isElNearBottom: () => false }));
vi.mock("../src/views/sessions/permission-modal/drag-handle.ts", () => ({ PEEK_SETTLED_EVENT: "peek-settled" }));

const { createQuestionCardLayout, cardPaddedScroller } = await import("../src/views/sessions/permission-modal/question-ui-layout.ts");

function rect(top, bottom, width = 600) {
  return () => ({ top, bottom, height: bottom - top, width, left: 0, right: width, x: 0, y: top, toJSON() {} });
}

function setup() {
  document.body.innerHTML = `<div class="session-messages"></div><div id="host"><div class="prompt-card"></div></div>`;
  const messagesEl = document.querySelector(".session-messages");
  const host = document.getElementById("host");
  const card = host.querySelector(".prompt-card");
  messagesEl.getBoundingClientRect = rect(0, 1322);
  const layout = createQuestionCardLayout(host, { activeTab: 0 }, messagesEl, {});
  return { messagesEl, card, layout };
}

describe("syncMessagesPadding", () => {
  it("pads the transcript by the card's overlap plus a gap", () => {
    const { messagesEl, card, layout } = setup();
    card.getBoundingClientRect = rect(1000, 1300);
    layout.syncMessagesPadding();
    expect(messagesEl.style.paddingBottom).toBe("334px");
  });

  it("keeps the last good padding when the card has no layout box", () => {
    const { messagesEl, card, layout } = setup();
    card.getBoundingClientRect = rect(1000, 1300);
    layout.syncMessagesPadding();
    card.getBoundingClientRect = rect(0, 0, 0);
    layout.syncMessagesPadding();
    expect(messagesEl.style.paddingBottom).toBe("334px");
  });

  it("never sets a pane-sized padding from an unmeasurable card", () => {
    const { messagesEl, card, layout } = setup();
    card.getBoundingClientRect = rect(0, 0, 0);
    layout.syncMessagesPadding();
    expect(messagesEl.style.paddingBottom).toBe("");
  });
});

describe("cardPaddedScroller", () => {
  it("pads the card's own pane's transcript, or the chat dashboard's body while it shows", () => {
    document.body.innerHTML = `<div class="session-messages" id="other"></div>
      <div class="session-pane"><div class="cdash"><div class="cdash-body"></div></div><div class="session-messages" id="mine"></div><div id="host"></div></div>`;
    const host = document.getElementById("host");
    const pane = document.querySelector(".session-pane");
    expect(cardPaddedScroller(host).id).toBe("mine");
    pane.setAttribute("data-chat-view", "dashboard");
    expect(cardPaddedScroller(host).className).toBe("cdash-body");
  });
});

describe("switching Dashboard / Messages while a question card is open", () => {
  it("moves the padding to the scroller that shows now and clears the old one", async () => {
    document.body.innerHTML = `<div class="session-pane" data-chat-view="dashboard"><div class="cdash-body" id="dash"></div><div class="session-messages" id="msgs"></div><div id="host"><div class="prompt-card"></div></div></div>`;
    const pane = document.querySelector(".session-pane");
    const dash = document.getElementById("dash");
    const msgs = document.getElementById("msgs");
    const host = document.getElementById("host");
    dash.getBoundingClientRect = rect(0, 1322);
    msgs.getBoundingClientRect = rect(0, 1322);
    host.querySelector(".prompt-card").getBoundingClientRect = rect(1000, 1300);
    const layout = createQuestionCardLayout(host, { activeTab: 0 }, msgs, {});
    layout.syncMessagesPadding();
    expect(dash.style.paddingBottom).toBe("334px");
    expect(msgs.style.paddingBottom).toBe("");

    pane.setAttribute("data-chat-view", "messages");
    document.dispatchEvent(new CustomEvent("cc-chat-view-changed"));
    await Promise.resolve();
    expect(msgs.style.paddingBottom).toBe("334px");
    expect(dash.style.paddingBottom, "the hidden scroller keeps no band").toBe("");

    // A torn-down card no longer follows the setting.
    layout.dispose();
    pane.setAttribute("data-chat-view", "dashboard");
    document.dispatchEvent(new CustomEvent("cc-chat-view-changed"));
    await Promise.resolve();
    expect(dash.style.paddingBottom).toBe("");
  });
});
