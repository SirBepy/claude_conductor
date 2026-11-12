import { describe, it, expect } from "vitest";
import { planProgress, ringHtml, ringSpecFor } from "../src/views/sessions/sidebar-ring.ts";

const step = (text, status) => ({ text, status });
const PLAN = [step("a", "done"), step("b", "done"), step("c", "skipped"), step("d", "active"), step("e", "pending")];

describe("planProgress", () => {
  it("counts done and skipped steps as finished", () => {
    expect(planProgress(PLAN)).toEqual({ done: 3, total: 5 });
  });
  it("is null with no plan, so a chat that never wrote one draws no arc", () => {
    expect(planProgress(null)).toBeNull();
    expect(planProgress(undefined)).toBeNull();
    expect(planProgress([])).toBeNull();
  });
});

describe("ringSpecFor", () => {
  it("draws a plan arc for a working chat that wrote a plan", () => {
    expect(ringSpecFor("st-working", PLAN, null)).toEqual({ kind: "plan", done: 3, total: 5 });
  });
  it("draws a solid, glowing (not rotating) ring for working with no plan", () => {
    expect(ringSpecFor("st-working", null, null)).toEqual({ kind: "solid", tone: "working", glow: true });
  });
  it("draws one segment per question, capping answered at the total", () => {
    expect(ringSpecFor("st-question", null, { total: 4, answered: 2 })).toEqual({ kind: "segments", total: 4, answered: 2 });
    expect(ringSpecFor("st-question", null, { total: 2, answered: 9 })).toEqual({ kind: "segments", total: 2, answered: 2 });
  });
  it("falls back to one pulsing ring when the question count is unknown", () => {
    expect(ringSpecFor("st-question", null, null)).toEqual({ kind: "solid", tone: "question", pulse: true });
  });
  it("gives a done-unread chat a solid green ring and a read one none", () => {
    expect(ringSpecFor("st-done", null, null)).toEqual({ kind: "solid", tone: "done" });
    expect(ringSpecFor("st-your-turn", null, null)).toEqual({ kind: "none" });
  });
  it("gives every other state a solid ring in its own colour, attention pulsing", () => {
    expect(ringSpecFor("st-attention", null, null)).toEqual({ kind: "solid", tone: "attention", pulse: true });
    for (const [cls, tone] of [
      ["st-waiting", "waiting"], ["st-rate-limited", "rate-limited"], ["st-external", "external"],
      ["st-closing", "closing"],
    ]) {
      expect(ringSpecFor(cls, null, null)).toEqual({ kind: "solid", tone });
    }
  });
  it("keeps one segment per question when a question card is in the permission state", () => {
    expect(ringSpecFor("st-attention", null, { total: 6, answered: 0 })).toEqual({ kind: "segments", total: 6, answered: 0, tone: "attention" });
  });
  it("keeps the whole pulsing ring for a single question awaiting permission", () => {
    expect(ringSpecFor("st-attention", null, { total: 1, answered: 0 })).toEqual({ kind: "solid", tone: "attention", pulse: true });
  });
  it("draws nothing for an unknown class", () => {
    expect(ringSpecFor("st-mystery", PLAN, null)).toEqual({ kind: "none" });
  });
});

describe("ringHtml", () => {
  const count = (html, re) => (html.match(re) ?? []).length;

  it("is empty for none", () => {
    expect(ringHtml({ kind: "none" })).toBe("");
  });
  it("draws a question ring as one circle per ask, only the current one pulsing", () => {
    const html = ringHtml({ kind: "segments", total: 4, answered: 2 });
    expect(count(html, /<circle/g)).toBe(4);
    expect(count(html, /is-pulse/g)).toBe(1);
    expect(count(html, /is-track/g)).toBe(1);
  });
  it("pulses the whole ring for a single question", () => {
    const html = ringHtml({ kind: "segments", total: 1, answered: 0 });
    expect(count(html, /<circle/g)).toBe(1);
    expect(count(html, /is-pulse/g)).toBe(1);
  });
  it("stops pulsing once every question is answered", () => {
    expect(count(ringHtml({ kind: "segments", total: 3, answered: 3 }), /is-pulse/g)).toBe(0);
  });
  it("draws a plan as a dim track plus a filled arc, and just the track at zero done", () => {
    expect(count(ringHtml({ kind: "plan", done: 3, total: 7 }), /<circle/g)).toBe(2);
    expect(count(ringHtml({ kind: "plan", done: 0, total: 7 }), /<circle/g)).toBe(1);
  });
  it("sizes the plan arc to done over total of the circumference", () => {
    const html = ringHtml({ kind: "plan", done: 1, total: 2 });
    const arc = html.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)[1].match(/[\d.]+/g).map(Number);
    expect(arc[0] / (arc[0] + arc[1])).toBeCloseTo(0.5, 2);
  });
  it("colours attention segments by their own tone", () => {
    const html = ringHtml({ kind: "segments", total: 3, answered: 0, tone: "attention" });
    expect(count(html, /data-tone="attention"/g)).toBe(3);
  });
  it("starts a rebuilt pulse mid-cycle so a sidebar refresh does not restart it", () => {
    const delay = (html) => Number(html.match(/animation-delay:-(\d+)ms/)[1]);
    const html = ringHtml({ kind: "segments", total: 1, answered: 0 });
    expect(delay(html)).toBeLessThan(1400);
    expect(ringHtml({ kind: "plan", done: 1, total: 2 })).not.toContain("animation-delay");
    expect(delay(ringHtml({ kind: "solid", tone: "working", glow: true }))).toBeLessThan(3200);
  });
  it("marks a working-no-plan ring as glowing, not as the question pulse", () => {
    const html = ringHtml({ kind: "solid", tone: "working", glow: true });
    expect(html).toContain("is-glow");
    expect(html).not.toContain("is-pulse");
  });
});
