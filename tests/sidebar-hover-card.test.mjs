import { describe, it, expect } from "vitest";
import { buildHoverCardHtml, formatElapsed } from "../src/views/sessions/sidebar-hover-card-html.ts";
import { STATIC_CHIPS } from "../src/views/sessions/statusline-catalog.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const base = { title: "Wiring the driver", project: "claude_usage_in_taskbar", st: "st-working", plan: null, question: null, stateSince: null, contextPct: null, now: NOW };
const plan = (...statuses) => statuses.map((status, i) => ({ text: `step ${i + 1}`, status }));

describe("formatElapsed", () => {
  it("reads minutes, then hours, then days", () => {
    expect(formatElapsed(20_000)).toBe("just now");
    expect(formatElapsed(4 * MIN)).toBe("4m");
    expect(formatElapsed(72 * MIN)).toBe("1h 12m");
    expect(formatElapsed(120 * MIN)).toBe("2h");
    expect(formatElapsed(50 * 60 * MIN)).toBe("2d");
  });
  it("never goes negative on a clock skew", () => {
    expect(formatElapsed(-5 * MIN)).toBe("just now");
  });
});

describe("buildHoverCardHtml", () => {
  it("shows a working chat's turn timer and its plan with the active step marked", () => {
    const html = buildHoverCardHtml({ ...base, stateSince: ago(4 * MIN), plan: plan("done", "done", "active", "pending") });
    expect(html).toContain("Working");
    expect(html).toContain("turn 4m");
    expect(html).toContain("Plan: 2 of 4 steps");
    expect(html).toContain("is-now");
    expect(html.match(/is-done/g)).toHaveLength(2);
  });

  it("shows how long a question has been waiting, the count, and answers given so far", () => {
    const question = {
      questions: [{ question: "Scope?", header: "Scope" }, { question: "Naming?", header: "Naming" }, { question: "Billing?" }],
      answers: ["Both", null, null], total: 3, answered: 1,
    };
    const html = buildHoverCardHtml({ ...base, st: "st-question", stateSince: ago(12 * MIN), question });
    expect(html).toContain("Needs your input");
    expect(html).toContain("waiting 12m");
    expect(html).toContain("1 of 3 answered");
    expect(html).toContain(">Both<");
    // Only the first unanswered question is the current one.
    expect(html.match(/is-now/g)).toHaveLength(1);
    expect(html.match(/is-todo/g)).toHaveLength(1);
  });

  it("windows a long plan around the active step and says how many are hidden", () => {
    const long = plan(...Array(10).fill("done"), "active", ...Array(4).fill("pending"));
    const html = buildHoverCardHtml({ ...base, plan: long });
    expect(html.match(/hc-row /g)).toHaveLength(6);
    expect(html).toContain("+9 more");
    expect(html).toContain("step 11");
  });

  it("uses the statusline's own context icon and rounds the percentage", () => {
    const html = buildHoverCardHtml({ ...base, contextPct: 33.6 });
    expect(html).toContain(`<i class="ph ${STATIC_CHIPS.context_pct.icon}"></i>34%`);
  });

  it("omits the context line until it is known", () => {
    expect(buildHoverCardHtml({ ...base, contextPct: null })).not.toContain("hc-ctx");
  });

  it("drops no state silently: a done chat reads its age, a rate-limited one has no timer", () => {
    expect(buildHoverCardHtml({ ...base, st: "st-your-turn", stateSince: ago(6 * MIN) })).toContain("6m ago");
    const limited = buildHoverCardHtml({ ...base, st: "st-rate-limited", stateSince: ago(6 * MIN) });
    expect(limited).toContain("Usage limit");
    expect(limited).not.toContain("hc-timer");
  });

  it("shows no timer before the daemon has stamped a state change", () => {
    expect(buildHoverCardHtml({ ...base, stateSince: null })).not.toContain("hc-timer");
  });

  it("escapes chat and step text", () => {
    const html = buildHoverCardHtml({ ...base, title: "<img src=x onerror=1>", plan: [{ text: "<b>x</b>", status: "active" }] });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
