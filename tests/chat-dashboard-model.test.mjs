// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/chat-renderer.ts, src/shared/chat/chat-event-handler-tools.ts, src/shared/chat/chat-dom-renderer.ts

// The chat dashboard derives every zone from the rows the ChatRenderer builds
// out of the chat's own events, plus the latest write_plan call. These drive
// real events through a real renderer and check what each zone would show.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, ZONES, isJoeMessage } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { flushRenderNow } = await import("../src/shared/chat/flush-scheduler.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
const ASK = "mcp__cc_conductor__ask_user_question";

let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });

function chat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  const api = {
    r,
    joe(text) { r.handleEvent(userEvent(text)); return api; },
    send(input) { const id = `m${++seq}`; r.handleEvent(toolUseEvent(SEND, input, id)); r.handleEvent(ok(id)); return api; },
    plan(steps) { const id = `p${++seq}`; r.handleEvent(toolUseEvent(PLAN, { steps }, id)); r.handleEvent(ok(id)); return api; },
    status(status) { const id = `s${++seq}`; r.handleEvent(toolUseEvent(STATUS, { status }, id)); r.handleEvent(ok(id)); return api; },
    ask(question, id = `q${++seq}`) { r.handleEvent(toolUseEvent(ASK, { questions: [{ question, options: [{ label: "A" }] }] }, id)); return api; },
    dash(extra = {}) { return deriveDashboard({ messages: r.messages, plan: r.dashPlan, ...extra }); },
  };
  return api;
}

const zone = (d, id) => [...d.left, ...d.right].find((z) => z.id === id)?.state ?? null;
const ids = (zones) => zones.map((z) => z.id);

describe("chat dashboard model", () => {
  it("draws nothing for a chat with no events", () => {
    const d = chat().dash();
    expect(d.strip).toBeNull();
    expect(d.left).toEqual([]);
    expect(d.right).toEqual([]);
  });

  it("puts Answers and Waiting on the left, Plan and the come-and-go cards on the right", () => {
    expect(ZONES.answers.column).toBe("left");
    expect(ZONES.waiting.column).toBe("left");
    expect(ZONES.plan.column).toBe("right");
    for (const id of ["subchats", "notes", "links"]) {
      expect(ZONES[id].column).toBe("right");
      expect(ZONES[id].order).toBeGreaterThan(ZONES.plan.order);
    }
    expect(ZONES.answers.order).toBeLessThan(ZONES.waiting.order);
  });

  it("shows the newest answer, counts the rest, and never treats a plan or report as an answer", () => {
    const c = chat()
      .joe("can it be empty?")
      .send({ kind: "answer", verdict: "Yes", text: "It can." })
      .joe("and the other one?")
      .send({ kind: "plan", text: "Read the code, then fix it" })
      .send({ text: "an old message with no kind" })
      .send({ kind: "report", verdict: "Built", text: "done" });
    const a = zone(c.dash(), "answers");
    expect(a.total).toBe(2);
    expect(a.latest.text).toBe("an old message with no kind");
  });

  it("keeps a refused or retracted message out of every zone", () => {
    const c = chat().joe("q");
    c.r.handleEvent(toolUseEvent(SEND, { kind: "answer", verdict: "No", text: "x" }, "bad"));
    c.r.handleEvent({ type: "tool_result", tool_use_id: "bad", output: { type: "text", text: "rejected" }, is_error: true, timestamp: 0 });
    expect(zone(c.dash(), "answers")).toBeNull();
  });

  it("lists only Joe's own messages in the strip", () => {
    const c = chat().joe("first").joe("second");
    c.r.messages.push({ kind: "user", content: [{ type: "text", text: "relayed" }], ts: 0, authorSessionId: "peer" });
    const d = c.dash();
    expect(d.strip.messages.map((m) => m.content[0].text)).toEqual(["first", "second"]);
    expect(isJoeMessage({ kind: "user", content: [{ type: "text", text: "   " }], ts: 0 })).toBe(false);
  });

  it("lists a blocker red above what only Joe can do and an open question, until Joe writes again", () => {
    const c = chat()
      .joe("build it")
      .ask("Tabs or spaces?")
      .send({ kind: "do_this", verdict: "Log in", text: "Open the console" })
      .send({ kind: "blocker", verdict: "Stuck on auth", text: "No token" });
    let w = zone(c.dash(), "waiting");
    expect(w.blocked).toBe(true);
    expect(w.items.map((i) => i.type)).toEqual(["blocker", "do_this", "question"]);
    expect(w.items[2].questions).toEqual(["Tabs or spaces?"]);
    c.joe("here is the token");
    w = zone(c.dash(), "waiting");
    // The question card is still open: only answering it clears it.
    expect(w.items.map((i) => i.type)).toEqual(["question"]);
    expect(w.blocked).toBe(false);
  });

  it("drops an answered question from Waiting on you", () => {
    const c = chat().joe("go").ask("Which one?", "qa");
    c.r.handleEvent(ok("qa"));
    expect(zone(c.dash(), "waiting").items[0].type).toBe("question");
    // The MCP ask is fire-and-forget: the answer comes back as Joe's next message.
    c.joe('<auq-answer id="qa"/>User answered the question(s):\nQ: Which one?\nA: A');
    const d = c.dash();
    expect(zone(d, "waiting")).toBeNull();
    // The machine-written answer is not one of Joe's messages in the strip.
    expect(d.strip.messages.map((m) => m.content[0].text)).toEqual(["go"]);
  });

  it("keeps a sub's blocker in Waiting until that sub sends a later card", () => {
    const c = chat().joe("go");
    const sub = (kind, id) => ({ kind: "message", text: "x", id, ts: 0, parentToolUseId: null, subCard: { id, ts: 0, parent_id: "main", kind, sub_id: "s1", verdict: "v", text: "x" } });
    c.r.messages.push(sub("blocker", "c1"));
    expect(zone(c.dash(), "waiting").items[0].message.id).toBe("c1");
    expect(zone(c.dash(), "subchats")).toBeNull();
    c.r.messages.push(sub("finish", "c2"));
    expect(zone(c.dash(), "waiting")).toBeNull();
    expect(zone(c.dash(), "subchats").cards.map((m) => m.id)).toEqual(["c2"]);
  });

  it("draws write_plan steps with their detail and counts finished ones", () => {
    const c = chat().joe("do it").plan([
      { text: "Read", status: "done", detail: "Read the tracker code" },
      { text: "Skip this", status: "skipped" },
      { text: "Build", status: "active" },
      { text: "Commit", status: "nonsense" },
    ]);
    const p = zone(c.dash(), "plan");
    expect(p.steps.map((s) => s.status)).toEqual(["done", "skipped", "active", "pending"]);
    expect(p.steps[0].detail).toBe("Read the tracker code");
    expect(p.done).toBe(2);
    expect(p.result).toBeNull();
  });

  it("gives the Result the Plan card's spot once the turn that sent the report closes", () => {
    // An earlier turn's status call says this chat reports its turns.
    const c = chat().joe("hi").status("done").joe("do it").plan([{ text: "Build", status: "done" }])
      .send({ kind: "report", verdict: "Built, not pushed", text: "ok", your_move: ["Push it"] });
    expect(zone(c.dash(), "plan").result).toBeNull();
    c.status("working");
    expect(zone(c.dash(), "plan").result).toBeNull();
    c.status("done");
    const p = zone(c.dash(), "plan");
    expect(p.result.card.verdict).toBe("Built, not pushed");
    expect(p.steps).toHaveLength(1);
  });

  it("treats a report as final in a chat that never reports its turn status", () => {
    const c = chat().joe("x").send({ kind: "report", verdict: "Done", text: "ok" });
    expect(zone(c.dash(), "plan").result.card.verdict).toBe("Done");
  });

  it("keeps the plan across Joe's answers mid-job, and drops it once a finished job is followed by a new message", () => {
    const c = chat().joe("job one").send({ kind: "plan", text: "First read, then build" }).plan([{ text: "Read", status: "active" }]).joe("answer to its question");
    let p = zone(c.dash(), "plan");
    expect(p.steps).toHaveLength(1);
    expect(p.lead.text).toBe("First read, then build");
    c.send({ kind: "report", verdict: "Done", text: "ok" }).status("done");
    expect(zone(c.dash(), "plan").result).not.toBeNull();
    c.joe("job two");
    p = zone(c.dash(), "plan");
    expect(p).toBeNull();
    // A turn running with no plan yet still gets the card, which hosts the status line.
    p = zone(c.dash({ busy: true }), "plan");
    expect(p.steps).toEqual([]);
    expect(p.result).toBeNull();
  });

  it("collects calls and discoveries of the current job as notes, and artifacts as links", () => {
    const c = chat().joe("a").send({ kind: "call", verdict: "Went with B", text: "B" }).send({ kind: "artifact", text: "Open the board" })
      .joe("b").send({ kind: "discovery", verdict: "Found it", text: "c" });
    const d = c.dash();
    expect(zone(d, "notes").cards.map((m) => m.card.kind)).toEqual(["discovery"]);
    expect(zone(d, "links").cards).toHaveLength(1);
    expect(ids(d.right)).toEqual(["notes", "links"]);
  });

  it("keeps the recorded plan aligned when older rows are prepended or a row is spliced out", () => {
    const c = chat().joe("a").plan([{ text: "x", status: "active" }]);
    const at = c.r.dashPlan.at;
    c.r.remapIndices((i) => i + 3);
    expect(c.r.dashPlan.at).toBe(at + 3);
    c.r.remapIndices((i) => (i > 0 ? i - 1 : i));
    expect(c.r.dashPlan.at).toBe(at + 2);
  });

  it("fires onFlushed after every flush, even one that drew no row", () => {
    const c = chat();
    let n = 0;
    c.r.onFlushed = () => { n++; };
    c.plan([{ text: "x", status: "active" }]);
    flushRenderNow(c.r);
    expect(n).toBeGreaterThan(0);
  });
});
