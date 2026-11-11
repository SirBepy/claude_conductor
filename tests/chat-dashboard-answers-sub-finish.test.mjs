// asserts: src/shared/chat/dashboard/answers-model.ts

// A sub's finish card that carries Joe's question is the answer itself
// (answers-model.ts isSubAnswer): the main chat relays nothing. Before this, a
// follow-up question passed to a sub with `subchat send` was answered only by
// the sub's finish card, which the Answers card never read, so Joe saw no answer.

import { describe, it, expect } from "vitest";

const { buildAnswerItems } = await import("../src/shared/chat/dashboard/answers-model.ts");

const SPAWN = "mcp__cc_conductor__spawn_chat";
const SEND = "mcp__cc_conductor__send_message";

const joe = (text, ts) => ({ kind: "user", content: [{ type: "text", text }], ts, parentToolUseId: null });
const use = (tool, input, id, ts) => ({ kind: "tool_use", tool, input, id, ts, parentToolUseId: null });
const result = (id, body) => ({ kind: "tool_result", tool_use_id: id, output: { type: "text", text: JSON.stringify(body) }, is_error: false, parentToolUseId: null });
const finish = (round, ts, over = {}) => ({
  kind: "message", text: over.text ?? "t", ts, parentToolUseId: null, card: { kind: "report", verdict: over.verdict ?? "v" },
  subCard: {
    id: `finish-sub-1-${round}`, ts, parent_id: "main", kind: "finish", sub_id: "sub-1", sub_name: "phone-ime", round,
    model: "opus", effort: "high", verdict: over.verdict ?? "v", text: over.text ?? "t", points: over.points ?? [], ...over,
  },
});
/** The "Passed to X" row a `subchat send` draws, with the daemon's reply folded in (chat-subchat-passed.ts). */
const passed = (id, ts, question, subIds) => ({ kind: "passed", id, ts, parentToolUseId: null, passedTo: "phone-ime", passedQuestion: question, passedSubIds: subIds });
const relayed = (verdict, id, ts) => ({ kind: "message", id, text: "relayed", ts, parentToolUseId: null, card: { kind: "answer", verdict } });

describe("a sub's finish as the answer", () => {
  it("answers a spawned question from the finish card, with the sub as its author, and fills the pending row", () => {
    const base = [
      joe("why does gboard swipe break?", 1000),
      use(SPAWN, { name: "phone-ime", task: "Why does Gboard swipe fail?", question: "Why does Gboard swipe fail in the composer?", writes: false }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
    ];
    const waiting = buildAnswerItems(base);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].pending?.state).toBe("checking");
    expect(waiting[0].question).toBe("Why does Gboard swipe fail in the composer?");

    const items = buildAnswerItems([...base, finish(1, 2000, { verdict: "The composer grabs focus", text: "Focus on open.", question: "Why does Gboard swipe fail in the composer?" })]);
    expect(items).toHaveLength(1);
    const a = items[0];
    expect(a.key).toBe("finish-sub-1-1");
    expect(a.pending).toBeNull();
    expect(a.handoff).toBe("handoff:s1");
    expect([a.verdict, a.text, a.question]).toEqual(["The composer grabs focus", "Focus on open.", "Why does Gboard swipe fail in the composer?"]);
    expect(a.raw).toBe("why does gboard swipe break?");
    expect(a.author).toEqual({ name: "phone-ime", model: "opus", effort: "high", subId: "sub-1" });
    expect(a.message.card.kind).toBe("answer");
  });

  it("answers a follow-up question passed with subchat send from that sub's next finish", () => {
    const items = buildAnswerItems([
      joe("why does gboard swipe break?", 1000),
      use(SPAWN, { name: "phone-ime", task: "Why?", question: "Why does Gboard swipe fail?", writes: false }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
      finish(1, 2000, { verdict: "Focus on open", question: "Why does Gboard swipe fail?" }),
      joe("is the design too far behind?", 3000),
      passed("f1", 3001, "Is the design too far behind to build now?", ["sub-1"]),
    ]);
    expect(items.map((i) => [i.key, i.pending?.state ?? null])).toEqual([["finish-sub-1-1", null], ["handoff:f1", "checking"]]);

    const done = buildAnswerItems([
      joe("why does gboard swipe break?", 1000),
      use(SPAWN, { name: "phone-ime", task: "Why?", question: "Why does Gboard swipe fail?", writes: false }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
      finish(1, 2000, { verdict: "Focus on open", question: "Why does Gboard swipe fail?" }),
      joe("is the design too far behind?", 3000),
      passed("f1", 3001, "Is the design too far behind to build now?", ["sub-1"]),
      finish(2, 4000, { verdict: "Design is ready", question: "Is the design too far behind to build now?" }),
    ]);
    expect(done.map((i) => [i.key, i.verdict, i.handoff])).toEqual([
      ["finish-sub-1-1", "Focus on open", "handoff:s1"],
      ["finish-sub-1-2", "Design is ready", "handoff:f1"],
    ]);
    expect(done[1].raw).toBe("is the design too far behind?");
  });

  it("never counts a job's finish (no question) as an answer", () => {
    const items = buildAnswerItems([
      joe("fix the footer", 1000),
      use(SPAWN, { name: "footer", task: "Fix the footer", writes: true, files: ["src/"] }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
      finish(1, 2000, { verdict: "Built, not pushed" }),
    ]);
    expect(items).toEqual([]);
  });

  it("drops a main chat's relay of the answer its sub's card already gives", () => {
    const items = buildAnswerItems([
      joe("why?", 1000),
      use(SPAWN, { name: "phone-ime", task: "Why?", question: "Why does it fail?", writes: false }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
      finish(1, 2000, { verdict: "Focus on open", question: "Why does it fail?" }),
      use(SEND, { kind: "answer", verdict: "Focus on open" }, "m1", 2001),
      relayed("Focus on open", "m1", 2001),
    ]);
    expect(items.map((i) => i.key)).toEqual(["finish-sub-1-1"]);
  });

  it("still fills an old-style hand-off (report_back, no question field) from the main chat's own answer", () => {
    const items = buildAnswerItems([
      joe("is master ready?", 1000),
      use(SPAWN, { name: "rel", task: "Is master ready for /release?", writes: false, report_back: true }, "s1", 1001),
      result("s1", { ok: true, session_id: "sub-1" }),
      finish(1, 2000, { verdict: "Ready" }),
      relayed("Ready", "m1", 2001),
    ]);
    expect(items.map((i) => [i.key, i.handoff, i.author])).toEqual([["m1", "handoff:s1", null]]);
  });
});
