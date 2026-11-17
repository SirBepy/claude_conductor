// asserts: src/shared/chat/dashboard/answers-model.ts

// Leftovers of the Answers model: a hand-off the sub reported stuck stops reading
// as blocked once the main chat has passed it something, a sub's answer hides only
// the one relayed copy of itself, and a short multi-line message is never provisional.

import { describe, it, expect } from "vitest";

const { buildAnswerItems } = await import("../src/shared/chat/dashboard/answers-model.ts");

const SPAWN = "mcp__cc_conductor__spawn_chat";

const joe = (text, ts) => ({ kind: "user", content: [{ type: "text", text }], ts, parentToolUseId: null });
const use = (tool, input, id, ts) => ({ kind: "tool_use", tool, input, id, ts, parentToolUseId: null });
const result = (id, body) => ({ kind: "tool_result", tool_use_id: id, output: { type: "text", text: JSON.stringify(body) }, is_error: false, parentToolUseId: null });
const subCard = (over) => ({
  kind: "message", text: over.text ?? "t", ts: over.ts, parentToolUseId: null, card: { kind: "report", verdict: over.verdict ?? "v" },
  subCard: { id: over.id, ts: over.ts, parent_id: "main", kind: "finish", sub_id: "sub-1", sub_name: "phone-ime", round: 1, model: "opus", effort: "high", verdict: "v", text: "t", points: [], ...over },
});
const passed = (id, ts, subIds, over = {}) => ({ kind: "passed", id, ts, parentToolUseId: null, passedTo: "phone-ime", passedSubIds: subIds, ...over });
const relayed = (verdict, id, ts, text = "relayed") => ({ kind: "message", id, text, ts, parentToolUseId: null, card: { kind: "answer", verdict } });
const sub = (kind) => ({ id: "sub-1", name: "phone-ime", kind, closing: false, model: "opus", effort: "high", progress: "", startedAt: null, finishedAt: null, ring: null });

const handoff = [
  joe("why does gboard swipe break?", 1000),
  use(SPAWN, { name: "phone-ime", task: "Why?", question: "Why does Gboard swipe fail?", writes: false }, "s1", 1001),
  result("s1", { ok: true, session_id: "sub-1" }),
];

describe("a hand-off the sub reported stuck", () => {
  it("reads as blocked until the main chat passes the sub something, then as checking again", () => {
    const stuck = [...handoff, subCard({ id: "blocker-sub-1-1", ts: 2000, kind: "blocker", verdict: "Needs the token" })];
    expect(buildAnswerItems(stuck, undefined, [sub("working")])[0].pending.state).toBe("blocked");

    const unblocked = [...stuck, passed("p1", 3000, ["sub-1"])];
    expect(buildAnswerItems(unblocked, undefined, [sub("working")])[0].pending.state).toBe("checking");
  });

  it("stays blocked when the pass was refused or went to another sub", () => {
    const stuck = [...handoff, subCard({ id: "blocker-sub-1-1", ts: 2000, kind: "blocker", verdict: "Needs the token" })];
    expect(buildAnswerItems([...stuck, passed("p1", 3000, ["sub-1"], { failed: true })], undefined, [sub("working")])[0].pending.state).toBe("blocked");
    expect(buildAnswerItems([...stuck, passed("p2", 3000, ["sub-9"])], undefined, [sub("working")])[0].pending.state).toBe("blocked");
  });

  it("is blocked again when the sub reports a second blocker after the pass", () => {
    const items = buildAnswerItems([
      ...handoff,
      subCard({ id: "blocker-sub-1-1", ts: 2000, kind: "blocker", verdict: "Needs the token" }),
      passed("p1", 3000, ["sub-1"]),
      subCard({ id: "blocker-sub-1-2", ts: 4000, kind: "blocker", verdict: "Needs the board id" }),
    ], undefined, [sub("working")]);
    expect(items[0].pending.state).toBe("blocked");
    expect(items[0].pending.line).toContain("Needs the board id");
  });

  it("does not read as blocked from a blocker card the daemon retracted", () => {
    const retracted = { ...subCard({ id: "blocker-sub-1-1", ts: 2000, kind: "blocker", verdict: "Not merged" }), retracted: true };
    const items = buildAnswerItems([...handoff, retracted], undefined, [sub("working")]);
    expect(items[0].pending.state).toBe("checking");
  });
});

describe("a sub's answer and the main chat's relay of it", () => {
  const answer = (verdict, id, ts) => subCard({ id, ts, kind: "answer", verdict });

  it("hides one relayed copy of the same verdict, not every later answer with that verdict", () => {
    const items = buildAnswerItems([
      joe("why does gboard swipe break?", 1000),
      answer("Yes", "ans-sub-1", 2000),
      relayed("Yes", "r1", 2001),
      relayed("Yes", "r2", 2002),
    ]);
    expect(items.map((i) => i.key)).toEqual(["ans-sub-1", "r2"]);
  });

  it("still hides the single relay of a sub's answer", () => {
    const items = buildAnswerItems([joe("q?", 1000), answer("Yes", "ans-sub-1", 2000), relayed("Yes", "r1", 2001)]);
    expect(items.map((i) => i.key)).toEqual(["ans-sub-1"]);
  });
});

describe("provisional questions", () => {
  it("a short message that spans several lines is its own question, not a clipped preview", () => {
    const [item] = buildAnswerItems([joe("does it\nread the tracker?\n\n  and the board?", 1000), relayed("Yes", "a1", 1001)]);
    expect(item.provisional).toBe(false);
    expect(item.question).toBe("does it read the tracker? and the board?");
    expect(item.raw).toBeNull();
  });
});
