// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/answers-model.ts, src/views/sessions/chat-dashboard/answers-api.ts

// The Answers card's data (src/shared/chat/dashboard/answers-model.ts): which
// rows are answers, the rewritten question and its fallback, unread after a
// thread reply, + questions from Ask threads, and History's grouping.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const {
  buildAnswerItems, clipPreview, PREVIEW_MAX, isUnread, nextUnread, historyGroups, parseQuestionReply, emptyStore, threadText, withoutSuggestion,
} = await import("../src/shared/chat/dashboard/answers-model.ts");
const { normaliseStore } = await import("../src/views/sessions/chat-dashboard/answers-api.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const SEND = "mcp__cc_conductor__send_message";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });

function chat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  const api = {
    r,
    joe(text) { r.handleEvent(userEvent(text)); return api; },
    send(input, id = `m${++seq}`, ts = 0) { r.handleEvent(toolUseEvent(SEND, input, id, ts)); r.handleEvent(ok(id)); return api; },
    items(side) { return buildAnswerItems(r.messages, side); },
  };
  return api;
}

const thread = (id, msgs) => ({
  id, created_at: 0, updated_at: 0, sidecar_session_id: null,
  messages: msgs.map(([role, text, ts]) => ({ role, text, ts })),
});

describe("answers model", () => {
  it("shows Claude's rewritten question, keeps Joe's words for hover, and falls back to them", () => {
    const items = chat()
      .joe("does it link tr- numbers like the shortcut ones?")
      .send({ kind: "answer", verdict: "Yes", text: "Once the board confirms.", question: "Do tr- numbers link the way sc- numbers do?" }, "a1")
      .joe("token needs write?")
      .send({ kind: "answer", verdict: "No", text: "Read is enough." }, "a2")
      .items();
    expect(items.map((i) => i.key)).toEqual(["a1", "a2"]);
    expect(items[0].question).toBe("Do tr- numbers link the way sc- numbers do?");
    expect(items[0].raw).toBe("does it link tr- numbers like the shortcut ones?");
    expect(items[1].question).toBe("token needs write?");
    expect(items[1].raw).toBeNull();
    expect(items[1].verdict).toBe("No");
  });

  it("never shows Joe's whole message as the question: a clipped preview until a short one exists", () => {
    const wall = "first fix the build and bump the version, then tidy the sidebar label, and also does the token need write access to the board? after that rename the old branch and update the readme";
    const c = chat().joe(wall).send({ kind: "answer", verdict: "No", text: "Read is enough." }, "a1");
    const [bare] = c.items();
    expect(bare.provisional).toBe(true);
    expect(bare.question.length).toBeLessThanOrEqual(PREVIEW_MAX + 1);
    expect(bare.question.endsWith("\u2026")).toBe(true);
    expect(wall.startsWith(bare.question.slice(0, -1))).toBe(true);
    expect(bare.raw).toBe(wall);
    expect(bare.typed).toBe(wall);

    const made = emptyStore();
    made.rewrites.a1 = "Does the token need write access?";
    const [done] = c.items({ store: made, threads: [] });
    expect(done.provisional).toBe(false);
    expect(done.question).toBe("Does the token need write access?");
    expect(done.raw).toBe(wall);

    // The send_message's own question still wins over a stored one.
    const [own] = chat().joe(wall).send({ kind: "answer", verdict: "No", text: "t", question: "Their own?" }, "a1").items({ store: made, threads: [] });
    expect(own.question).toBe("Their own?");
    expect(own.provisional).toBe(false);
  });

  it("clips at a word and leaves a short message alone", () => {
    expect(clipPreview("write access?")).toBe("write access?");
    const [short] = chat().joe("write access?").send({ kind: "answer", verdict: "No", text: "t" }, "s1").items();
    expect(short.question).toBe("write access?");
    expect(short.provisional).toBe(false);
    const out = clipPreview(("word ".repeat(40)).trim());
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX + 1);
    expect(out.endsWith("word\u2026")).toBe(true);
  });

  it("counts a rating as an answer but never a plan, report, request or kindless message", () => {
    const items = chat()
      .joe("rate it")
      .send({ kind: "rating", verdict: "7/10", text: "Solid." })
      .send({ kind: "plan", text: "Read, then fix" })
      .send({ kind: "report", verdict: "Built", text: "done" })
      .send({ kind: "call", verdict: "Kept X", text: "x" })
      .send({ text: "legacy" })
      .items();
    expect(items.map((i) => i.verdict)).toEqual(["7/10"]);
  });

  it("is unread until Got it, and unread again when its thread replies after that", () => {
    const [item] = chat().joe("q?").send({ kind: "answer", verdict: "Y", text: "t" }, "k1").items();
    const store = emptyStore();
    expect(isUnread(item, store)).toBe(true);
    store.read.k1 = 1000;
    expect(isUnread(item, store)).toBe(false);

    store.threads.k1 = "th";
    const side = { store, threads: [thread("th", [["user", "and if not?", 1500], ["assistant", "Then plain text.", 2000]])] };
    const [withThread] = chat().joe("q?").send({ kind: "answer", verdict: "Y", text: "t" }, "k1").items(side);
    expect(withThread.replies).toBe(1);
    expect(isUnread(withThread, store)).toBe(true);
    store.read.k1 = 2500;
    expect(isUnread(withThread, store)).toBe(false);
    expect(threadText(withThread)).toContain("Then plain text.");
  });

  it("turns a + question's Ask thread into an answer once it has a reply", () => {
    const store = emptyStore();
    store.questions.push({ thread_id: "nq", asked_at: 10 }, { thread_id: "waiting", asked_at: 20 });
    const side = {
      store,
      threads: [
        thread("nq", [["user", "does trello need a paid plan?", 10], ["assistant", "QUESTION: Does Trello need a paid plan?\nVERDICT: No, the free plan works\n\nThe key works on any plan.\nSUGGESTED: add a note", 30]]),
        thread("waiting", [["user", "still thinking?", 20]]),
      ],
    };
    const items = chat().items(side);
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it.key).toBe("ask:nq");
    expect(it.asked).toBe(true);
    expect(it.question).toBe("Does Trello need a paid plan?");
    expect(it.raw).toBe("does trello need a paid plan?");
    expect(it.verdict).toBe("No, the free plan works");
    expect(it.text).toBe("The key works on any plan.");
    expect(it.message.card.verdict).toBe("No, the free plan works");
    // Its own first question and reply are the thread's opening, not a back-and-forth.
    expect(it.replies).toBe(0);
    expect(isUnread(it, store)).toBe(true);
  });

  it("falls back to Joe's words and the reply's first line without the two marker lines", () => {
    expect(parseQuestionReply("Yes.\nMore here.")).toEqual({ question: null, verdict: null, body: "Yes.\nMore here." });
    expect(parseQuestionReply("**QUESTION: Q?**\n**VERDICT: V**\n\nBody")).toEqual({ question: "Q?", verdict: "V", body: "Body" });
    expect(withoutSuggestion("Answer.\nSUGGESTED: do it")).toBe("Answer.");
    const store = emptyStore();
    store.questions.push({ thread_id: "p", asked_at: 1 });
    const [it] = chat().items({ store, threads: [thread("p", [["user", "is it fast?", 1], ["assistant", "Yes, about 2ms.\nMeasured on the box.", 2]])] });
    expect(it.question).toBe("Is it fast?");
    expect(it.verdict).toBe("Yes, about 2ms.");
    expect(it.text).toBe("Measured on the box.");
  });

  it("walks back to the newest unread, then to none", () => {
    const items = chat().joe("a").send({ kind: "answer", verdict: "1", text: "x" }, "u1").joe("b").send({ kind: "answer", verdict: "2", text: "x" }, "u2").items();
    const store = emptyStore();
    expect(nextUnread(items, store).key).toBe("u2");
    store.read.u2 = 1;
    expect(nextUnread(items, store).key).toBe("u1");
    store.read.u1 = 1;
    expect(nextUnread(items, store)).toBeNull();
  });

  it("is read when the chat judges Joe's next message shows he read it, by verdict", () => {
    const items = chat()
      .joe("token needs write?")
      .send({ kind: "answer", verdict: "No, read-only is enough", text: "t" }, "r1", 100)
      .joe("ask about the board id")
      .send({ kind: "answer", verdict: "One board per project", text: "t" }, "r2", 200)
      .joe("ok, and  NO, READ-ONLY IS ENOUGH  then? also the board one makes sense")
      // An ack is often the first message of a turn: it carries the judgement too.
      .send({ kind: "ack", text: "On it", read_answers: ["no, read-only is enough", "One board per project", "Never sent"] }, "j1", 300)
      .items();
    const store = emptyStore();
    expect(items.map((i) => [i.key, i.seenAt])).toEqual([["r1", 300_000], ["r2", 300_000]]);
    expect(items.every((i) => !isUnread(i, store))).toBe(true);
  });

  it("never marks an answer Joe could not have read: one sent after his latest message", () => {
    const items = chat()
      .joe("q1")
      .send({ kind: "answer", verdict: "Same", text: "old" }, "o1", 100)
      .joe("q2")
      // Same turn: the new answer lands, then a later message judges "Same". Only the
      // one from before Joe's message counts, even though the newer shares its verdict.
      .send({ kind: "answer", verdict: "Same", text: "new" }, "o2", 200)
      .send({ kind: "report", verdict: "Done", text: "d", read_answers: ["Same"] }, "o3", 210)
      .items();
    const store = emptyStore();
    expect(isUnread(items[0], store)).toBe(false);
    expect(isUnread(items[1], store)).toBe(true);
  });

  it("leaves answers unread when the judgement names none, and a later thread reply unreads a judged one", () => {
    const quiet = chat().joe("q").send({ kind: "answer", verdict: "V", text: "t" }, "q1", 100).joe("new topic").send({ kind: "ack", text: "ok" }, "q2", 200).items();
    expect(isUnread(quiet[0], emptyStore())).toBe(true);

    // A retracted message's judgement no longer counts.
    const c = chat().joe("q").send({ kind: "answer", verdict: "V", text: "t" }, "x1", 100).joe("ok").send({ kind: "ack", text: "ok", read_answers: ["V"] }, "x2", 200);
    expect(c.items()[0].seenAt).toBe(200_000);
    const ack = c.r.messages.find((m) => m.id === "x2");
    ack.retracted = true;
    expect(c.items()[0].seenAt).toBe(0);

    const store = emptyStore();
    store.threads.t1 = "th";
    const side = { store, threads: [thread("th", [["user", "and?", 400_000], ["assistant", "More.", 500_000]])] };
    const [it] = chat().joe("q").send({ kind: "answer", verdict: "V", text: "t" }, "t1", 100).joe("thanks").send({ kind: "ack", text: "ok", read_answers: ["V"] }, "t2", 300).items(side);
    expect(it.seenAt).toBe(300_000);
    expect(isUnread(it, store)).toBe(true);
  });

  it("groups History as Unread, Read with a thread, then Read, newest first, with headings only for two groups", () => {
    const c = chat();
    for (const k of ["h1", "h2", "h3", "h4"]) c.joe(`question ${k}`).send({ kind: "answer", verdict: k, text: "t" }, k);
    const store = emptyStore();
    let { groups, headings } = historyGroups(c.items({ store, threads: [] }), store);
    expect(groups.map((g) => g.label)).toEqual(["Unread"]);
    expect(groups[0].items.map((i) => i.key)).toEqual(["h4", "h3", "h2", "h1"]);
    expect(headings).toBe(false);

    store.read = { h1: 5, h2: 5, h3: 5 };
    store.threads.h1 = "t1";
    const side = { store, threads: [thread("t1", [["user", "more?", 1], ["assistant", "no", 2]])] };
    ({ groups, headings } = historyGroups(c.items(side), store));
    expect(groups.map((g) => [g.label, g.items.map((i) => i.key)])).toEqual([
      ["Unread", ["h4"]],
      ["Read, with a thread", ["h1"]],
      ["Read", ["h3", "h2"]],
    ]);
    expect(headings).toBe(true);
  });

  it("reads the daemon's state defensively", () => {
    expect(normaliseStore(null)).toEqual(emptyStore());
    expect(normaliseStore({ read: { a: 1 }, questions: [{ thread_id: "t", asked_at: 2 }, { bogus: 1 }] }))
      .toEqual({ read: { a: 1 }, threads: {}, questions: [{ thread_id: "t", asked_at: 2 }], rewrites: {} });
  });
});
