// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/chat-renderer.ts, src/shared/chat/chat-event-handler-tools.ts, src/shared/chat/chat-dom-renderer.ts

// The chat dashboard derives every zone from the rows the ChatRenderer builds
// out of the chat's own events, plus the latest write_plan call. These drive
// real events through a real renderer and check what each zone would show.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, ZONES, isJoeMessage, recordPlan, turnCounts } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
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
    dash(extra = {}) { return deriveDashboard({ messages: r.messages, plans: r.dashPlans, ...extra }); },
  };
  return api;
}

const zone = (d, id) => [...d.left, ...d.right].find((z) => z.id === id)?.state ?? null;
const ids = (zones) => zones.map((z) => z.id);

describe("chat dashboard model", () => {
  it("draws only an empty Answers card and an empty Plan card for a chat with no events", () => {
    const d = chat().dash();
    expect(d.strip).toBeNull();
    // Answers and Plan are always on the dashboard, even empty (Joe, 2026-11-10).
    expect(ids(d.left)).toEqual(["answers"]);
    expect(ids(d.right)).toEqual(["plan"]);
    expect(zone(d, "answers").items).toEqual([]);
    expect(zone(d, "plan").mode).toBe("empty");
    expect(zone(d, "plan").status).toEqual({ kind: "idle", since: null });
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

  it("lists only answers to Joe's questions, never a plan, a report or a kindless message", () => {
    const c = chat()
      .joe("can it be empty?")
      .send({ kind: "answer", verdict: "Yes", text: "It can." })
      .joe("and the other one?")
      .send({ kind: "plan", text: "Read the code, then fix it" })
      .send({ text: "an old message with no kind" })
      .send({ kind: "report", verdict: "Built", text: "done" });
    const a = zone(c.dash(), "answers");
    expect(a.items.map((i) => i.text)).toEqual(["It can."]);
    // A kindless message could be anything, so it is a note of the current job.
    expect(zone(c.dash(), "notes").cards.map((m) => m.text)).toEqual(["an old message with no kind"]);
  });

  it("keeps a refused or retracted message out of every zone", () => {
    const c = chat().joe("q");
    c.r.handleEvent(toolUseEvent(SEND, { kind: "answer", verdict: "No", text: "x" }, "bad"));
    c.r.handleEvent({ type: "tool_result", tool_use_id: "bad", output: { type: "text", text: "rejected" }, is_error: true, timestamp: 0 });
    expect(zone(c.dash(), "answers").items).toEqual([]);
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

  it("keeps only the newest blocker once later ones supersede it, even with no message from Joe between", () => {
    // Joe's iOS build chat (2026-11-13): it was driven by messages relayed in
    // from another chat, so Joe never wrote and all three blockers stuck.
    const c = chat()
      .joe("ship the ipa")
      .send({ kind: "blocker", verdict: "Bundle checksum mismatch, stopped", text: "x" });
    c.r.messages.push({ kind: "user", content: [{ type: "text", text: "new bundle" }], ts: 0, authorSessionId: "peer" });
    c.send({ kind: "blocker", verdict: "Commits pulled, build blocked by hook", text: "x" })
      .send({ kind: "blocker", verdict: "ipa build failed, nothing uploaded", text: "x" });
    expect(zone(c.dash(), "waiting").items.map((i) => i.message.card.verdict)).toEqual(["ipa build failed, nothing uploaded"]);
    // A report says where the chat stands now, so the last blocker goes too.
    c.send({ kind: "report", verdict: "Uploaded to TestFlight", text: "x" });
    expect(zone(c.dash(), "waiting")).toBeNull();
  });

  it("a newer blocker on Joe leaves a blocker waiting elsewhere standing, and a newer one on the same target replaces it", () => {
    const c = chat()
      .joe("go")
      .send({ kind: "blocker", verdict: "Held by the gate", text: "x", waiting_on: ["Gate 2"] })
      .send({ kind: "blocker", verdict: "Stuck on auth", text: "x" });
    expect(zone(c.dash(), "waitingElsewhere").items.map((i) => i.message.card.verdict)).toEqual(["Held by the gate"]);
    c.send({ kind: "blocker", verdict: "Still held by the gate", text: "x", waiting_on: ["Gate 2"] });
    const d = c.dash();
    expect(zone(d, "waitingElsewhere").items.map((i) => i.message.card.verdict)).toEqual(["Still held by the gate"]);
    expect(zone(d, "waiting").items.map((i) => i.message.card.verdict)).toEqual(["Stuck on auth"]);
  });

  it("leaves out a blocker, to-do or sub blocker Joe removed by hand", () => {
    const c = chat()
      .joe("go")
      .send({ kind: "do_this", verdict: "Log in", text: "x" })
      .send({ kind: "blocker", verdict: "Stuck on auth", text: "x" });
    c.r.messages.push({ kind: "message", text: "x", id: "c1", ts: 0, parentToolUseId: null, subCard: { id: "c1", ts: 0, parent_id: "main", kind: "blocker", sub_id: "s1", verdict: "Sub stuck", text: "x" } });
    const [todo, blocker] = c.r.messages.filter((m) => m.card).map((m) => m.id);
    expect(zone(c.dash(), "waiting").items).toHaveLength(3);
    expect(zone(c.dash({ dismissed: new Set([blocker, "c1"]) }), "waiting").items.map((i) => i.type)).toEqual(["do_this"]);
    expect(zone(c.dash({ dismissed: new Set([todo, blocker, "c1"]) }), "waiting")).toBeNull();
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
    c.r.messages.push(sub("finish", "c2"));
    expect(zone(c.dash(), "waiting")).toBeNull();
  });

  it("keeps a blocker that waits on something else out of Waiting on you and names the target", () => {
    const c = chat()
      .joe("go")
      .send({ kind: "blocker", verdict: "Fix waits behind the gate", text: "Held", waiting_on: ["Gate 2"] })
      .send({ kind: "blocker", verdict: "Stuck on auth", text: "No token" });
    const d = c.dash();
    // Only the unmarked blocker is Joe's to read.
    expect(zone(d, "waiting").items.map((i) => i.message.card.verdict)).toEqual(["Stuck on auth"]);
    const e = zone(d, "waitingElsewhere");
    expect(e.label).toBe("Waiting on Gate 2");
    expect(e.items.map((i) => i.message.card.verdict)).toEqual(["Fix waits behind the gate"]);
    // Same lifecycle as the other blockers: Joe writing again clears it.
    c.joe("ok");
    expect(zone(c.dash(), "waitingElsewhere")).toBeNull();
  });

  it("with only a blocker waiting elsewhere, Waiting on you is not drawn at all", () => {
    const c = chat().joe("go").send({ kind: "blocker", verdict: "Held", text: "x", waiting_on: ["Gate 2", "CI"] });
    const d = c.dash();
    expect(zone(d, "waiting")).toBeNull();
    expect(zone(d, "waitingElsewhere").label).toBe("Waiting on Gate 2, CI");
  });

  it("names a queued sub's blocker from the sub's waiting_for and a sub card's waiting_on rows", () => {
    const c = chat().joe("go");
    const card = (id, sub, extra = {}) => ({ kind: "message", text: "x", id, ts: 0, parentToolUseId: null, subCard: { id, ts: 0, parent_id: "main", kind: "blocker", sub_id: sub, verdict: "v", text: "x", ...extra } });
    const item = (id, kind, progress) => ({ id, name: id, kind, closing: false, model: "m", effort: "high", progress, startedAt: null, finishedAt: null, ring: { kind: "none" } });
    c.r.messages.push(card("c1", "s1"), card("c2", "s2"), card("c3", "s3", { waiting_on: ["the release gate"] }));
    const d = c.dash({ subs: [item("s1", "queued", "waiting for Gate 2"), item("s2", "working", "step 1 of 3")] });
    // s2 is working and names nothing: it stays Joe's to read.
    expect(zone(d, "waiting").items.map((i) => i.message.id)).toEqual(["c2"]);
    expect(zone(d, "waitingElsewhere").items.map((i) => i.message.id)).toEqual(["c1", "c3"]);
    expect(zone(d, "waitingElsewhere").label).toBe("Waiting on Gate 2, the release gate");
  });

  it("draws the Subchats card from the sub list it is given, not from the transcript", () => {
    const c = chat().joe("go");
    const sub = (id, kind, extra = {}) => ({ id, name: id, kind, closing: false, model: "claude-opus-4-8", effort: "high", progress: "", startedAt: null, finishedAt: null, ring: { kind: "none" }, ...extra });
    expect(zone(c.dash(), "subchats")).toBeNull();
    const d = c.dash({ now: 10_000_000, subs: [sub("a", "working"), sub("b", "asking")] });
    expect(zone(d, "subchats").shown.map((i) => i.id)).toEqual(["b", "a"]);
    expect([...d.right].map((z) => z.id)).toEqual(["plan", "subchats"]);
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

  it("keeps the plan across Joe's answers mid-job, and keeps the finished job as the last job once he writes again", () => {
    const c = chat().joe("job one").send({ kind: "plan", text: "First read, then build" }).plan([{ text: "Read", status: "active" }]).joe("answer to its question");
    let p = zone(c.dash(), "plan");
    expect(p.mode).toBe("current");
    expect(p.steps).toHaveLength(1);
    expect(p.lead.text).toBe("First read, then build");
    c.plan([{ text: "Read", status: "done" }]).send({ kind: "report", verdict: "Done", text: "ok" }).status("done");
    p = zone(c.dash(), "plan");
    expect(p.mode).toBe("current");
    expect(p.result.card.verdict).toBe("Done");
    // The plan never vanishes: a new message with no new plan keeps the job, as the last one.
    c.joe("a quick follow-up question");
    p = zone(c.dash({ busy: true }), "plan");
    expect(p.mode).toBe("last");
    expect(p.steps.map((s) => s.label)).toEqual(["Read"]);
    expect(p.result.card.verdict).toBe("Done");
    expect(p.earlier).toEqual([]);
  });

  it("puts a new plan on the card and the finished one behind it", () => {
    const c = chat().joe("job one").plan([{ text: "Read", status: "done" }]).send({ kind: "report", verdict: "One done", text: "ok" }).status("done")
      .joe("job two").send({ kind: "plan", text: "Two's own plan" }).plan([{ text: "Read", status: "active" }, { text: "Ship", status: "pending" }]);
    const p = zone(c.dash(), "plan");
    // Each job keeps its own lead: the second job's plan message never leads the first.
    expect(p.lead.text).toBe("Two's own plan");
    expect(p.earlier[0].lead).toBeNull();
    expect(p.mode).toBe("current");
    expect(p.result).toBeNull();
    expect(p.steps.map((s) => s.label)).toEqual(["Read", "Ship"]);
    expect(p.earlier).toHaveLength(1);
    expect(p.earlier[0].result.card.verdict).toBe("One done");
    expect(p.earlier[0].title).toBe("job one");
    expect(p.earlier[0].key).not.toBe(p.job.key);
  });

  it("names a job by its plan message, else by Joe's message, else by its first step", () => {
    const c = chat().joe("sync trello").send({ kind: "plan", text: "Add a Trello source\nthen test it" }).plan([{ text: "Read", status: "done" }]).send({ kind: "report", verdict: "v", text: "t" })
      .joe("now the due dates").plan([{ text: "Chip", status: "done" }]).send({ kind: "report", verdict: "v", text: "t" })
      .plan([{ text: "Lone step", status: "active" }]);
    const p = zone(c.dash(), "plan");
    expect(p.earlier.map((j) => j.title)).toEqual(["Add a Trello source", "now the due dates"]);
    // The third plan came with no message of its own after the report: Joe's last message names it.
    expect(p.job.title).toBe("now the due dates");
  });

  it("keeps a report with no plan as the job, then as the last job", () => {
    const c = chat().joe("x").send({ kind: "report", verdict: "Done", text: "ok" });
    expect(zone(c.dash(), "plan").mode).toBe("current");
    c.joe("thanks");
    const p = zone(c.dash(), "plan");
    expect(p.mode).toBe("last");
    expect(p.job.plan).toBeNull();
    expect(p.result.card.verdict).toBe("Done");
  });

  it("gives a follow-up's report with no plan its own job, with the plan a step back", () => {
    const c = chat().joe("job one").plan([{ text: "Read", status: "done" }]).send({ kind: "report", verdict: "One done", text: "ok" }).status("done")
      .joe("also bump the version").send({ kind: "report", verdict: "Bumped", text: "ok" }).status("done");
    const p = zone(c.dash(), "plan");
    expect(p.mode).toBe("current");
    expect(p.job.plan).toBeNull();
    expect(p.result.card.verdict).toBe("Bumped");
    expect(p.earlier.map((j) => j.result.card.verdict)).toEqual(["One done"]);
  });

  it("keys each plan by its first call, even when two calls share a timestamp", () => {
    const c = chat().joe("a");
    c.r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "A", status: "done" }] }, "pa", 5000));
    c.r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "B", status: "active" }] }, "pb", 5000));
    const p = zone(c.dash(), "plan");
    expect(p.earlier).toHaveLength(1);
    expect(p.earlier[0].key).not.toBe(p.job.key);
  });

  it("says the chat waits on Joe while a question card is open", () => {
    const c = chat().joe("go").ask("Tabs or spaces?");
    expect(zone(c.dash(), "plan").status.kind).toBe("wait");
  });

  it("collects calls and discoveries of the current job as notes, and the links an artifact names as links", () => {
    const c = chat().joe("a").send({ kind: "call", verdict: "Went with B", text: "B" }).send({ kind: "artifact", text: "Open https://example.com/board" })
      .joe("b").send({ kind: "discovery", verdict: "Found it", text: "c" }).send({ kind: "call", verdict: "Kept B", text: "d" });
    const d = c.dash();
    // The newest closing message is the Result, so the notes hold the rest of the job.
    expect(zone(d, "result").message.card.verdict).toBe("Kept B");
    expect(zone(d, "notes").cards.map((m) => m.card.kind)).toEqual(["discovery"]);
    expect(zone(d, "links").links.map((l) => l.url)).toEqual(["https://example.com/board"]);
    expect(ids(d.right)).toEqual(["plan", "result", "notes", "links"]);
  });

  it("keeps the recorded plan aligned when older rows are prepended or a row is spliced out", () => {
    const c = chat().joe("a").plan([{ text: "x", status: "active" }]);
    const at = c.r.dashPlans[0].at;
    c.r.remapIndices((i) => i + 3);
    expect(c.r.dashPlans[0].at).toBe(at + 3);
    expect(c.r.dashPlans[0].lastAt).toBe(at + 3);
    c.r.remapIndices((i) => (i > 0 ? i - 1 : i));
    expect(c.r.dashPlans[0].at).toBe(at + 2);
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

describe("recordPlan", () => {
  const step = (label, status) => ({ label, status });

  it("updates one entry for every call of the same job, stamping when each step ran", () => {
    let plans = recordPlan([], [], [step("Read", "active"), step("Ship", "pending")], 1000, "id1000");
    plans = recordPlan(plans, [], [step("Read", "done"), step("Ship", "active")], 61_000, "id61_000");
    plans = recordPlan(plans, [], [step("Read", "done"), step("Ship", "done")], 181_000, "id181_000");
    expect(plans).toHaveLength(1);
    expect(plans[0].startedAt).toBe(1000);
    expect(plans[0].steps.map((s) => [s.startedAt, s.doneAt])).toEqual([[1000, 61_000], [61_000, 181_000]]);
  });

  it("starts a step that went straight to done when the step before it finished", () => {
    let plans = recordPlan([], [], [step("A", "active"), step("B", "pending")], 1000, "id1000");
    plans = recordPlan(plans, [], [step("A", "done"), step("B", "done")], 5000, "id5000");
    expect(plans[0].steps[1].startedAt).toBe(5000);
    plans = recordPlan([], [], [step("A", "done"), step("B", "done")], 9000, "id9000");
    expect(plans[0].steps.map((s) => s.startedAt)).toEqual([9000, 9000]);
  });

  it("clears a finish time when a step is reopened", () => {
    let plans = recordPlan([], [], [step("A", "done")], 1000, "id1000");
    plans = recordPlan(plans, [], [step("A", "active")], 2000, "id2000");
    expect(plans[0].steps[0].doneAt).toBeUndefined();
    expect(plans[0].steps[0].startedAt).toBe(1000);
  });

  it("starts a new plan when no step label carries over, or a report came since", () => {
    let plans = recordPlan([], [], [step("A", "active")], 1000, "id1000");
    plans = recordPlan(plans, [], [step("B", "active")], 2000, "id2000");
    expect(plans).toHaveLength(2);
    const report = { kind: "message", text: "t", card: { kind: "report", verdict: "v" }, ts: 0 };
    plans = recordPlan(plans, [report], [step("B", "active")], 3000, "id3000");
    expect(plans).toHaveLength(3);
    expect(plans[2].at).toBe(1);
  });
});

describe("turn actions", () => {
  it("counts a turn's calls by kind, biggest first", () => {
    const a = (canon) => ({ icon: "ph-file", label: "x", canon, at: 0 });
    expect(turnCounts([a("Read"), a("Read"), a("Edit"), a("Bash"), a("mcp:cc_conductor")])).toBe("2 read · 1 edit · 1 command · 1 other");
    expect(turnCounts([])).toBe("");
  });

  it("records each tool call of the turn once, and starts over when Joe writes", () => {
    const c = chat().joe("go");
    c.r.handleEvent(toolUseEvent("Read", { file_path: "C:/a/api.ts" }, "t1"));
    c.r.handleEvent(toolUseEvent("Read", { file_path: "C:/a/api.ts" }, "t1"));
    c.r.handleEvent(toolUseEvent("Edit", { file_path: "C:/a/api.ts" }, "t2"));
    expect(c.r.turnActions.map((x) => [x.canon, x.icon])).toEqual([["Read", "ph-file"], ["Edit", "ph-pencil-simple"]]);
    expect(c.r.turnActions[1].label).toBe(c.r.lastActivity);
    c.joe("next");
    expect(c.r.turnActions).toEqual([]);
  });
});
