// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/plan-card.ts

// A job reads as ended only from a report_turn_status(done) the daemon accepted:
// a done call whose result has not landed yet may still be refused (the plan has
// open steps), so it must not flash the job as ended. The earlier-plans list
// names a day "Yesterday" by calendar day, also across a clock change.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, rowMs } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { renderPlan, initialPlanUi } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
const result = (id, body, isError = false) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: JSON.stringify(body) }, is_error: isError, timestamp: 0 });

function chat() {
  const r = new ChatRenderer(document.body.appendChild(document.createElement("div")));
  r.handleEvent(userEvent("do it"));
  r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "Build", status: "active" }] }, "p1"));
  r.handleEvent(result("p1", { ok: true }));
  return r;
}
const job = (r) => deriveDashboard({ messages: r.messages, plans: r.dashPlans }).right.find((z) => z.id === "plan").state.job;

describe("a done status that the daemon may still refuse", () => {
  it("does not end the job until the call's result lands", () => {
    const r = chat();
    r.handleEvent(toolUseEvent(STATUS, { status: "done" }, "s1"));
    expect(job(r).ended).toBe(false);
    r.handleEvent(result("s1", { ok: true }));
    expect(job(r).ended).toBe(true);
  });

  it("never ends the job when the daemon refused the done", () => {
    const r = chat();
    r.handleEvent(toolUseEvent(STATUS, { status: "done" }, "s1"));
    r.handleEvent(result("s1", { ok: false, error: "the plan still has open steps" }));
    expect(job(r).ended).toBe(false);
  });
});

describe("row times", () => {
  it("reads seconds from history and milliseconds from live rows", () => {
    expect(rowMs({ ts: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(rowMs({ ts: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(rowMs({ ts: 0 })).toBe(0);
    expect(rowMs({})).toBe(0);
  });
});

describe("the earlier-plans list", () => {
  const stateWith = (starts) => ({
    mode: "current",
    job: { key: "pcur", plan: null, steps: [], lead: null, result: null, title: "Now", startedAt: starts[0], ended: false },
    earlier: starts.map((startedAt, i) => ({ key: `p${i}`, plan: null, steps: [], lead: null, result: null, title: `Job ${i}`, startedAt, ended: true })),
    status: { kind: "idle", since: null },
    steps: [], done: 0, lead: null, result: null, resultSummary: null,
  });
  const dayHeadings = (starts, now) => {
    const html = renderPlan(stateWith(starts), { ui: { ...initialPlanUi(), planList: true }, busy: false, idleAt: null, card: () => "", now });
    const box = document.createElement("div");
    box.innerHTML = html;
    return [...box.querySelectorAll(".cdash-pl-day")].map((e) => e.textContent);
  };

  it("labels today and yesterday by calendar day", () => {
    const now = new Date(2026, 5, 10, 15, 0).getTime();
    expect(dayHeadings([new Date(2026, 5, 9, 9, 0).getTime(), new Date(2026, 5, 10, 8, 0).getTime()], now)).toEqual(["Today", "Yesterday"]);
  });

  it("calls the short spring-forward day Yesterday when asked just after midnight", () => {
    // Needs a zone with a 23-hour day; in one without (UTC) there is no such day and nothing to prove.
    let short = null;
    for (let d = 0; d < 366 && !short; d++) {
      const a = new Date(2026, 0, 1 + d);
      const b = new Date(2026, 0, 2 + d);
      if (b.getTime() - a.getTime() === 23 * 3_600_000) short = a;
    }
    if (!short) return;
    const now = new Date(short.getFullYear(), short.getMonth(), short.getDate() + 1, 0, 30).getTime();
    const onShortDay = new Date(short.getFullYear(), short.getMonth(), short.getDate(), 12, 0).getTime();
    const twoDaysBack = new Date(short.getFullYear(), short.getMonth(), short.getDate() - 1, 12, 0).getTime();
    expect(dayHeadings([twoDaysBack, onShortDay], now)[0]).toBe("Yesterday");
  });
});
