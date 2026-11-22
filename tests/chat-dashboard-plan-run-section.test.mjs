// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/run-card.ts

// The run section inside the Plan card (Joe, 2026-11-22: one Plan card, no separate Run card):
// the card draws a fixed `.rn-host` for the run only while the chat has one, the run's own
// data never changes the card's HTML (so a lane ticking over rebuilds nothing), and the zone
// table has no Run renderer.

import { describe, it, expect } from "vitest";

const { renderPlan, initialPlanUi } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");
const { ZONE_VIEWS } = await import("../src/views/sessions/chat-dashboard/dashboard-zones.ts");
const { deriveDashboard } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { normaliseRun } = await import("../src/shared/chat/dashboard/run-model.ts");
const { RunCard } = await import("../src/views/sessions/chat-dashboard/run-card.ts");

const step = (id, over = {}) => ({ id, title: `Step ${id}`, owner: "sub", status: "waiting", after: [], todo_ids: [], sub: `lane-${id}`, sub_id: `sid-${id}`, ...over });
const raw = (steps, over = {}) => ({ session_id: "main", run: { id: "run-1", title: "Finish todos", goal: "", status: "open", steps, ...over } });
const planOf = (run) => deriveDashboard({ messages: [], plans: [], run, now: 1 }).right.find((z) => z.id === "plan").state;
const ctx = (ui = initialPlanUi()) => ({ ui, busy: false, idleAt: null, card: () => "" });
const draw = (s) => renderPlan(s, ctx());
const dom = (html) => { const el = document.createElement("div"); el.innerHTML = html; return el; };

describe("Plan card run section", () => {
  it("has no Run renderer", () => {
    expect(Object.keys(ZONE_VIEWS)).not.toContain("run");
  });

  it("draws one host for the run inside the Plan card, and none without a run", () => {
    const withRun = dom(draw(planOf(normaliseRun(raw([step("s1")])))));
    expect(withRun.querySelectorAll(".cdash-plan .rn-host")).toHaveLength(1);
    expect(withRun.querySelectorAll(".cdash-card")).toHaveLength(1);
    expect(withRun.querySelectorAll(".cdash-h")).toHaveLength(1);
    expect(dom(draw(planOf(undefined))).querySelector(".rn-host")).toBeNull();
  });

  it("keeps the plan's own body above the run section and the foot below it", () => {
    const root = dom(draw(planOf(normaliseRun(raw([step("s1")])))));
    const kids = [...root.querySelector(".cdash-plan").children].map((c) => c.className.split(" ")[0]);
    expect(kids.indexOf("cdash-pbody")).toBeLessThan(kids.indexOf("rn-host"));
    expect(kids.indexOf("rn-host")).toBeLessThan(kids.indexOf("cdash-status"));
  });

  it("looks exactly as before with no run", () => {
    expect(draw(planOf(undefined))).not.toContain("rn-");
  });

  it("a lane ticking over leaves the card's HTML byte for byte the same", () => {
    const a = draw(planOf(normaliseRun(raw([step("s1", { status: "running" }), step("s2", { after: ["s1"] })]))));
    const b = draw(planOf(normaliseRun(raw([step("s1", { status: "done" }), step("s2", { after: ["s1"], status: "running" })]))));
    expect(b).toBe(a);
  });

  it("draws no run section over the list of earlier plans or an earlier plan", () => {
    const s = planOf(normaliseRun(raw([step("s1")])));
    const old = { key: "j0", title: "old", steps: [], lead: null, result: null, startedAt: 1, ended: true, plan: null };
    const earlier = { ...s, earlier: [old] };
    expect(dom(renderPlan(earlier, ctx({ ...initialPlanUi(), planList: true }))).querySelector(".rn-host")).toBeNull();
    expect(dom(renderPlan(earlier, ctx({ ...initialPlanUi(), planSel: "j0" }))).querySelector(".rn-host")).toBeNull();
  });

  it("clearing a finished run fades the section itself, then clears", async () => {
    const run = planOf(normaliseRun(raw([step("s1", { status: "done" })], { status: "done" }))).run;
    const root = dom(draw(planOf(normaliseRun(raw([step("s1", { status: "done" })], { status: "done" })))));
    document.body.append(root);
    const host = root.querySelector(".rn-host");
    let cleared = 0;
    const card = new RunCard({ openSub: () => {}, clear: () => { cleared++; } });
    card.update(host, run);
    host.querySelector(".rn-x").click();
    expect(host.classList.contains("is-leaving")).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    expect(cleared).toBe(1);
    card.dispose();
  });
});
