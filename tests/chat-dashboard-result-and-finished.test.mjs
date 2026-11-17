// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/done-card.ts

// Joe, 2026-11-14: the Result is its own card, apart from the plan steps, and a
// chat that goes idle always leaves an update, whatever kind its closing message
// was; a finished sub waits in the Done card (one row per task) until he dismisses it.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, todoIdOf, taskTitle } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { renderZone, initialUi } = await import("../src/views/sessions/chat-dashboard/dashboard-zones.ts");
const { subCardRow, SUBCARD_TOOL } = await import("../src/shared/chat/subchat-cards.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const SEND = "mcp__cc_conductor__send_message";
const STATUS = "mcp__cc_conductor__report_turn_status";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });

function chat() {
  const r = new ChatRenderer(document.body.appendChild(document.createElement("div")));
  const api = {
    r,
    joe(text) { r.handleEvent(userEvent(text)); return api; },
    send(input) { const id = `m${++seq}`; r.handleEvent(toolUseEvent(SEND, input, id)); r.handleEvent(ok(id)); return api; },
    status(status) { const id = `s${++seq}`; r.handleEvent(toolUseEvent(STATUS, { status }, id)); r.handleEvent(ok(id)); return api; },
    dash(extra = {}) { return deriveDashboard({ messages: r.messages, plans: r.dashPlans, ...extra }); },
  };
  return api;
}
const zone = (d, id) => [...d.left, ...d.right].find((z) => z.id === id)?.state ?? null;

describe("Result", () => {
  it("shows the closing message of a chat whatever its kind, so an idle chat always leaves an update", () => {
    for (const kind of ["report", "call", "discovery", "handoff", "correction", "artifact"]) {
      const d = chat().joe("go").send({ kind, verdict: `V ${kind}`, text: "t" }).status("done").dash();
      expect(zone(d, "result")?.message.card.kind, kind).toBe(kind);
    }
  });

  it("leaves out the kinds that already have a card: answer, rating, blocker, do_this and plan", () => {
    for (const kind of ["answer", "rating", "blocker", "do_this", "plan"]) {
      const d = chat().joe("go").send({ kind, verdict: `V ${kind}`, text: "t" }).status("done").dash();
      expect(zone(d, "result"), kind).toBeNull();
    }
  });

  it("takes a message only once its turn closed, so a note mid-turn never replaces the last result", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "First", text: "t" }).status("done")
      .joe("b").send({ kind: "call", verdict: "Mid-turn", text: "t" }).status("working");
    expect(zone(c.dash(), "result").message.card.verdict).toBe("First");
    expect(zone(c.dash(), "result").stale).toBe(true);
    c.status("done");
    expect(zone(c.dash(), "result").message.card.verdict).toBe("Mid-turn");
    expect(zone(c.dash(), "result").stale).toBe(false);
  });

  it("goes stale once Joe writes after it, and stays until the next result", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "Built", text: "t" }).status("done");
    expect(zone(c.dash(), "result").stale).toBe(false);
    c.joe("and?").send({ kind: "answer", verdict: "Yes", text: "t" }).status("done");
    expect(zone(c.dash(), "result").message.card.verdict).toBe("Built");
    expect(zone(c.dash(), "result").stale).toBe(true);
  });

  it("is a card of its own on the left, under Answers, and Notes does not repeat it", () => {
    const d = chat().joe("a").send({ kind: "call", verdict: "Went with B", text: "t" }).status("done").dash();
    expect(d.left.map((z) => z.id)).toEqual(["answers", "result"]);
    expect(d.right.map((z) => z.id)).toEqual(["plan"]);
    expect(zone(d, "notes")).toBeNull();
  });

  it("goes once Joe says Got it, and the Plan card keeps its title and subtitle as a summary", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "Built, not pushed", text: "Footer shows the last update\nThree files changed" }).status("done");
    const key = zone(c.dash(), "result").key;
    expect(key).toBeTruthy();
    const d = c.dash({ dismissed: new Set([key]) });
    expect(zone(d, "result")).toBeNull();
    expect(zone(d, "plan").resultSummary).toMatchObject({ key, title: "Built, not pushed", subtitle: "Footer shows the last update" });
    // Not dismissed: no summary row.
    expect(zone(c.dash(), "plan").resultSummary).toBeNull();
  });

  it("does not fall back to an older result once the newest is dismissed", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "Old", text: "t" }).status("done")
      .joe("b").send({ kind: "call", verdict: "New", text: "t" }).status("done");
    const d = c.dash({ dismissed: new Set([zone(c.dash(), "result").key]) });
    expect(zone(d, "result")).toBeNull();
    expect(zone(d, "plan").resultSummary.title).toBe("New");
  });

  it("titles a kind with no verdict from its text: the first line, then the next as the subtitle", () => {
    const c = chat().joe("a").send({ kind: "handoff", text: "Passing the sign-in work to Lenar\nHe has the token" }).status("done");
    const d = c.dash({ dismissed: new Set([zone(c.dash(), "result").key]) });
    expect(zone(d, "plan").resultSummary).toMatchObject({ title: "Passing the sign-in work to Lenar", subtitle: "He has the token" });
  });

  it("draws a tinted card with a Got it button, and the summary row opens the result inside the Plan card", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "Built", text: "Footer shows it" }).status("done");
    const live = zone(c.dash(), "result");
    const html = renderZone("result", live, { ui: initialUi(), busy: false });
    expect(html).toContain('data-act="result-dismiss"');
    expect(html).toContain(`data-wkey="${live.key}"`);
    // In the header, ahead of the body: a tall result scrolls the left column and must not hide the button.
    expect(html.indexOf('data-act="result-dismiss"')).toBeLessThan(html.indexOf("cdash-pbody"));
    const dismissed = c.dash({ dismissed: new Set([live.key]) });
    const plan = zone(dismissed, "plan");
    const closed = renderZone("plan", plan, { ui: initialUi(), busy: false });
    expect(closed).toContain("cdash-rsum");
    expect(closed).toContain("Open result");
    expect(closed).toContain("Footer shows it");
    expect(closed).not.toContain("cdash-result");
    const open = renderZone("plan", plan, { ui: { ...initialUi(), resultOpen: live.key }, busy: false });
    expect(open).toContain("Hide result");
    expect(open).toContain('<div class="cdash-result">');
  });

  it("renders the sub-less card dimmed when stale", () => {
    const c = chat().joe("a").send({ kind: "report", verdict: "Built", text: "t" }).status("done").joe("more");
    const html = renderZone("result", zone(c.dash(), "result"), { ui: initialUi(), busy: false });
    expect(html).toContain("cdash-resultcard is-stale");
    expect(html).toContain("cdash-dim");
    expect(html).toContain("Built");
  });
});

const sub = (id, over = {}) => ({
  id, name: `job-${id}`, kind: "finished", closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "finished", startedAt: null, finishedAt: 1_000, ring: { kind: "none" }, ...over,
});
const entry = (id, ts, over = {}) => ({
  id: `card-${id}`, ts, parent_id: "main", kind: "finish", sub_id: id, sub_name: `job-${id}`, round: 1, model: "sonnet", effort: "high",
  verdict: `Verdict ${id}`, tone: "good", text: `Report text ${id}`, points: [], done: ["Built it"], not_done: [], waiting_on: [], your_move: [],
  facts: null, sum: null, set_key: null, ...over,
});
const row = (e) => subCardRow({ tool_name: SUBCARD_TOOL, input: e });
const derive = (input) => deriveDashboard({ messages: [], plans: [], ...input });

describe("Done card", () => {
  it("lists finished subs only, newest task first, and keeps them past the old one-hour fold", () => {
    const d = derive({
      now: 1_000 + 5 * 3_600_000,
      subs: [sub("old", { finishedAt: 1_000 }), sub("new", { finishedAt: 9_000 }), sub("busy", { kind: "working" })],
    });
    expect(zone(d, "done").tasks.map((t) => t.subs[0].sub.id)).toEqual(["new", "old"]);
    expect(zone(d, "done").subCount).toBe(2);
    // The live sub stays on the Subchats card; the finished ones left it, folded or not.
    expect(zone(d, "subchats").shown.map((i) => i.id)).toEqual(["busy"]);
    expect(zone(d, "subchats").earlier).toEqual([]);
  });

  it("draws nothing with no finished sub", () => {
    expect(zone(derive({ subs: [sub("busy", { kind: "working" })] }), "done")).toBeNull();
    expect(zone(derive({}), "done")).toBeNull();
  });

  it("groups the subs of one todo into one task, by the id in a sub's name or its latest verdict", () => {
    const d = derive({
      messages: [row(entry("c", 3_000, { verdict: "pc-0031: review fixes in, still a go" }))],
      subs: [
        sub("a", { name: "pc-0031-build-chip", finishedAt: 1_000, startedAt: "2026-11-17T08:00:00Z" }),
        sub("b", { name: "pc-0031-review", finishedAt: 2_000, startedAt: "2026-11-17T09:00:00Z" }),
        // Names the todo only in its verdict.
        sub("c", { name: "second-look", finishedAt: 3_000, startedAt: "2026-11-17T10:00:00Z" }),
        sub("z", { name: "pc-0032-other", finishedAt: 500 }),
      ],
    });
    const tasks = zone(d, "done").tasks;
    expect(tasks.map((t) => [t.key, t.subs.map((i) => i.sub.id)])).toEqual([
      ["todo:pc-0031", ["c", "b", "a"]],
      ["todo:pc-0032", ["z"]],
    ]);
    // The first sub to start names the task, and the todo id never leads the title.
    expect(tasks[0].title).toBe("Build chip");
    expect(tasks[0].todoId).toBe("pc-0031");
    expect(tasks[0].doneAt).toBe(3_000);
  });

  it("groups a todo-less sub by its task name and keeps different names apart", () => {
    const d = derive({
      subs: [sub("a", { name: "fix-footer", finishedAt: 3_000 }), sub("b", { name: "Fix footer", finishedAt: 2_000 }), sub("c", { name: "chip-order", finishedAt: 1_000 })],
    });
    const tasks = zone(d, "done").tasks;
    expect(tasks.map((t) => [t.title, t.todoId, t.subs.length])).toEqual([["Fix footer", null, 2], ["Chip order", null, 1]]);
  });

  it("keeps unnamed chats apart: the New chat placeholder is no task name", () => {
    const d = derive({ subs: [sub("a", { name: "New chat", finishedAt: 2_000 }), sub("b", { name: "New chat", finishedAt: 1_000 })] });
    expect(zone(d, "done").tasks.map((t) => t.subs.map((i) => i.sub.id))).toEqual([["a"], ["b"]]);
  });

  it("reads a todo id only as a whole id: utf-8, gpt-4 and a hex session id are not todos", () => {
    expect(todoIdOf("utf-8 fix", "gpt-4 notes")).toBeNull();
    expect(todoIdOf("sub-b5c4f82f", "")).toBeNull();
    // A dated name is not a todo, a slug after a real id still is.
    expect(todoIdOf("audit-2026-11-16", "")).toBeNull();
    expect(todoIdOf("pc-0031-build-chip", "")).toBe("pc-0031");
    expect(todoIdOf("Mac2-0007 sync", "")).toBe("mac2-0007");
    // Only the verdict's lead counts: a todo mentioned late in a long verdict is not the task.
    expect(todoIdOf("polish", `${"x".repeat(60)} pc-0031`)).toBeNull();
    expect(taskTitle("pc-0031-review_fixes")).toBe("Review fixes");
    expect(taskTitle("pc-0031")).toBe("");
  });

  it("pairs each sub with its latest finish card, from a loaded row or the renderer's pool", () => {
    const early = entry("a", 1_000);
    const late = entry("a", 5_000, { id: "card-a2", verdict: "Second round" });
    const poolOnly = entry("b", 2_000);
    const d = derive({
      messages: [row(early)],
      subCards: [early, late, poolOnly],
      subs: [sub("a", { finishedAt: 5_000 }), sub("b", { finishedAt: 2_000 }), sub("c", { finishedAt: 1_500 })],
    });
    const by = Object.fromEntries(zone(d, "done").tasks.flatMap((t) => t.subs).map((i) => [i.sub.id, i.report?.subCard?.verdict ?? null]));
    expect(by).toEqual({ a: "Second round", b: "Verdict b", c: null });
  });

  it("does not use a row the transcript dropped", () => {
    const e = entry("a", 2_000);
    const d = derive({ messages: [{ ...row(e), retracted: true }], subs: [sub("a")] });
    expect(zone(d, "done").tasks[0].subs[0].report).toBeNull();
  });

  const doneCtx = (over = {}) => ({
    ui: initialUi(), busy: false, ctxChip: (id) => `<span class="sb-chip sb-context">${id === "a" ? "41" : "90"}%</span>`,
    ctxPct: (id) => (id === "a" ? 41 : 90), ...over,
  });
  const twoChatTask = () => zone(derive({
    messages: [row(entry("a", 2_000, { verdict: "pc-0031: first pass" })), row(entry("b", 4_000, { verdict: "pc-0031: review fixes in" }))],
    subs: [sub("a", { name: "pc-0031-build", finishedAt: 2_000, startedAt: "2026-11-17T08:00:00Z" }), sub("b", { name: "pc-0031-review", finishedAt: 4_000, startedAt: "2026-11-17T09:00:00Z" })],
  }), "done");

  it("draws one row per task with its title, chat count, time and a warning over the context limit, and no per-chat rows", () => {
    const html = renderZone("done", twoChatTask(), doneCtx());
    expect(html.match(/class="dn-task/g)).toHaveLength(1);
    expect(html).toContain("Build");
    expect(html).toContain("2 chats");
    expect(html).toContain("dn-warn");
    expect(html).toContain('data-act="done-dismiss"');
    expect(html).toContain('data-act="done-clear"');
    expect(html).not.toContain("review fixes in");
    // Under the limit: no warning.
    expect(renderZone("done", twoChatTask(), doneCtx({ ctxPct: () => 79 }))).not.toContain("dn-warn");
    // Nothing read yet: no warning either.
    expect(renderZone("done", twoChatTask(), doneCtx({ ctxPct: () => null }))).not.toContain("dn-warn");
  });

  it("counts one chat as '1 chat'", () => {
    expect(renderZone("done", zone(derive({ subs: [sub("a")] }), "done"), doneCtx())).toContain("1 chat<");
  });

  it("opens the details: the todo id with an Open todo button, then each chat with its time and context; its finish card only when picked", () => {
    const state = twoChatTask();
    const key = state.tasks[0].key;
    const open = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneOpen: key } }));
    expect(open).toContain("pc-0031");
    expect(open).toContain('data-act="done-todo" data-todo="pc-0031"');
    expect(open).toContain("pc-0031: review fixes in");
    expect(open).toContain("pc-0031: first pass");
    expect(open).toContain("41%");
    expect(open).not.toContain("Report text b");
    const card = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneOpen: key, doneCard: "b" } }));
    expect(card).toContain("Report text b");
  });

  it("gives a task with no todo no Open todo button", () => {
    const state = zone(derive({ subs: [sub("a", { name: "fix-footer" })] }), "done");
    const html = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneOpen: state.tasks[0].key } }));
    expect(html).not.toContain("done-todo");
  });

  it("marks a task leaving once every one of its subs is dismissed", () => {
    const state = twoChatTask();
    const half = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneLeaving: new Set(["a"]) } }));
    expect(half).not.toContain("is-leaving");
    const all = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneLeaving: new Set(["a", "b"]) } }));
    expect(all).toContain("is-leaving");
  });

  it("leaves a task whose other chat is already closing once its live chats are dismissed", () => {
    const state = zone(derive({ subs: [sub("a", { name: "pc-0031-a" }), sub("b", { name: "pc-0031-b", closing: true })] }), "done");
    const html = renderZone("done", state, doneCtx({ ui: { ...initialUi(), doneLeaving: new Set(["a"]) } }));
    expect(html).toContain("is-leaving");
  });

  it("offers no Dismiss on a task whose chats are all closing", () => {
    const state = zone(derive({ subs: [sub("a", { closing: true })] }), "done");
    const html = renderZone("done", state, doneCtx());
    expect(html).not.toContain("done-dismiss");
    expect(html).toContain("closing");
  });
});

describe("Answers without the From subs card", () => {
  it("still takes a sub's answer that no loaded row holds, from the renderer's pool", () => {
    const answer = entry("q", 2_000, { question: "Why?" });
    expect(zone(derive({ subCards: [answer] }), "answers").items).toHaveLength(1);
    // Once the row is loaded it is read from the row, not counted twice.
    expect(zone(derive({ messages: [row(answer)], subCards: [answer] }), "answers").items).toHaveLength(1);
  });

  it("draws no zone for a sub's finish that answers no question (the tray carries it)", () => {
    const d = derive({ messages: [row(entry("a", 2_000))], subCards: [entry("a", 2_000)] });
    expect([...d.left, ...d.right].map((z) => z.id)).not.toContain("reports");
  });
});
