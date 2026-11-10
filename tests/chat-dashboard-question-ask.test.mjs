// @vitest-environment jsdom
// asserts: src/views/sessions/question-ask.ts, src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/dashboard/dashboard-model.ts

// A question card's Ask (docs/chat-dashboard-design.md, "Asking about a question
// card"): the dashboard of the pane holding the card takes it, the Answers card
// opens a thread that starts on the question and its options (even in a chat
// with no answers yet), the sidecar is told which card it is about, and Back
// reopens the minimized card.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const expandActiveCard = vi.fn(() => true);
vi.mock("../src/views/sessions/permission-modal/question-state.ts", async (orig) => ({ ...(await orig()), expandActiveCard }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");
const { setAnswersApi } = await import("../src/views/sessions/chat-dashboard/answers-api.ts");
const { emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");
const { askAboutQuestion, questionAsk } = await import("../src/views/sessions/question-ask.ts");

const QUESTION = {
  question: "Keys sit next to Shortcut's today. Where should the Trello API key live?",
  options: [
    { label: "Key modal", description: "In ~/.claude/.env." },
    { label: "Project settings" },
  ],
};

function fakeDaemon() {
  const db = { store: emptyStore(), threads: [], sends: [] };
  db.api = {
    async load() { return { store: structuredClone(db.store), threads: structuredClone(db.threads) }; },
    async mark() { return structuredClone(db.store); },
    send(req) {
      // Kept so a test can wait for the very promise the card chains its reply handling on.
      db.lastSend = db.reply(req);
      return db.lastSend;
    },
  };
  db.reply = async (req) => {
    db.sends.push(req);
    if (db.gate) await db.gate;
    const id = `th${db.threads.length + 1}`;
    const t = { id, created_at: 0, updated_at: 0, sidecar_session_id: null, messages: [
      { role: "user", text: req.question, ts: Date.now() },
      { role: "assistant", text: "QUESTION: Which key location survives a reinstall?\nVERDICT: The key modal does\n\nThe .env file is in your home folder.", ts: Date.now() + 1 },
    ] };
    db.threads.push(t);
    db.store.questions.push({ thread_id: id, asked_at: Date.now() });
    return { thread: structuredClone(t), state: structuredClone(db.store) };
  };
  return db;
}

let db;
beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
  expandActiveCard.mockClear();
  db = fakeDaemon();
  setAnswersApi(db.api);
});
afterEach(() => setAnswersApi(null));

/** A chat pane whose composer holds the question card, the way host.ts mounts it. */
function mountPane(sessionId, { withCard = true } = {}) {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer">${withCard ? `<div id="prompt-card-host"></div>` : ""}</div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  r.sessionId = sessionId;
  return { pane, r };
}
const card = (pane) => pane.querySelector(".cdash-answers");
const wait = (ms = 30) => new Promise((res) => setTimeout(res, ms));
/** Polls until `fn` returns something truthy: the card draws after async loads,
 *  so a fixed sleep races a busy machine. */
async function until(fn, label = "condition", ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await wait(10);
  }
}
const input = (pane) => card(pane)?.querySelector(".ax-t-input") ?? null;
const kind = (pane) => card(pane)?.querySelector(".ax-thead-k")?.textContent ?? "";
const title = (pane) => card(pane)?.querySelector(".ax-thead-v")?.textContent ?? "";
const typeAndSend = (pane, text) => {
  const ta = card(pane).querySelector(".ax-t-input");
  ta.value = text;
  ta.dispatchEvent(new Event("input"));
  card(pane).querySelector(".ax-t-send").click();
};

describe("questionAsk", () => {
  it("titles the thread with the final ask and gives the sidecar the whole question and its options", () => {
    const a = questionAsk(QUESTION, "q-7", 1);
    expect(a.title).toBe("Where should the Trello API key live?");
    expect(a.about).toBe(`${QUESTION.question}\n\n- **Key modal**: In ~/.claude/.env.\n- **Project settings**`);
    expect(a.card).toBe("q-7#1");
    expect(questionAsk(QUESTION).card, "no prompt id: the words stand for the card").toBe(a.about);
  });
});

describe("a question card's Ask", () => {
  it("opens an About a question thread in a chat with no answers, sends the card along, and Back reopens the card", async () => {
    const { pane, r } = mountPane("chat-q");
    new ChatDashboard(pane, r);
    await wait();
    expect(card(pane), "no answers yet: no Answers card").toBeNull();

    expect(askAboutQuestion(QUESTION), "the dashboard takes the ask, so the card minimizes").toBe(true);
    await until(() => input(pane), "the thread's box");
    expect(card(pane).querySelector(".ax-thead-k").textContent).toBe("About a question");
    expect(card(pane).querySelector(".ax-thead-v").textContent).toBe("Where should the Trello API key live?");
    const about = card(pane).querySelector(".ax-tbody .ax-about");
    expect(about.textContent).toContain("Where should the Trello API key live?");
    expect(about.textContent).toContain("Key modal");
    expect(card(pane).querySelector(".ax-t-input").placeholder).toBe("Ask about this question...");
    expect(document.activeElement).toBe(card(pane).querySelector(".ax-t-input"));

    typeAndSend(pane, "which one survives a reinstall?");
    await until(() => kind(pane) === "Thread", "the reply");
    expect(db.sends).toHaveLength(1);
    expect(db.sends[0].key).toBeNull();
    expect(db.sends[0].aboutQuestion).toBe(questionAsk(QUESTION).about);
    // The reply lands as an answer; the thread keeps the card's question on top.
    expect(card(pane).querySelector(".ax-thead-v").textContent).toBe("Which key location survives a reinstall?");
    expect(card(pane).querySelector(".ax-tbody .ax-about")).not.toBeNull();
    expect(card(pane).querySelector(".ax-back").title).toBe("Back to the question");

    expect(expandActiveCard).not.toHaveBeenCalled();
    card(pane).querySelector("[data-ax='close-thread']").click();
    expect(expandActiveCard).toHaveBeenCalledWith({ sessionId: "chat-q" });
    await until(() => card(pane)?.querySelector(".ax-face .mc-verdict"), "the answer face");
    expect(card(pane).querySelector(".ax-face .mc-verdict").textContent).toBe("The key modal does");
  });

  it("goes back to the same thread when the same card is asked about again", async () => {
    const { pane, r } = mountPane("chat-again");
    new ChatDashboard(pane, r);
    await wait();
    askAboutQuestion(QUESTION, "q-1");
    await until(() => input(pane), "the thread's box");
    card(pane).querySelector("[data-ax='close-thread']").click();
    await until(() => !card(pane), "the zone to go");
    askAboutQuestion(QUESTION, "q-1");
    await until(() => input(pane), "the thread's box");
    expect(kind(pane)).toBe("About a question");
    // A plain Back from a thread that did not come from a card reopens nothing.
    expandActiveCard.mockClear();
    typeAndSend(pane, "and on a new machine?");
    await until(() => kind(pane) === "Thread", "the reply");
    card(pane).querySelector("[data-ax='close-thread']").click();
    card(pane).querySelector("[data-ax='reply']").click();
    card(pane).querySelector("[data-ax='close-thread']").click();
    expect(expandActiveCard).toHaveBeenCalledTimes(1);
    // Answered already: asking about the card again shows that exchange, not a blank thread.
    askAboutQuestion(QUESTION, "q-1");
    await until(() => card(pane)?.querySelector(".ax-tbody .ax-q0"), "the earlier exchange");
    expect(card(pane).querySelector(".ax-tbody .ax-q0").textContent).toContain("Which key location survives a reinstall?");
    expect(card(pane).querySelector(".ax-tbody .ax-about")).not.toBeNull();
    typeAndSend(pane, "thanks, and backups?");
    await until(() => db.sends.length === 2, "the second send");
    expect(db.sends.map((s) => s.key), "the second question is a follow-up in the same thread").toEqual([null, "ask:th1"]);
  });

  it("carries a follow-up typed while the first question was pending over to the answered thread", async () => {
    const { pane, r } = mountPane("chat-pending");
    new ChatDashboard(pane, r);
    await wait();
    let release;
    db.gate = new Promise((res) => { release = res; });
    askAboutQuestion(QUESTION, "q-1");
    await until(() => input(pane), "the thread's box");
    typeAndSend(pane, "which one survives a reinstall?");
    input(pane).value = "typed while it ran";
    askAboutQuestion({ question: "Ship it today?", options: [{ label: "Yes" }] }, "q-2");
    await until(() => title(pane) === "Ship it today?", "the second card's thread");
    release();
    // The card's reply handling is chained on this promise ahead of us, so after
    // it and one more tick the reply has been taken in (the draft rekeyed).
    await db.lastSend;
    await wait(0);
    askAboutQuestion(QUESTION, "q-1");
    await until(() => kind(pane) === "Thread", "the answered thread");
    expect(input(pane).value).toBe("typed while it ran");
  });

  it("gives a later card with the same words a fresh thread", async () => {
    const { pane, r } = mountPane("chat-repeat");
    new ChatDashboard(pane, r);
    await wait();
    askAboutQuestion(QUESTION, "q-1");
    await until(() => input(pane), "the thread's box");
    typeAndSend(pane, "which one survives a reinstall?");
    await until(() => kind(pane) === "Thread", "the reply");
    card(pane).querySelector("[data-ax='close-thread']").click();
    await until(() => card(pane)?.querySelector(".ax-face"), "the answer face");
    askAboutQuestion(QUESTION, "q-2");
    await until(() => kind(pane) === "About a question", "a fresh thread");
    expect(card(pane).querySelector(".ax-tbody .ax-q"), "a fresh thread holds no earlier exchange").toBeNull();
    typeAndSend(pane, "and on a new machine?");
    await until(() => db.sends.length === 2, "the second send");
    expect(db.sends.map((s) => s.key)).toEqual([null, null]);
  });

  it("keeps a half-typed follow-up when a card's Ask switches threads", async () => {
    const { pane, r } = mountPane("chat-draft");
    new ChatDashboard(pane, r);
    await wait();
    askAboutQuestion(QUESTION, "q-1");
    await until(() => input(pane), "the thread's box");
    typeAndSend(pane, "which one survives a reinstall?");
    await until(() => kind(pane) === "Thread", "the reply");
    input(pane).value = "half a follow-up";
    const ship = { question: "Ship it today?", options: [{ label: "Yes" }, { label: "No" }] };
    askAboutQuestion(ship, "q-2");
    await until(() => title(pane) === "Ship it today?", "the second card's thread");
    expect(input(pane).value).toBe("");
    card(pane).querySelector("[data-ax='close-thread']").click();
    await until(() => card(pane)?.querySelector("[data-ax='reply']"), "the answer face");
    card(pane).querySelector("[data-ax='reply']").click();
    expect(input(pane).value).toBe("half a follow-up");
    // Sent, it is gone: switching away and back shows an empty box, not the old text.
    typeAndSend(pane, input(pane).value);
    expect(db.sends.at(-1).question).toBe("half a follow-up");
    askAboutQuestion(ship, "q-2");
    await until(() => title(pane) === "Ship it today?", "the second card's thread");
    card(pane).querySelector("[data-ax='close-thread']").click();
    await until(() => card(pane)?.querySelector("[data-ax='reply']"), "the answer face");
    card(pane).querySelector("[data-ax='reply']").click();
    expect(input(pane).value).toBe("");
  });

  it("is left alone where no dashboard holds the card, so the card stays up", async () => {
    expect(askAboutQuestion(QUESTION), "no dashboard at all").toBe(false);
    const { pane, r } = mountPane("chat-other", { withCard: false });
    new ChatDashboard(pane, r);
    const elsewhere = document.createElement("div");
    elsewhere.id = "prompt-card-host";
    document.body.appendChild(elsewhere);
    expect(askAboutQuestion(QUESTION), "the card is not in this dashboard's pane").toBe(false);
    await wait();
    expect(card(pane)).toBeNull();
  });
});
