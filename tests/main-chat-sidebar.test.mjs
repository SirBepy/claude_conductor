// @vitest-environment jsdom
// jsdom: sessions-helpers reads settings off `window`; the gate imports the IPC layer.

import { describe, it, expect, beforeEach } from "vitest";
import { sessionSegment } from "../src/views/sessions/sessions-helpers.ts";
import { mainChatRingSpec } from "../src/views/sessions/sidebar-ring.ts";
import { askingDotsHtml, subCountHtml } from "../src/views/sessions/sidebar-row-visuals.ts";
import { buildHoverCardHtml } from "../src/views/sessions/sidebar-hover-card-html.ts";
import { mainChatInfo, showsSubs } from "../src/views/sessions/main-chat.ts";
import { storePendingPrompt, clearPendingPrompt, markPendingPromptAnswered } from "../src/views/sessions/permission-modal/gating.ts";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const sub = (id, over = {}) => inst({ session_id: id, name: id, subchat_of: "main", busy: true, ...over });
const none = new Set();

describe("sessionSegment, Main chats", () => {
  it("puts a mode-on chat in segment 8 whatever its state, so it never moves when a sub asks", () => {
    const main = inst({ session_id: "main" });
    const on = new Set(["main"]);
    expect(sessionSegment(main, none, none, none, none, none, none, on)).toBe(8);
    // The same chat asking, busy, or with a pending question stays put.
    expect(sessionSegment(inst({ session_id: "main", busy: true }), none, new Set(["main"]), new Set(["main"]), none, none, none, on)).toBe(8);
  });

  it("leaves a mode-off chat alone", () => {
    expect(sessionSegment(inst({ session_id: "plain", busy: true }), none, none, none, none, none, none, new Set(["main"]))).toBe(2);
  });

  it("still lets closing take a main chat out of the group", () => {
    expect(sessionSegment(inst({ session_id: "main" }), none, none, none, new Set(["main"]), none, none, new Set(["main"]))).toBe(3);
  });
});

describe("mainChatRingSpec", () => {
  const PLAN = [{ text: "a", status: "done" }, { text: "b", status: "active" }];
  const facts = (over = {}) => ({ working: false, asking: false, allFinished: false, hasSubs: true, ...over });
  const DONE_ALL = facts({ allFinished: true });
  it("is a plain working ring with no arc while the main agent works", () => {
    expect(mainChatRingSpec("st-working", null, facts())).toEqual({ kind: "solid", tone: "working", glow: true });
  });
  // Joe, 2026-11-12: "sometimes it goes green and never stops being green". The ring used to
  // stay green for as long as every sub was finished, which is forever once they are; reading
  // the chat (`st-your-turn`) must clear it, the way it does on any chat.
  it("goes green only while the finish is unread, and clears once Joe has read the chat", () => {
    expect(mainChatRingSpec("st-done", null, DONE_ALL)).toEqual({ kind: "solid", tone: "done" });
    expect(mainChatRingSpec("st-your-turn", null, DONE_ALL)).toEqual({ kind: "none" });
  });
  // Joe, 2026-11-12: "they should only glow green IF ALLLL of the subchats are done... only then".
  it("is green only when every sub finished: one unfinished sub of several blocks it", () => {
    expect(mainChatRingSpec("st-done", null, DONE_ALL)).toEqual({ kind: "solid", tone: "done" });
    // Finished ones plus a queued, paused, usage-limited or stopped one: not all finished, none running.
    expect(mainChatRingSpec("st-done", null, facts({ allFinished: false }))).toEqual({ kind: "none" });
  });
  it("a chat with no subs yet keeps the ordinary green for its own unread finish", () => {
    expect(mainChatRingSpec("st-done", null, facts({ hasSubs: false }))).toEqual({ kind: "solid", tone: "done" });
  });
  it("glows while any sub works, whether the chat itself is idle or unread-done", () => {
    expect(mainChatRingSpec("st-your-turn", null, facts({ working: true }))).toEqual({ kind: "solid", tone: "working", glow: true });
    expect(mainChatRingSpec("st-done", null, facts({ working: true }))).toEqual({ kind: "solid", tone: "working", glow: true });
  });
  it("shows the attention pulse while a sub asks, never green", () => {
    expect(mainChatRingSpec("st-done", null, facts({ asking: true }))).toEqual({ kind: "solid", tone: "attention", pulse: true });
    expect(mainChatRingSpec("st-your-turn", null, facts({ asking: true }))).toEqual({ kind: "solid", tone: "attention", pulse: true });
  });
  it("a sub that asks outranks one that works", () => {
    const both = facts({ asking: true, working: true });
    expect(mainChatRingSpec("st-your-turn", null, both)).toEqual({ kind: "solid", tone: "attention", pulse: true });
    expect(mainChatRingSpec("st-done", null, both)).toEqual({ kind: "solid", tone: "attention", pulse: true });
  });
  it("a closing sub keeps the ring off green until it is gone", () => {
    const closing = sub("a", { subchat_finished: true, busy: false, closing: true });
    const info = mainChatInfo(inst({ session_id: "main" }), [inst({ session_id: "main" }), closing]);
    const f = { working: info.anyWorking, asking: info.subs.some((s) => s.kind === "asking"), allFinished: info.allFinished, hasSubs: info.subs.length > 0 };
    expect(mainChatRingSpec("st-done", null, f)).toEqual({ kind: "none" });
  });
  it("lets the main agent's own work outrank green, and keeps question and attention rings", () => {
    expect(mainChatRingSpec("st-working", null, facts({ working: true, allFinished: true })).tone).toBe("working");
    expect(mainChatRingSpec("st-attention", { total: 3, answered: 1 }, facts({ working: true }))).toMatchObject({ kind: "segments", tone: "attention" });
    expect(mainChatRingSpec("st-attention", null, facts())).toEqual({ kind: "solid", tone: "attention", pulse: true });
  });
  it("never draws a plan arc", () => {
    expect(PLAN.length).toBe(2);
    expect(mainChatRingSpec("st-working", null, facts()).kind).toBe("solid");
  });
});

describe("row pieces", () => {
  it("draws one red dot per asker and nothing for zero", () => {
    expect(askingDotsHtml(0)).toBe("");
    expect(askingDotsHtml(3).match(/class="ask-dot"/g)).toHaveLength(3);
  });
  it("is a bare count with no word", () => {
    expect(subCountHtml(3)).toBe(`<span class="session-sub-count">3x</span>`);
  });
});

describe("buildHoverCardHtml with subs", () => {
  const subs = [
    { name: "Footer", kind: "asking", progress: "2 of 5 answered" },
    { name: "Skills", kind: "working", progress: "step 3 of 6" },
    { name: "Header", kind: "finished", progress: "finished" },
  ];
  const base = { title: "CV redesign", project: "cv", st: "st-working", plan: null, question: null, stateSince: null, contextPct: null, now: 0 };
  it("lists each sub with its progress, red then yellow then green", () => {
    const html = buildHoverCardHtml({ ...base, subs });
    expect(html.match(/class="hc-subrow/g)).toHaveLength(3);
    expect(html).toContain("2 of 5 answered");
    expect(html).toContain("step 3 of 6");
    expect(html.indexOf("var(--st-question)")).toBeLessThan(html.indexOf("var(--st-working)"));
    expect(html.indexOf("var(--st-working)")).toBeLessThan(html.indexOf("var(--st-done)"));
    expect(html).not.toContain("hc-state");
  });
  it("is the plain card with no subs", () => {
    const html = buildHoverCardHtml({ ...base, subs: [] });
    expect(html).toContain("hc-state");
    expect(html).not.toContain("hc-subrow");
  });
  it("escapes a sub's name", () => {
    expect(buildHoverCardHtml({ ...base, subs: [{ name: "<b>x</b>", kind: "working", progress: "working" }] })).not.toContain("<b>x</b>");
  });
});

describe("showsSubs", () => {
  it("is true for a mode-on chat, and for a mode-off chat that still has subs", () => {
    const main = inst({ session_id: "main" });
    // The mode flag lives in the gate; a chat with no flag and no subs shows nothing.
    expect(showsSubs("main", [main])).toBe(false);
    expect(showsSubs("main", [main, sub("a")])).toBe(true);
    expect(showsSubs("main", [main, sub("a", { subchat_of: "other" })])).toBe(false);
  });
});

describe("mainChatInfo", () => {
  const main = inst({ session_id: "main" });
  beforeEach(() => { clearPendingPrompt("main"); clearPendingPrompt("a"); clearPendingPrompt("b"); });
  const park = (askerId, display, over = {}) => storePendingPrompt(askerId, {
    kind: "question",
    payload: { id: `p-${askerId}`, session_id: askerId, display_session_id: display, questions: [{ question: "Q?", header: "Q", options: [] }, { question: "R?", header: "R", options: [] }], ...over },
  });

  it("counts a dot per asking sub and one for the chat's own question", () => {
    const sessions = [main, sub("a"), sub("b"), sub("c", { busy: false, subchat_finished: true })];
    expect(mainChatInfo(main, sessions).askingDots).toBe(0);
    park("a", "main");
    expect(mainChatInfo(main, sessions).askingDots).toBe(1);
    park("main", "main");
    park("b", "main");
    const info = mainChatInfo(main, sessions);
    expect(info.askingDots).toBe(3);
    expect(info.hoverRows.map((r) => r.name)).toEqual(["This chat", "a", "b"]);
    expect(info.subs.map((s) => s.kind)).toEqual(["asking", "asking", "finished"]);
  });

  it("keeps a closing sub in the hover list while a finished one drops out", () => {
    const sessions = [main, sub("a", { busy: false, subchat_finished: true }), sub("b", { closing: true })];
    expect(mainChatInfo(main, sessions).hoverRows.map((r) => r.name)).toEqual(["b"]);
  });

  it("does not count a question already answered, a working sub or a finished one", () => {
    const sessions = [main, sub("a"), sub("b", { busy: false, subchat_finished: true })];
    park("a", "main");
    markPendingPromptAnswered("a", "p-a");
    expect(mainChatInfo(main, sessions).askingDots).toBe(0);
  });

  it("reads progress per sub: questions answered, plan step, finished", () => {
    const plan = [{ text: "1", status: "done" }, { text: "2", status: "done" }, { text: "3", status: "active" }, { text: "4", status: "pending" }];
    const sessions = [main, sub("a"), sub("b", { progress: { plan, state_since: null } }), sub("c", { busy: false, subchat_finished: true })];
    park("a", "main");
    const info = mainChatInfo(main, sessions);
    expect(info.subs.map((s) => s.progress)).toEqual(["0 of 2 answered", "step 3 of 4", "finished"]);
  });

  it("is all finished only when there is at least one sub and every one finished", () => {
    expect(mainChatInfo(main, [main]).allFinished).toBe(false);
    expect(mainChatInfo(main, [main, sub("a", { subchat_finished: true, busy: false })]).allFinished).toBe(true);
    expect(mainChatInfo(main, [main, sub("a", { subchat_finished: true, busy: false }), sub("b")]).allFinished).toBe(false);
  });

  it("does not call a frozen or rate-limited sub working", () => {
    const later = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const earlier = BigInt(Math.floor(Date.now() / 1000) - 3600);
    const sessions = [
      main,
      sub("frozen", { frozen: true }),
      sub("limited", { rate_limited_resets_at: later }),
      sub("old-limit", { rate_limited_resets_at: earlier }),
    ];
    const byId = Object.fromEntries(mainChatInfo(main, sessions).subs.map((s) => [s.id, s.progress]));
    expect(byId).toMatchObject({ frozen: "paused", "old-limit": "working" });
    expect(byId.limited).toMatch(/^usage limit, resets \d/);
  });

  it("ignores another chat's subs", () => {
    expect(mainChatInfo(main, [main, sub("x", { subchat_of: "other" })]).subs).toHaveLength(0);
  });

  // A sub the daemon holds behind another (`after`) has a row and no process.
  const queued = (id, waitingFor = `waiting for header`, over = {}) =>
    sub(id, { busy: false, progress: { plan: null, state_since: null, waiting_for: waitingFor }, ...over });

  it("shows a held sub as queued with what it waits for, below the working ones and above the finished", () => {
    const sessions = [main, sub("done", { busy: false, subchat_finished: true }), queued("footer"), sub("header")];
    const info = mainChatInfo(main, sessions);
    expect(info.subs.map((s) => [s.name, s.kind])).toEqual([["header", "working"], ["footer", "queued"], ["done", "finished"]]);
    expect(info.subs.find((s) => s.name === "footer").progress).toBe("waiting for header");
  });

  it("does not count a queued sub as asking, and it keeps the whole chat from reading as all finished", () => {
    const sessions = [main, sub("a", { busy: false, subchat_finished: true }), queued("b")];
    const info = mainChatInfo(main, sessions);
    expect(info.askingDots).toBe(0);
    expect(info.allFinished).toBe(false);
    expect(mainChatInfo(main, [main, sub("a", { busy: false, subchat_finished: true })]).allFinished).toBe(true);
  });

  it("stays off green while a finished sub is still closing, and goes green when it is gone", () => {
    const closing = sub("a", { busy: false, subchat_finished: true, closing: true });
    const info = mainChatInfo(main, [main, closing, sub("b", { busy: false, subchat_finished: true })]);
    expect(info.subs.find((s) => s.name === "a")).toMatchObject({ kind: "finished", closing: true });
    expect(info.allFinished).toBe(false);
    expect(mainChatInfo(main, [main, sub("a", { busy: false, subchat_finished: true }), sub("b", { busy: false, subchat_finished: true })]).allFinished).toBe(true);
  });

  it("names each sub's tier, quietly, from its current model and effort", () => {
    const info = mainChatInfo(main, [
      main,
      sub("a", { model: "claude-sonnet-4-5", effort: "high" }),
      sub("b", { model: "opus", effort: "high" }),
      sub("c", { model: "", effort: "" }),
    ]);
    expect(Object.fromEntries(info.subs.map((s) => [s.name, s.tier]))).toEqual({ a: "Sonnet high", b: "Opus high", c: "" });
    const html = buildHoverCardHtml({ title: "CV", project: "cv", st: "st-working", plan: null, question: null, stateSince: null, contextPct: null, now: 0, subs: info.hoverRows });
    expect(html).toContain('<span class="hc-tier">Sonnet high</span>');
    expect(html.match(/hc-tier/g)).toHaveLength(2);
  });

  it("stops reading as queued once the daemon clears the mark, or when it finishes", () => {
    expect(mainChatInfo(main, [main, queued("a", undefined, { busy: true, progress: { plan: null, state_since: null } })]).subs[0].kind).toBe("working");
    expect(mainChatInfo(main, [main, queued("a", "waiting for header", { subchat_finished: true })]).subs[0].kind).toBe("finished");
  });

  // Queued, paused, usage limit and stopped read dim, not working yellow: the yellow means a running turn.
  it("puts a queued sub on the hover card in the dim tone with its waiting text", () => {
    const info = mainChatInfo(main, [main, queued("footer")]);
    const html = buildHoverCardHtml({ title: "CV", project: "cv", st: "st-working", plan: null, question: null, stateSince: null, contextPct: null, now: 0, subs: info.hoverRows });
    expect(html).toContain("is-queued");
    expect(html).toContain("waiting for header");
    expect(html).toContain("var(--color-text-muted)");
    expect(html).not.toContain("var(--st-working)");
  });
});
