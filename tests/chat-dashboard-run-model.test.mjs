// The Run card's pure side (pc-1804 step 5): the daemon's `run_plan_state` shape read
// leniently, how a plan is split into chains and end steps, what the chip and the wake line
// say, and when the zone draws.

import { describe, it, expect } from "vitest";

const { normaliseRun, layOut, phaseOf, wakeText, deriveRun } = await import("../src/shared/chat/dashboard/run-model.ts");
const { deriveDashboard, ZONES, SECTION_DEFAULTS } = await import("../src/shared/chat/dashboard/dashboard-model.ts");

const step = (id, over = {}) => ({ id, title: `Step ${id}`, owner: "sub", status: "waiting", after: [], todo_ids: [], sub: `lane-${id}`, sub_id: `sid-${id}`, ...over });
const raw = (steps, over = {}) => ({ session_id: "main", run: { id: "run-1", title: "Finish todos", goal: "ship it", status: "open", steps, ...over } });

/** Three chains of two lanes, a review gate after all three, then the chat's own release. */
const THREE_CHAINS = [
  step("s1"), step("s2", { after: ["s1"] }),
  step("s3"), step("s4", { after: ["s3"] }),
  step("s5"), step("s6", { after: ["s5"] }),
  step("s7", { after: ["s2", "s4", "s6"], title: "Review gate" }),
  step("s8", { owner: "main", after: ["s7"], title: "Release", sub: undefined, sub_id: undefined }),
];

describe("normaliseRun", () => {
  it("reads the daemon's shape, including each lane's sub id", () => {
    const side = normaliseRun(raw([step("s1", { todo_ids: ["pc-1"], status: "running" })]));
    expect(side.id).toBe("run-1");
    expect(side.steps[0]).toMatchObject({ id: "s1", owner: "sub", status: "running", subId: "sid-s1", sub: "lane-s1", todoIds: ["pc-1"] });
  });

  it("a chat with no run, or a body that is not a run, reads as none", () => {
    expect(normaliseRun({ session_id: "m", run: null })).toBeUndefined();
    expect(normaliseRun(undefined)).toBeUndefined();
    expect(normaliseRun({ run: { id: 3, steps: [] } })).toBeUndefined();
    expect(normaliseRun({ run: { id: "run-1" } })).toBeUndefined();
  });

  it("a status this build does not know reads as waiting, never as done", () => {
    const side = normaliseRun(raw([step("s1", { status: "from-the-future" }), { id: "" }, null, step("s2", { owner: "weird" })]));
    expect(side.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(side.steps[0].status).toBe("waiting");
    expect(side.steps[1].owner).toBe("sub");
    expect(normaliseRun(raw([step("s1")], { status: "odd" })).status).toBe("open");
  });
});

describe("layOut", () => {
  it("puts each chain in its own row and everything from the join on in the end steps", () => {
    const { chains, end } = layOut(normaliseRun(raw(THREE_CHAINS)).steps);
    expect(chains.map((c) => c.lanes.map((s) => s.id))).toEqual([["s1", "s2"], ["s3", "s4"], ["s5", "s6"]]);
    expect(chains.map((c) => c.key)).toEqual(["s1", "s3", "s5"]);
    expect(end.map((s) => s.id)).toEqual(["s7", "s8"]);
  });

  it("a main step is an end step even behind a single lane, and a lone lane is a one-lane row", () => {
    const { chains, end } = layOut(normaliseRun(raw([step("s1"), step("s2", { owner: "main", after: ["s1"] })])).steps);
    expect(chains.map((c) => c.lanes.map((s) => s.id))).toEqual([["s1"]]);
    expect(end.map((s) => s.id)).toEqual(["s2"]);
  });

  it("a lane that forks keeps both branches in the one row", () => {
    const { chains } = layOut(normaliseRun(raw([step("a"), step("b", { after: ["a"] }), step("c", { after: ["a"] })])).steps);
    expect(chains.map((c) => c.lanes.map((s) => s.id))).toEqual([["a", "b", "c"]]);
  });

  it("a cycle the daemon would have refused still lays out", () => {
    const { chains, end } = layOut(normaliseRun(raw([step("a", { after: ["b"] }), step("b", { after: ["a"] })])).steps);
    expect(chains.length + end.length).toBeGreaterThan(0);
  });
});

describe("phase and the wake line", () => {
  const side = (steps, over) => normaliseRun(raw(steps, over));

  it("a blocked lane outranks the chat's own turn, and a finished run says so", () => {
    expect(phaseOf(side([step("s1", { status: "blocked" }), step("s2", { owner: "main", status: "ready" })]))).toBe("blocked");
    expect(phaseOf(side([step("s1", { status: "done" }), step("s2", { owner: "main", status: "ready" })]))).toBe("yours");
    expect(phaseOf(side([step("s1", { status: "running" })]))).toBe("running");
    expect(phaseOf(side([step("s1", { status: "waiting" })]))).toBe("queued");
    expect(phaseOf(side([step("s1", { status: "done" })], { status: "done" }))).toBe("done");
  });

  it("names what wakes the chat: its own step, a blocked lane, the end", () => {
    const open = side([step("s1", { status: "running" }), step("s2", { owner: "main", after: ["s1"] })]);
    expect(wakeText(open, "running")).toBe("Wakes this chat when a step of yours is ready, a lane is blocked or the run ends.");
    const lanes = side([step("s1", { status: "running" })]);
    expect(wakeText(lanes, "running")).toBe("Wakes this chat when a lane is blocked or the run ends.");
  });

  it("says whose turn it is, which lane is blocked, and that a finished run wakes nobody", () => {
    expect(wakeText(side([step("s1", { status: "done" }), step("s2", { owner: "main", status: "ready", title: "Triage" })]), "yours")).toBe("Your turn: Triage.");
    expect(wakeText(side([step("s1", { status: "blocked", title: "Fix footer" })]), "blocked")).toContain("Blocked: Fix footer.");
    expect(wakeText(side([step("s1", { status: "done" })], { status: "done" }), "done")).toBe("Finished. Nothing more wakes this chat.");
    // Both at once: the chip says Blocked, so the line names the lane first and still says whose turn it is.
    const both = side([step("s1", { status: "blocked", title: "Fix footer" }), step("s2", { status: "done" }), step("s3", { owner: "main", status: "ready", title: "Triage" })]);
    expect(wakeText(both, phaseOf(both))).toBe("Blocked: Fix footer. Your turn: Triage.");
  });
});

describe("deriveRun and the zone", () => {
  it("draws nothing without a run, with the card off, or for a run the chat gave up", () => {
    expect(deriveRun(undefined, true)).toBeNull();
    expect(deriveRun(normaliseRun(raw([step("s1")])), false)).toBeNull();
    expect(deriveRun(normaliseRun(raw([step("s1")], { status: "stopped" })), true)).toBeNull();
    expect(deriveRun(normaliseRun(raw([step("s1")], { steps: [] })), true)).toBeNull();
  });

  it("counts the settled steps against all of them", () => {
    const state = deriveRun(normaliseRun(raw([step("s1", { status: "done" }), step("s2", { status: "skipped" }), step("s3", { status: "running" })])), true);
    expect(state).toMatchObject({ done: 2, total: 3, phase: "running", title: "Finish todos" });
  });

  it("is one right-column zone under Plan, off by default, and switched on by Settings", () => {
    expect(ZONES.run.column).toBe("right");
    expect(ZONES.run.order).toBeGreaterThan(ZONES.plan.order);
    expect(ZONES.run.order).toBeLessThan(ZONES.tests.order);
    expect(SECTION_DEFAULTS.run).toBe(false);
    const run = normaliseRun(raw(THREE_CHAINS));
    const input = { messages: [], plans: [], run, now: 1 };
    expect(deriveDashboard(input).right.map((z) => z.id)).not.toContain("run");
    expect(deriveDashboard({ ...input, sections: { run: true } }).right.map((z) => z.id)).toContain("run");
    expect(deriveDashboard({ messages: [], plans: [] }).right.map((z) => z.id)).not.toContain("run");
  });
});
