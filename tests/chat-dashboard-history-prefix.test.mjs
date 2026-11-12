// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/history-prefix-source.ts, src/shared/chat/dashboard/history-prefix.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts

// A forever chat (docs/forever-chat-plan.md B2): the window loads only its
// newest history page, yet the dashboard's durable zones (Answers, Plan with
// its earlier jobs, Waiting on you) must read as if the whole transcript were
// loaded. The older rows come from the transcript's digest (the Rust
// chat/dashboard_digest.rs keeps the same events `digestOf` below keeps), which
// is fetched after the page paints, so opening stays one page of work.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { deriveDashboard } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
const ASK = "mcp__cc_conductor__ask_user_question";
const DRAFT = "mcp__cc_conductor__write_draft";
const ACK = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';
/** The newest page, in events: what `load_history_page` hands the window. */
const PAGE = 200;

const result = (id, text = '{"ok":true}', ts = 0) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts });
const answerEvent = (cardId, text, ts) => ({
  type: "user_message",
  timestamp: ts,
  content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL.replace("/>", ` id="${cardId}"/>`)}User answered the question(s):\n${text}` }],
});

/** A main chat that has run for weeks: `jobs` jobs, each Joe's request, a plan
 *  that moves, `filler` ordinary tool calls, an answer to every third job, a
 *  report and a done status. Two questions sit in early jobs: one Joe never
 *  answered (still waiting on him) and one he answered only in the last job.
 *  The last job is long, so the newest page starts inside it, after its plan's
 *  first call. */
function foreverTranscript(jobs, filler, { draft = false } = {}) {
  const evs = [];
  let t = 1_762_000_000_000;
  const at = () => (t += 1000);
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const call = (tool, input) => {
    const i = id("t");
    evs.push(toolUseEvent(tool, input, i, at()), result(i, '{"ok":true}', at()));
    return i;
  };
  for (let j = 0; j < jobs; j++) {
    const last = j === jobs - 1;
    evs.push(userEvent(`Job ${j}: can you sort out part ${j}?`, at()));
    call(PLAN, { steps: [{ text: `Read part ${j}`, status: "active" }, { text: `Fix part ${j}`, status: "pending" }] });
    if (draft && j === 0) {
      const d = id("d");
      const stored = { id: "draft-old", topic: "Old note", variants: [{ recipient: "Ana", current: 1, versions: [{ n: 1, body: "Hi Ana", author: "ai" }] }] };
      evs.push(toolUseEvent(DRAFT, { action: "add", topic: "Old note", recipient: "Ana", body: "Hi Ana" }, d, at()), result(d, JSON.stringify({ ok: true, draft: stored }), at()));
    }
    if (j === 1 || j === 2) {
      const q = id("q");
      evs.push(toolUseEvent(ASK, { questions: [{ question: `Which way for part ${j}?`, header: "Way", options: [{ label: "A" }, { label: "B" }] }] }, q, at()), result(q, ACK, at()));
      if (j === 2) evs.answerLater = q;
    }
    for (let k = 0; k < (last ? 150 : filler); k++) {
      const r = id("r");
      evs.push(toolUseEvent("Read", { file_path: `src/part${j}/f${k}.ts` }, r, at()), result(r, "file body", at()));
      if (k % 4 === 0) evs.push(assistantEvent(`Reading part ${j}, file ${k}.`, at()));
    }
    call(PLAN, { steps: [{ text: `Read part ${j}`, status: "done" }, { text: `Fix part ${j}`, status: "active" }] });
    if (last) evs.push(answerEvent(evs.answerLater, "Q: Which way for part 2?\nA: B", at()));
    if (j % 3 === 0) call(SEND, { kind: "answer", verdict: `Yes for ${j}`, text: `Part ${j} reads fine.`, question: `Is part ${j} fine?` });
    if (last) break;
    call(PLAN, { steps: [{ text: `Read part ${j}`, status: "done" }, { text: `Fix part ${j}`, status: "done" }] });
    call(SEND, { kind: "report", verdict: `Part ${j} fixed`, text: `Fixed part ${j}.`, done: [`part ${j}`] });
    call(STATUS, { status: "done" });
  }
  return evs;
}

/** The Conductor tools chat/dashboard_digest.rs keeps (its CARD_TOOLS). */
const CARD_TOOLS = ["send_message", "update_message", "ask_user_question", "write_plan", "report_turn_status", "write_draft", "pr_preview", "spawn_chat", "subchat"];

/** What chat/dashboard_digest.rs keeps of a transcript. */
function digestOf(events) {
  const kept = new Set();
  const out = [];
  for (const ev of events) {
    if (ev.type === "user_message" || ev.type === "notification" || ev.type === "compacted") out.push(ev);
    else if (ev.type === "tool_use" && !ev.parent_tool_use_id) {
      if (ev.tool_name === "AskUserQuestion" || CARD_TOOLS.some((t) => ev.tool_name === `mcp__cc_conductor__${t}`)) {
        kept.add(ev.id);
        out.push(ev);
      } else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ev.tool_name)) {
        out.push({ ...ev, input: { file_path: ev.input.file_path } });
      }
    } else if (ev.type === "tool_result" && kept.has(ev.tool_use_id)) out.push(ev);
  }
  return out;
}

/** Routes the window's history calls: the whole transcript as one page
 *  (`paged: false`), or its newest PAGE events with the digest above them. The
 *  byte offset of an event is its index here. `digest` can hold the reply back. */
function serve(events, { paged, digest = null }) {
  const start = paged ? Math.max(0, events.length - PAGE) : 0;
  const calls = { pages: [], digests: [] };
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "load_history_page") {
      calls.pages.push(args);
      // Fresh copies: the renderer tags and keeps what it is handed.
      return Promise.resolve(structuredClone({ events: events.slice(start), oldest_seq: start, newest_seq: events.length - 1, has_more: start > 0 }));
    }
    if (cmd === "load_dashboard_digest") {
      calls.digests.push(args);
      const reply = () => structuredClone({ events: digestOf(events.slice(0, args.beforeSeq ?? events.length)), continues_from: null });
      return digest ? digest.then(reply) : Promise.resolve(reply());
    }
    if (cmd === "list_channel_messages") return Promise.resolve({ messages: [] });
    // The store knows no draft: an old one was deleted from the Drafts panel.
    if (cmd === "list_message_drafts") return Promise.resolve({ drafts: [] });
    if (cmd === "get_skipped_question_marks" || cmd === "list_subchat_cards" || cmd === "list_previews" || cmd === "ask_list_threads") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  return calls;
}

let chat = 0;
async function openChat(events, opts) {
  const calls = serve(events, opts);
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  await r.attach(`forever-${++chat}`);
  await r.loadFromStore();
  return { pane, r, calls };
}

/** The zones the brief names, as the model derives them. A plan's `at` and
 *  `lastAt` count rows, and the rows rebuilt from above the page leave out the
 *  ones no zone reads (tool calls, prose), so those two counts are dropped;
 *  everything a card shows is compared. */
function durableZones(messages, plans) {
  const d = deriveDashboard({ messages, plans, now: 0 });
  const zone = (id) => [...d.left, ...d.right].find((z) => z.id === id)?.state ?? null;
  return JSON.parse(JSON.stringify({ answers: zone("answers"), waiting: zone("waiting"), plan: zone("plan") }, (k, v) => (k === "at" || k === "lastAt" ? undefined : v)));
}

const settled = (check) => vi.waitFor(check, { timeout: 10000, interval: 10 });

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  globalThis.window.__TAURI__ = {};
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  setSettings({});
});

// Loading the whole fixture as one page is the slow half (about 1.3s a chat).
describe("dashboard over a forever chat with only the newest page loaded", { timeout: 30000 }, () => {
  const events = foreverTranscript(40, 12);

  it("the fixture is what the test needs: the page starts inside the last job, after its plan began", () => {
    const start = events.length - PAGE;
    expect(events.length).toBeGreaterThan(PAGE * 5);
    const lastJob = events.findLastIndex((e) => e.type === "user_message" && e.content[0].text.startsWith("Job "));
    expect(lastJob).toBeLessThan(start);
    expect(events.slice(lastJob, start).some((e) => e.type === "tool_use" && e.tool_name === PLAN)).toBe(true);
    expect(events.slice(start).some((e) => e.type === "tool_use" && e.tool_name === PLAN)).toBe(true);
  });

  it("derives the same Answers, Plan and Waiting on you as with every event loaded", async () => {
    const full = await openChat(events, { paged: false });
    const want = durableZones(full.r.messages, full.r.dashPlans);
    // Sanity: the whole chat has old answers, every earlier job, and the one
    // question Joe never answered.
    expect(want.answers.items.length).toBe(14);
    expect(want.plan.earlier.length).toBe(39);
    expect(want.waiting.items.map((i) => i.questions)).toEqual([["Which way for part 1?"]]);

    const paged = await openChat(events, { paged: true });
    expect(paged.r.messages.length).toBeLessThan(full.r.messages.length / 4);
    // The loaded page alone loses the old answers, jobs and question.
    expect(durableZones(paged.r.messages, paged.r.dashPlans)).not.toEqual(want);
    const { HistoryPrefixSource } = await import("../src/views/sessions/chat-dashboard/history-prefix-source.ts");
    const source = new HistoryPrefixSource(paged.r, () => {});
    source.rows();
    await settled(() => expect(paged.calls.digests).toHaveLength(1));
    expect(paged.calls.digests[0].beforeSeq).toBe(events.length - PAGE);
    await settled(() => {
      const rows = source.rows();
      expect(durableZones(rows.messages, rows.plans)).toEqual(want);
    });
    source.dispose();
  });

  it("draws the same Plan card and Waiting on you card as a fully loaded chat", async () => {
    const full = await openChat(events, { paged: false });
    const fullDash = new ChatDashboard(full.pane, full.r);
    const paged = await openChat(events, { paged: true });
    const pagedDash = new ChatDashboard(paged.pane, paged.r);
    const html = (pane, sel) => pane.querySelector(sel)?.innerHTML ?? null;
    await settled(() => {
      expect(html(full.pane, ".cdash-plan")).not.toBeNull();
      expect(html(paged.pane, ".cdash-plan")).toBe(html(full.pane, ".cdash-plan"));
      expect(html(paged.pane, ".cdash-waiting")).toBe(html(full.pane, ".cdash-waiting"));
      expect(paged.pane.querySelector(".cdash-waiting")?.textContent).toContain("Which way for part 1?");
    });
    fullDash.dispose();
    pagedDash.dispose();
  });

  it("keeps a late answer to an old question: answering it live clears it from Waiting on you", async () => {
    const paged = await openChat(events, { paged: true });
    const dash = new ChatDashboard(paged.pane, paged.r);
    await settled(() => expect(paged.pane.querySelector(".cdash-waiting")?.textContent).toContain("Which way for part 1?"));
    const q1 = events.find((e) => e.type === "tool_use" && e.tool_name === ASK).id;
    const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
    sessionEvents.pushSynthetic(paged.r.sessionId, answerEvent(q1, "Q: Which way for part 1?\nA: A", 0));
    await settled(() => expect(paged.pane.querySelector(".cdash-waiting")).toBeNull());
    dash.dispose();
  });
});

describe("history above the page, edge cases", { timeout: 30000 }, () => {
  it("an old draft deleted from the store stays off the Drafts card, as with every event loaded", async () => {
    const events = foreverTranscript(30, 12, { draft: true });
    const full = await openChat(events, { paged: false });
    const fullDash = new ChatDashboard(full.pane, full.r);
    const paged = await openChat(events, { paged: true });
    const pagedDash = new ChatDashboard(paged.pane, paged.r);
    // The old question shows once the prefix is built, so the draft row is in by then.
    await settled(() => expect(paged.pane.querySelector(".cdash-waiting")?.textContent).toContain("Which way for part 1?"));
    await settled(() => expect(paged.calls.digests.length).toBeGreaterThan(0));
    await new Promise((res) => setTimeout(res, 200));
    expect(full.pane.querySelector(".cdash-drafts")).toBeNull();
    expect(paged.pane.querySelector(".cdash-drafts")).toBeNull();
    fullDash.dispose();
    pagedDash.dispose();
  });

  it("a chat whose first digest read fails gets its own retry, even after another chat spent them all", async () => {
    const events = foreverTranscript(30, 12);
    const paged = await openChat(events, { paged: true });
    const serveDigest = invokeMock.getMockImplementation();
    let failures = 1;
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd === "load_dashboard_digest" && failures-- > 0) return Promise.reject(new Error("daemon not up yet"));
      return serveDigest(cmd, args);
    });
    const { HistoryPrefixSource } = await import("../src/views/sessions/chat-dashboard/history-prefix-source.ts");
    const source = new HistoryPrefixSource(paged.r, () => source.rows());
    // The pane showed a paired machine's chat before, whose reads all failed.
    source.retries = 3;
    source.retriesFor = "a-mirrored-chat";
    source.rows();
    await settled(() => expect(source.rows().messages.length).toBeGreaterThan(paged.r.messages.length));
    source.dispose();
  });

  it("a prefix built for one chat never joins another chat's rows", async () => {
    const events = foreverTranscript(30, 12);
    const paged = await openChat(events, { paged: true });
    const { HistoryPrefixSource } = await import("../src/views/sessions/chat-dashboard/history-prefix-source.ts");
    const source = new HistoryPrefixSource(paged.r, () => {});
    source.rows();
    await settled(() => expect(source.rows().messages.length).toBeGreaterThan(paged.r.messages.length));
    // The pane's renderer moves to a chat whose history is still replaying (a
    // derive can run then: the Answers card or a preview asks for one).
    await paged.r.attach("another-chat");
    paged.r.hydrating = true;
    const rows = source.rows();
    expect(rows.messages).toBe(paged.r.messages);
    source.dispose();
  });
});

describe("opening a forever chat", () => {
  it("costs one page of events however long the transcript is, and never waits for the digest", async () => {
    const opened = [];
    for (const jobs of [20, 200]) {
      let release;
      const digest = new Promise((res) => { release = res; });
      const events = foreverTranscript(jobs, 12);
      const { pane, r, calls } = await openChat(events, { paged: true, digest });
      const dash = new ChatDashboard(pane, r);
      // The page drew and the dashboard drew from it while the digest is still out.
      await settled(() => expect(pane.querySelector(".cdash-plan")?.textContent).toContain(`Fix part ${jobs - 1}`));
      expect(calls.pages).toHaveLength(1);
      opened.push({ events: events.length, rows: r.messages.length });
      release();
      await settled(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("Which way for part 1?"));
      dash.dispose();
    }
    // Many times the transcript, the same rows built on open.
    expect(opened[1].events).toBeGreaterThan(opened[0].events * 5);
    expect(opened[1].rows).toBe(opened[0].rows);
  });
});
