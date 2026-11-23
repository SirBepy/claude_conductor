// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/command-palette/palette-ui.ts

// The dashboard's Answers card (src/views/sessions/chat-dashboard/answers-card.ts)
// against a fake daemon: a Got it is stored and survives a fresh dashboard
// (a reload), the card walks back through unread answers to All caught up, and
// a thread reply after Joe left makes its answer unread again.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

// The private ask chat is switched off in the app (src/views/sessions/private-ask.ts); this file
// keeps its thread code under test until it comes back as a subchat.
globalThis.__ccPrivateAsk = true;

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");
const { setAnswersApi, setSendRetryDelay, isRetryableSendError } = await import("../src/views/sessions/chat-dashboard/answers-api.ts");
const { emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");

// jsdom has no layout; the palette scrolls its selected row into view.
Element.prototype.scrollIntoView ??= () => {};

const SEND = "mcp__cc_conductor__send_message";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });

/** A daemon in memory: the store a reload reads back, and the Ask threads. */
function fakeDaemon() {
  const db = { store: emptyStore(), threads: [], marks: [], sends: [], rewrites: [], made: {}, prewarms: [] };
  let release = null;
  db.hold = () => new Promise((res) => { release = res; });
  db.release = () => release?.();
  db.api = {
    async load() { return { store: structuredClone(db.store), threads: structuredClone(db.threads) }; },
    async mark(_sid, keys, read) {
      db.marks.push(keys);
      for (const k of keys) if (read) db.store.read[k] = Date.now(); else delete db.store.read[k];
      return structuredClone(db.store);
    },
    async rewrite(_sid, key, joe, answer) {
      db.rewrites.push({ key, joe, answer });
      if (db.rewriteGate) await db.rewriteGate;
      const q = db.made[key];
      if (q === "fail") throw new Error("model call failed");
      if (q) db.store.rewrites[key] = q;
      return structuredClone(db.store);
    },
    async prewarm(sid, key) { db.prewarms.push([sid, key]); },
    async send(req, onDelta) {
      db.sends.push(req);
      for (const d of db.deltas ?? []) onDelta?.(d);
      if (db.gate) await db.gate;
      const id = db.store.threads[req.key] ?? `th${db.threads.length + 1}`;
      let t = db.threads.find((x) => x.id === id);
      if (!t) { t = { id, created_at: 0, updated_at: 0, sidecar_session_id: null, messages: [] }; db.threads.push(t); }
      t.messages.push({ role: "user", text: req.question, ts: Date.now() });
      // The reply is stamped 1 ms ahead so a read mark taken in the same millisecond as the send
      // still leaves it newer; a test about a reply that lands while Joe watches sets replyLeadMs
      // to 0, since the read mark taken on landing must not be older than the reply.
      t.messages.push({ role: "assistant", text: "Then it stays plain text.", ts: Date.now() + (db.replyLeadMs ?? 1) });
      if (req.key) db.store.threads[req.key] = id;
      else db.store.questions.push({ thread_id: id, asked_at: Date.now() });
      return { thread: structuredClone(t), state: structuredClone(db.store) };
    },
  };
  return db;
}

let db;
beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
  db = fakeDaemon();
  setAnswersApi(db.api);
  setSendRetryDelay(0);
});
afterEach(() => { setAnswersApi(null); setSendRetryDelay(null); });

function mountPane(sessionId = "chat-1") {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  r.sessionId = sessionId;
  return { pane, r };
}
const send = (input, id = `m${++seq}`) => [toolUseEvent(SEND, input, id), ok(id)];
const feed = (r, events) => { for (const ev of events) r.handleEvent(ev); };
const wait = (ms = 10) => new Promise((res) => setTimeout(res, ms));
/** Until the card has drawn its answer or All caught up: the first draw waits on
 *  the fake daemon's load, which a busy machine can push past a fixed wait. */
const drawn = (pane) => vi.waitFor(() => expect(card(pane)?.querySelector(".ax-face, .ax-cc")).toBeTruthy(), { timeout: 3000 });

function threeAnswers(r) {
  feed(r, [
    userEvent("does it read the shortcut tracker?"),
    ...send({ kind: "answer", verdict: "It copies Shortcut's shape", text: "Same interface.", question: "Does Trello reuse the Shortcut tracker?" }, "a1"),
    userEvent("tr- links?"),
    ...send({ kind: "answer", verdict: "Yes, once the board confirms", text: "Only after Trello confirms." }, "a2"),
    userEvent("write access?"),
    ...send({ kind: "answer", verdict: "No, read-only is enough", text: "It only reads." }, "a3"),
  ]);
}

const card = (pane) => pane.querySelector(".cdash-answers");
const verdict = (pane) => card(pane).querySelector(".ax-face .mc-verdict")?.textContent ?? null;
const click = (pane, act) => card(pane).querySelector(`[data-ax='${act}']`).click();

describe("Answers card", () => {
  it("draws a sub's finish that carries Joe's question as the answer, under the sub's name", async () => {
    const { subCardEvent } = await import("../src/shared/chat/subchat-cards.ts");
    const { pane, r } = mountPane("chat-sub-answer");
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("why does gboard swipe break?"),
      subCardEvent({
        id: "finish-sub-1-1", ts: 2000, parent_id: "chat-sub-answer", kind: "finish", sub_id: "sub-1", sub_name: "phone-ime", round: 1,
        model: "opus", effort: "high", verdict: "The composer grabs focus on open", text: "Focus on open turns voice off.", question: "Why does Gboard swipe fail?",
      }),
    ]);
    await drawn(pane);
    expect(verdict(pane)).toBe("The composer grabs focus on open");
    const by = card(pane).querySelector(".ax-face .ax-by");
    expect(by.querySelector(".ax-by-name").textContent).toBe("phone-ime");
    expect(by.querySelector(".sx-face").textContent).toBe("PH");
    expect(by.querySelector(".session-model-battery")).not.toBeNull();
    expect(card(pane).querySelector(".ax-face").textContent).not.toContain("Why does Gboard swipe fail?");
    click(pane, "reply");
    expect(card(pane).querySelector(".ax-thead-v").textContent).toBe("Why does Gboard swipe fail?");
  });

  it("turns an answer's detail link into a chip that opens its popover, on the card and in its thread", async () => {
    const { pane, r } = mountPane("chat-drill");
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("why is it slow?"),
      ...send({
        kind: "answer", verdict: "The history read", text: "See [the numbers](#d:nums) for more.",
        details: [{ id: "nums", label: "The numbers", body_md: "14.6MB of usage history" }],
      }, "d1"),
    ]);
    await drawn(pane);
    const chip = card(pane).querySelector(".ax-face .drill-chip");
    expect(chip, "the detail link is a chip, not plain text").not.toBeNull();
    expect(card(pane).querySelector(".ax-face .drill-pending")).toBeNull();
    chip.click();
    expect(pane.querySelector(".drill-pop .drill-pop-body").textContent).toContain("14.6MB of usage history");
    click(pane, "reply");
    const inThread = card(pane).querySelector(".ax-tbody .drill-chip");
    expect(inThread, "the thread's first reply keeps its chip").not.toBeNull();
  });

  it("opens a detail an earlier message defined when the answer links it by the same id", async () => {
    const { pane, r } = mountPane("chat-drill-earlier");
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("list the causes"),
      ...send({
        kind: "report", verdict: "Two causes", text: "See [the causes](#d:causes).",
        details: [{ id: "causes", label: "The causes", body_md: "cache miss and cold start" }],
      }, "e1"),
      userEvent("which one matters?"),
      ...send({ kind: "answer", verdict: "The cache miss", text: "Mostly [the causes](#d:causes)." }, "e2"),
    ]);
    await drawn(pane);
    const chip = card(pane).querySelector(".ax-face .drill-chip");
    expect(chip, "an id defined earlier still resolves on the card").not.toBeNull();
    chip.click();
    expect(pane.querySelector(".drill-pop .drill-pop-body").textContent).toContain("cache miss and cold start");
  });

  it("walks Got it back through every unread answer to All caught up, storing each read", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    expect(verdict(pane)).toBe("No, read-only is enough");
    // History's badge counts the OTHER unread answers.
    expect(card(pane).querySelector("[data-ax='history'] b").textContent).toBe("2");
    expect(card(pane).querySelector(".mc-label").textContent).toContain("Answers");

    click(pane, "gotit");
    await wait(260);
    expect(verdict(pane)).toBe("Yes, once the board confirms");
    click(pane, "gotit");
    await wait(260);
    expect(verdict(pane)).toBe("It copies Shortcut's shape");
    expect(card(pane).querySelector("[data-ax='history'] b")).toBeNull();
    click(pane, "gotit");
    await wait(260);
    expect(card(pane).querySelector(".ax-cc-t").textContent).toContain("All caught up");
    expect(card(pane).querySelector(".ax-shell").classList.contains("ax-cu-both")).toBe(true);
    expect(db.marks).toEqual([["a3"], ["a2"], ["a1"]]);
  });

  it("lets a newer answer take the card over an older unread one, and turns a judged read into Next", async () => {
    const { pane, r } = mountPane("chat-newest");
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("does it read the shortcut tracker?"),
      ...send({ kind: "answer", verdict: "It copies Shortcut's shape", text: "Same interface." }, "n1"),
      userEvent("tr- links?"),
      ...send({ kind: "answer", verdict: "Yes, once the board confirms", text: "Only after Trello confirms." }, "n2"),
    ]);
    await wait(30);
    click(pane, "gotit");
    await wait(260);
    // Joe sits on the older answer, still unread.
    expect(verdict(pane)).toBe("It copies Shortcut's shape");
    feed(r, [userEvent("write access?"), ...send({ kind: "answer", verdict: "No, read-only is enough", text: "It only reads." }, "n3")]);
    await wait(30);
    expect(verdict(pane)).toBe("No, read-only is enough");
    expect(card(pane).querySelector("[data-ax='gotit']")).not.toBeNull();

    // His next message reacts to it: the chat's judgement marks it read, the card stays put,
    // and with the older one still unread the check becomes Next.
    feed(r, [userEvent("ok read-only it is"), ...send({ kind: "ack", text: "On it", read_answers: ["No, read-only is enough"] }, "n4")]);
    await wait(30);
    expect(verdict(pane)).toBe("No, read-only is enough");
    expect(card(pane).querySelector("[data-ax='gotit']")).toBeNull();
    const next = card(pane).querySelector(".ax-next[data-ax='close']");
    expect(next.textContent).toContain("1 more");
    next.click();
    await wait(30);
    expect(verdict(pane)).toBe("It copies Shortcut's shape");
    // Only Got it was stored: the judged read lives in the transcript.
    expect(db.marks).toEqual([["n2"]]);
  });

  it("keeps a Got it across a reload: a fresh dashboard reads the daemon's marks", async () => {
    db.store.read.a3 = Date.now();
    db.store.read.a2 = Date.now();
    const { pane, r } = mountPane("chat-reload");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    // a3 and a2 were read on the other window: the card opens on a1, the last unread.
    expect(verdict(pane)).toBe("It copies Shortcut's shape");
    expect(card(pane).querySelector("[data-ax='gotit']")).not.toBeNull();
  });

  it("opens Read more and keeps it open across Got it; the face shows when, never Joe's question", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    expect(card(pane).querySelector(".ax-face").classList.contains("open")).toBe(false);
    // A click anywhere off the buttons opens it too.
    card(pane).querySelector(".ax-text .mc-verdict").click();
    expect(card(pane).querySelector(".ax-face").classList.contains("open")).toBe(true);
    expect(card(pane).querySelector(".ax-readmore").textContent).toContain("Show less");
    click(pane, "gotit");
    await wait(260);
    click(pane, "gotit");
    await wait(260);
    // Still open two answers later. Joe reads the answer, not his question: it
    // opens the thread instead (Joe, 2026-11-11). The chat's own answer has no author.
    const face = card(pane).querySelector(".ax-face");
    expect(face.classList.contains("open")).toBe(true);
    expect(face.textContent).not.toContain("Does Trello reuse the Shortcut tracker?");
    expect(face.querySelector(".ax-by time")).not.toBeNull();
    expect(face.querySelector(".ax-by-name")).toBeNull();
    card(pane).querySelector(".ax-readmore").click();
    expect(face.classList.contains("open")).toBe(false);
  });

  it("shows a clipped preview of a long message until the model-written question arrives, asking once", async () => {
    const LONG = "ok a few things: please bump the version and update the readme, then tidy the sidebar label, and also does the Trello token need write access to the board or is read enough for what we do? after that rename the old branch";
    db.made = { w1: "Does the Trello token need write access?" };
    let release;
    db.rewriteGate = new Promise((res) => { release = res; });
    const { pane, r } = mountPane("chat-rewrite");
    new ChatDashboard(pane, r);
    feed(r, [userEvent(LONG), ...send({ kind: "answer", verdict: "No, read-only is enough", text: "It only reads." }, "w1")]);
    await wait(30);
    // The question heads the answer's thread, never its face.
    click(pane, "reply");
    const line = () => card(pane).querySelector(".ax-thead-v");
    expect(line().textContent.length).toBeLessThanOrEqual(91);
    expect(line().textContent.endsWith("\u2026")).toBe(true);
    expect(line().textContent).not.toContain("rename the old branch");
    expect(db.rewrites).toEqual([{ key: "w1", joe: LONG, answer: "No, read-only is enough\nIt only reads." }]);

    release();
    await wait(30);
    expect(line().textContent).toBe("Does the Trello token need write access?");
    // Re-rendering for another answer does not ask again for this one.
    feed(r, [userEvent("and the key?"), ...send({ kind: "answer", verdict: "Same", text: "Same key." }, "w2")]);
    await wait(30);
    expect(db.rewrites.map((x) => x.key)).toEqual(["w1"]);
  });

  it("asks only for the newest few answers, one at a time, and a follow-up carries Joe's whole message", async () => {
    const wall = (n) => `message ${n} ` + "word ".repeat(40);
    let release;
    db.rewriteGate = new Promise((res) => { release = res; });
    const { pane, r } = mountPane("chat-window");
    new ChatDashboard(pane, r);
    for (let i = 1; i <= 7; i++) feed(r, [userEvent(wall(i)), ...send({ kind: "answer", verdict: `V${i}`, text: "t" }, `k${i}`)]);
    await wait(30);
    // One call in flight, newest first.
    expect(db.rewrites.map((x) => x.key)).toEqual(["k7"]);
    release();
    await wait(60);
    // Only the newest five are ever asked; k1 and k2 keep their preview.
    expect(db.rewrites.map((x) => x.key)).toEqual(["k7", "k6", "k5", "k4", "k3"]);

    db.rewriteGate = null;
    // k7 is on the card with no rewrite stored (the fake returns none): its thread follow-up is told the whole message.
    card(pane).querySelector("[data-ax='reply']").click();
    await wait(30);
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "and then?";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    await wait();
    expect(db.sends[0]).toMatchObject({ key: "k7", aboutQuestion: wall(7).replace(/\s+/g, " ").trim() });
  });

  it("keeps the preview when the model call fails and does not retry it", async () => {
    db.made = { f1: "fail" };
    const { pane, r } = mountPane("chat-rewrite-fail");
    new ChatDashboard(pane, r);
    feed(r, [userEvent("ok a few things: please bump the version and update the readme, then tidy the sidebar label, and also does the Trello token need write access to the board or is read enough for what we do? after that rename the old branch"), ...send({ kind: "answer", verdict: "No", text: "t" }, "f1")]);
    await wait(30);
    feed(r, [userEvent("again?"), ...send({ kind: "answer", verdict: "Yes", text: "u" }, "f2")]);
    await wait(30);
    // A short message is its own question and costs no call.
    expect(db.rewrites.map((x) => x.key)).toEqual(["f1"]);
  });

  it("threads in place, and a reply after Joe left makes the answer unread again", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-thread");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    click(pane, "history");
    const rows = [...document.querySelectorAll(".cp-row .cp-title")].map((e) => e.textContent);
    // Rows are titled by the verdict, the answer Joe reads.
    expect(rows).toEqual(["No, read-only is enough", "Yes, once the board confirms", "It copies Shortcut's shape"]);
    // One group (all read): no headings.
    expect(document.querySelector(".ax-sec")).toBeNull();
    document.querySelectorAll(".cp-row")[1].click();
    await wait();
    expect(verdict(pane)).toBe("Yes, once the board confirms");

    click(pane, "reply");
    expect(card(pane).querySelector(".ax-thread .ax-thead-k").textContent).toBe("Thread");
    const opening = card(pane).querySelectorAll(".ax-tbody .msg");
    expect(opening[0].textContent).toContain("tr- links?");
    expect(opening[1].textContent).toContain("Yes, once the board confirms");

    let open;
    db.gate = new Promise((res) => { open = res; });
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "what if the board id is wrong?";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    await wait();
    expect(db.sends[0]).toMatchObject({ key: "a2", question: "what if the board id is wrong?", aboutQuestion: "tr- links?" });
    expect(card(pane).querySelector(".ax-tbody .ax-thinking")).not.toBeNull();
    // Back before the reply lands: the thread button blinks while Claude replies.
    click(pane, "close-thread");
    expect(card(pane).querySelector("[data-ax='reply']").classList.contains("ax-busy")).toBe(true);
    open();
    await wait(30);
    // The reply landed after Joe left: a2 is unread again and its button counts one follow-up.
    expect(verdict(pane)).toBe("Yes, once the board confirms");
    expect(card(pane).querySelector("[data-ax='gotit']")).not.toBeNull();
    expect(card(pane).querySelector("[data-ax='reply'] .ax-btn-n").textContent).toBe("1");
  });

  it("starts the thread's process when it opens and streams the reply into it", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-stream");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    click(pane, "new-q");
    // A new question warms the spare before Joe has typed a word.
    expect(db.prewarms).toEqual([["chat-stream", null]]);

    let open;
    db.gate = new Promise((res) => { open = res; });
    // A new question's reply opens with the two lines the card parses; they stay hidden while it streams.
    const head = "QUESTION: Does Trello need a paid plan?\nVERDICT: No, free works\n\n";
    db.deltas = [`${head}The free`, `${head}The free plan has the API.`];
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "does trello need a paid plan?";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    await wait();
    const live = card(pane).querySelector(".ax-tbody .ax-live");
    expect(live.textContent).toContain("No, free works");
    expect(live.textContent).toContain("The free plan has the API.");
    expect(live.textContent).not.toContain("QUESTION:");
    expect(card(pane).querySelector(".ax-tbody .ax-thinking")).toBeNull();
    open();
    await wait(30);
    expect(card(pane).querySelector(".ax-tbody .ax-live")).toBeNull();

    // Opening an answer's thread warms that thread's own process.
    click(pane, "close-thread");
    click(pane, "history");
    document.querySelectorAll(".cp-row")[1].click();
    await wait();
    db.prewarms.length = 0;
    click(pane, "reply");
    expect(db.prewarms.length).toBe(1);
    expect(db.prewarms[0][1]).not.toBeNull();
  });

  it("starts a + question whose reply lands as an unread answer", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-new");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    expect(card(pane).querySelector(".ax-cc-t").textContent).toContain("All caught up");
    click(pane, "new-q");
    expect(card(pane).querySelector(".ax-thead-k").textContent).toBe("New question");
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "does trello need a paid plan?";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    await wait(30);
    expect(db.sends[0].key).toBeNull();
    // Still in the thread, now the answer's own thread; Back shows the answer unread.
    click(pane, "close-thread");
    await wait();
    expect(verdict(pane)).toBe("Then it stays plain text.");
    expect(card(pane).querySelector("[data-ax='gotit']")).not.toBeNull();
  });

  it("shows an answer that landed during a thread on Back, and a second + starts fresh while the first is in flight", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-back");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    click(pane, "history");
    document.querySelectorAll(".cp-row")[0].click();
    await wait();
    click(pane, "reply");
    feed(r, [userEvent("and archived cards?"), ...send({ kind: "answer", verdict: "They still link, greyed", text: "x" }, "a4")]);
    await wait();
    expect(card(pane).querySelector(".ax-thread")).not.toBeNull();
    click(pane, "close-thread");
    await wait();
    expect(verdict(pane)).toBe("They still link, greyed");

    let open;
    db.gate = new Promise((res) => { open = res; });
    click(pane, "new-q");
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "first question";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    await wait();
    click(pane, "close-thread");
    click(pane, "new-q");
    // A fresh thread: no earlier question, no "reading...", and sendable.
    expect(card(pane).querySelector(".ax-thead-v").textContent).toContain("Ask anything");
    expect(card(pane).querySelector(".ax-tbody .ax-thinking")).toBeNull();
    open();
    await wait(30);
  });

  it("Back returns to the read answer Joe was on, and a failed + question reopens once with its error", async () => {
    db.store.read = { a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-fail");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    // a1 is unread; Joe picks the read a2 from History (Mark all, a1, a3, a2), opens its thread and goes Back.
    click(pane, "history");
    expect([...document.querySelectorAll(".cp-section")].map((e) => e.textContent)).toEqual(["Unread", "Read"]);
    document.querySelectorAll(".cp-row")[3].click();
    await wait();
    expect(verdict(pane)).toBe("Yes, once the board confirms");
    click(pane, "reply");
    click(pane, "close-thread");
    await wait();
    expect(verdict(pane)).toBe("Yes, once the board confirms");

    db.api.send = async () => { throw new Error("sidecar failed"); };
    click(pane, "new-q");
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = "will this fail?";
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
    click(pane, "close-thread");
    await wait(30);
    click(pane, "new-q");
    expect(card(pane).querySelector(".ax-thead-v").textContent).toBe("will this fail?");
    expect(card(pane).querySelector(".ax-error").textContent).toContain("sidecar failed");
    click(pane, "close-thread");
    click(pane, "new-q");
    expect(card(pane).querySelector(".ax-thead-v").textContent).toContain("Ask anything");
  });

  /** Types into the open thread's box and sends. */
  const ask = (pane, text) => {
    const ta = card(pane).querySelector(".ax-t-input");
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    card(pane).querySelector(".ax-t-send").click();
  };
  /** With every answer read the card says All caught up: History brings the newest back. */
  const openNewest = async (pane) => {
    click(pane, "history");
    document.querySelectorAll(".cp-row")[0].click();
    await wait();
  };
  /** The fake daemon's send, made to throw for its first `n` calls and then work as before. */
  const failFirst = (n, message = "daemon client not connected") => {
    const real = db.api.send;
    let calls = 0;
    db.api.send = async (req, onDelta) => {
      calls += 1;
      if (calls <= n) { db.sends.push(req); throw new Error(message); }
      return real(req, onDelta);
    };
  };

  it("retries a follow-up once when the send fails, with no mark and no error, and the reply lands", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-retry-once");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    failFirst(1);
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(60);
    expect(db.sends.map((s) => s.question), "one failed try and one retry, the same question").toEqual(["and the rest?", "and the rest?"]);
    expect(card(pane).querySelector(".ax-error"), "a transient failure shows nothing").toBeNull();
    expect(card(pane).querySelector(".ax-failed")).toBeNull();
    await vi.waitFor(() => expect([...card(pane).querySelectorAll(".ax-tbody .msg")].at(-1).textContent).toContain("Then it stays plain text."));
  });

  it("does not retry a failure that retrying cannot fix", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-no-retry");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    failFirst(5, "question is empty");
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(60);
    expect(db.sends).toHaveLength(1);
    expect(card(pane).querySelector(".ax-error").textContent).toContain("question is empty");
  });

  it("keeps the typed question and shows a quiet error in the thread when the retry fails too, never a mark on the thread button", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-final-fail");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    failFirst(2);
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(60);
    expect(db.sends).toHaveLength(2);
    const body = card(pane).querySelector(".ax-tbody");
    expect(body.querySelector(".ax-error").textContent).toContain("daemon client not connected");
    expect([...body.querySelectorAll(".msg.user")].at(-1).textContent, "the question stays in the thread").toContain("and the rest?");
    // Try again sends the kept question once more and the error goes.
    body.querySelector("[data-ax='retry-send']").click();
    await wait(30);
    expect(db.sends).toHaveLength(3);
    expect(card(pane).querySelector(".ax-error")).toBeNull();
    expect([...card(pane).querySelectorAll(".ax-tbody .msg")].at(-1).textContent).toContain("Then it stays plain text.");
  });

  it("a follow-up that fails after Joe left the thread draws no failed dot, and the question comes back into the box when he reopens and leaves", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-late-fail");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    let fail = null;
    const gate = new Promise((res) => { fail = res; });
    db.api.send = async () => { await gate; throw new Error("daemon client not connected"); };
    click(pane, "reply");
    ask(pane, "and the rest?");
    click(pane, "close-thread");
    const thbtn = () => card(pane).querySelector("[data-ax='reply']");
    expect(thbtn().classList.contains("ax-busy")).toBe(true);
    fail();
    await wait(60);
    expect(thbtn().classList.contains("ax-busy")).toBe(false);
    expect(thbtn().classList.contains("ax-failed"), "no red dot").toBe(false);
    expect(card(pane).querySelector(".ax-failed")).toBeNull();
    // The error waits in the thread, quietly.
    click(pane, "reply");
    expect(card(pane).querySelector(".ax-error").textContent).toContain("daemon client not connected");
    // Back: the question is not lost, it is in the box next time.
    click(pane, "close-thread");
    click(pane, "reply");
    expect(card(pane).querySelector(".ax-t-input").value).toBe("and the rest?");
    expect(card(pane).querySelector(".ax-error")).toBeNull();
  });

  it.each([
    ["picking another answer", (answers) => { answers.show("a2"); answers.show("a3"); }],
    ["Mark all as read", (answers) => { answers.markAllRead(); answers.show("a3"); }],
  ])("shows no stale error when Joe left a failed thread by %s, as Back does", async (_name, leave) => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane(`chat-leave-fail-${seq++}`);
    const dash = new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    click(pane, "history");
    document.querySelectorAll(".cp-row")[0].click();
    await wait();
    expect(verdict(pane)).toBe("No, read-only is enough");
    failFirst(2, "daemon client not connected");
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(60);
    expect(card(pane).querySelector(".ax-error")).not.toBeNull();
    leave(dash.answers);
    click(pane, "reply");
    expect(card(pane).querySelector(".ax-error"), "the error was seen when the thread was left").toBeNull();
  });

  it("flags the thread button with an unread dot when a reply lands while the thread is closed, and opening the thread clears it", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-unread-dot");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    const thbtn = () => card(pane).querySelector("[data-ax='reply']");
    expect(thbtn().classList.contains("ax-unread-reply"), "a read answer with no reply has no dot").toBe(false);
    click(pane, "reply");
    let open;
    db.gate = new Promise((res) => { open = res; });
    ask(pane, "and the rest?");
    click(pane, "close-thread");
    expect(thbtn().classList.contains("ax-unread-reply"), "still waiting: the busy blink, not the dot").toBe(false);
    open();
    await wait(30);
    expect(thbtn().classList.contains("ax-unread-reply")).toBe(true);
    expect(thbtn().title).toContain("New reply");
    click(pane, "reply");
    click(pane, "close-thread");
    expect(thbtn().classList.contains("ax-unread-reply"), "opened, so seen").toBe(false);
    // The read mark is the daemon's own: the answer is read again, not just hidden.
    expect(db.marks.at(-1)).toEqual(["a3"]);
  });

  it("puts no unread dot on an answer that was never read, ", async () => {
    db.store.read = { a1: 1, a2: 1 };
    const { pane, r } = mountPane("chat-no-dot");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    // a3 was never read: Got it is its mark, so its thread button stays plain.
    expect(card(pane).querySelector("[data-ax='gotit']")).not.toBeNull();
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(30);
    click(pane, "close-thread");
    expect(card(pane).querySelector("[data-ax='reply']").classList.contains("ax-unread-reply")).toBe(false);
  });

  it("starts a fresh question on + after a follow-up failed once Joe had left, never reopens the failed follow-up's thread", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-plus-after-fail");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    failFirst(2, "daemon client not connected");
    click(pane, "reply");
    ask(pane, "and the rest?");
    click(pane, "close-thread");
    await wait(60);
    click(pane, "new-q");
    expect(card(pane).querySelector(".ax-thead-k").textContent).toBe("New question");
    expect(card(pane).querySelector(".ax-error")).toBeNull();
    expect(db.prewarms.at(-1)).toEqual(["chat-plus-after-fail", null]);
  });

  it.each([
    ["answers_thread_send: could not reach your PC (Failed to fetch)", true],
    ["answers_thread_send: could not reach your PC (Load failed)", true],
    ["daemon client not connected", true],
    ["client closed", false],
    ["io: The pipe is being closed", false],
    ["Ask's claude exited: connection refused by the network", false],
    ["Ask got no output for 120s", false],
    ["answers_thread_send: your PC did not answer for 30s", false],
    ["question is empty", false],
    ["no Ask thread", false],
  ])("retries only a send that never reached the daemon: %s", (msg, retry) => {
    expect(isRetryableSendError(new Error(msg))).toBe(retry);
  });

  it("counts an answer Joe's later chat message judged read as read, so its reply puts the dot on and opening clears it", async () => {
    db.store.read = { a1: 1, a2: 1 };
    const { pane, r } = mountPane("chat-seen-judged");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    feed(r, [userEvent("ok read-only it is"), ...send({ kind: "ack", text: "On it", read_answers: ["No, read-only is enough"] }, "n9")]);
    await drawn(pane);
    await openNewest(pane);
    expect(card(pane).querySelector("[data-ax='gotit']"), "judged read, so no Got it").toBeNull();
    click(pane, "reply");
    let open;
    db.gate = new Promise((res) => { open = res; });
    ask(pane, "and the rest?");
    click(pane, "close-thread");
    open();
    await wait(30);
    const thbtn = () => card(pane).querySelector("[data-ax='reply']");
    expect(thbtn().classList.contains("ax-unread-reply")).toBe(true);
    click(pane, "reply");
    click(pane, "close-thread");
    expect(thbtn().classList.contains("ax-unread-reply")).toBe(false);
    expect(db.marks.at(-1)).toEqual(["a3"]);
  });

  it("does not put a failed follow-up back into a box Joe has typed in since", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    const { pane, r } = mountPane("chat-live-box");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    failFirst(2, "daemon client not connected");
    click(pane, "reply");
    ask(pane, "and the rest?");
    await wait(60);
    const box = card(pane).querySelector(".ax-t-input");
    box.value = "something else";
    box.dispatchEvent(new Event("input"));
    click(pane, "close-thread");
    click(pane, "reply");
    expect(card(pane).querySelector(".ax-t-input").value).toBe("something else");
  });

  it("leaves an answer read when its reply lands while Joe watches the thread, with no dot after Back", async () => {
    db.store.read = { a1: 1, a2: 1, a3: 1 };
    db.replyLeadMs = 0;
    const { pane, r } = mountPane("chat-watched-reply");
    new ChatDashboard(pane, r);
    threeAnswers(r);
    await drawn(pane);
    await openNewest(pane);
    click(pane, "reply");
    ask(pane, "and the rest?");
    await vi.waitFor(() => expect([...card(pane).querySelectorAll(".ax-tbody .msg")].at(-1).textContent).toContain("Then it stays plain text."));
    click(pane, "close-thread");
    expect(card(pane).querySelector("[data-ax='reply']").classList.contains("ax-unread-reply")).toBe(false);
    expect(card(pane).querySelector("[data-ax='gotit']"), "still read").toBeNull();
  });

  it("keeps the empty face's New question icon at the button's size, and the empty thread's icon large", async () => {
    const css = document.createElement("style");
    css.textContent = readFileSync(resolve("src/views/sessions/chat-dashboard/answers-card.css"), "utf8");
    document.head.appendChild(css);
    const { pane, r } = mountPane("chat-empty-face");
    new ChatDashboard(pane, r);
    await drawn(pane);
    expect(card(pane).querySelector(".ax-empty")).not.toBeNull();
    const btnIcon = card(pane).querySelector(".ax-empty [data-ax='new-q'] i");
    expect(getComputedStyle(btnIcon).fontSize).toBe("15px");
    expect(getComputedStyle(btnIcon).opacity).not.toBe("0.45");
    click(pane, "new-q");
    const threadIcon = card(pane).querySelector(".ax-tbody .ax-empty > i");
    expect(getComputedStyle(threadIcon).fontSize).toBe("1.6rem");
    css.remove();
  });

  it("Back from a thread opened off a question card expands only that card, never a newer one", async () => {
    const { setActiveCard } = await import("../src/views/sessions/permission-modal/question-state.ts");
    const { pane, r } = mountPane("chat-back-card");
    const dash = new ChatDashboard(pane, r);
    await drawn(pane);
    const live = (id) => ({ id, sessionId: "chat-back-card", teardown() {}, getDraft: () => ({}), expand: vi.fn(() => true) });
    const ask = { card: "p1#0", promptId: "p1", title: "Which one?", about: "Which one?\n\n- **A**" };

    // The asked card was answered elsewhere and a newer one came up while the thread was open.
    const newer = live("p2");
    setActiveCard(newer);
    dash.answers.askAbout(ask);
    click(pane, "close-thread");
    expect(newer.expand).not.toHaveBeenCalled();

    // Still the same card: Back brings it back.
    const same = live("p1");
    setActiveCard(same);
    dash.answers.askAbout({ ...ask, card: "p1#1" });
    click(pane, "close-thread");
    expect(same.expand).toHaveBeenCalledTimes(1);
    setActiveCard(null);
  });
});
