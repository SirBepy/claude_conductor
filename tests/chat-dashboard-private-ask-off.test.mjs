// @vitest-environment jsdom
// asserts: src/views/sessions/private-ask.ts, src/views/sessions/question-ask.ts, src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/permission-modal/question-ui-templates.ts

// The private read-only ask chat is switched off (src/views/sessions/private-ask.ts):
// nothing in the Answers card or a question card opens it, while the code stays
// for its return as a subchat. Unlike its sibling specs this file
// never sets the override, so it sees the app's real default.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");
const { setAnswersApi } = await import("../src/views/sessions/chat-dashboard/answers-api.ts");
const { emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");
const { askAboutQuestion, QUESTION_ASK_EVENT } = await import("../src/views/sessions/question-ask.ts");
const { privateAskEnabled } = await import("../src/views/sessions/private-ask.ts");
const { questionZonesHtml } = await import("../src/views/sessions/permission-modal/question-ui-templates.ts");
const { toolUseEvent, userEvent } = await import("./helpers/chat-events.mjs");

Element.prototype.scrollIntoView ??= () => {};

const QUESTION = { question: "Where should the key live?", options: [{ label: "Key modal" }] };

let threads;
beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
  threads = { prewarms: 0, sends: 0 };
  setAnswersApi({
    async load() { return { store: emptyStore(), threads: [] }; },
    async mark() { return emptyStore(); },
    async prewarm() { threads.prewarms++; },
    async send() { threads.sends++; throw new Error("the private ask must not run"); },
  });
});
afterEach(() => setAnswersApi(null));

function mountPane(sessionId) {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"><div id="prompt-card-host"></div></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  r.sessionId = sessionId;
  return { pane, r };
}
const until = (fn, ms = 3000) => new Promise((res, rej) => {
  const end = Date.now() + ms;
  const tick = () => { const v = fn(); if (v) res(v); else if (Date.now() > end) rej(new Error("timed out")); else setTimeout(tick, 10); };
  tick();
});

describe("the private ask chat is off", () => {
  it("is off by default", () => {
    expect(privateAskEnabled()).toBe(false);
  });

  it("offers no Reply and no + on an answer, and a click on one opens nothing", async () => {
    const { pane, r } = mountPane("chat-off");
    new ChatDashboard(pane, r);
    r.handleEvent(userEvent("does it work?"));
    r.handleEvent(toolUseEvent("mcp__cc_conductor__send_message", { kind: "answer", verdict: "Yes", text: "It works." }, "a1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "a1", output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });
    const card = await until(() => {
      const c = pane.querySelector(".cdash-answers");
      return c?.querySelector(".ax-face") ? c : null;
    });
    expect(card.querySelector("[data-ax='gotit']"), "Got it stays").not.toBeNull();
    expect(card.querySelector("[data-ax='reply']"), "no Reply").toBeNull();
    expect(card.querySelector("[data-ax='new-q']"), "no +").toBeNull();
    card.querySelector("[data-ax='gotit']").click();
    await until(() => pane.querySelector(".cdash-answers .ax-cc"));
    expect(pane.querySelector(".cdash-answers [data-ax='new-q']"), "no New question on All caught up").toBeNull();
    expect(pane.querySelector(".cdash-answers [data-ax='history']"), "History stays").not.toBeNull();
    expect(threads).toEqual({ prewarms: 0, sends: 0 });
  });

  it("gives a question card no Ask, and a stray ask event is not taken", async () => {
    expect(questionZonesHtml(QUESTION)).not.toContain('data-act="ask-inline"');
    const { pane, r } = mountPane("chat-off-q");
    new ChatDashboard(pane, r);
    await until(() => true);
    expect(askAboutQuestion(QUESTION, "q-1"), "no dashboard takes it, so the card never hides").toBe(false);
    const ev = new CustomEvent(QUESTION_ASK_EVENT, { detail: { card: "q-1#0", title: "t", about: "a" }, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(pane.querySelector(".ax-thread")).toBeNull();
  });
});
