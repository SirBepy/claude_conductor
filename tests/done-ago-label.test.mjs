// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/done-card.ts

// Joe, 2026-11-19: a Done row says how long ago it finished ("20 min ago", "1 hr ago", "1 d ago"),
// not a clock or a date. The words are whole units, rounded down, so a label changes only when a
// unit completes; the row's text is filled in place (fillAgo) and never part of the diffed HTML.

import { describe, it, expect } from "vitest";

const { agoLabel } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { fillAgo, renderDone } = await import("../src/views/sessions/chat-dashboard/done-card.ts");

const NOW = 1_800_000_000_000;
const S = 1000;
const MIN = 60 * S;
const HR = 60 * MIN;
const DAY = 24 * HR;
const ago = (ms) => agoLabel(NOW - ms, NOW);

describe("agoLabel buckets", () => {
  it("is 'just now' up to 59 s, then whole minutes", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * S)).toBe("just now");
    expect(ago(60 * S)).toBe("1 min ago");
    expect(ago(20 * MIN)).toBe("20 min ago");
    expect(ago(59 * MIN)).toBe("59 min ago");
    expect(ago(59 * MIN + 59 * S)).toBe("59 min ago");
  });

  it("moves to hours at 60 min and to days at 24 h", () => {
    expect(ago(60 * MIN)).toBe("1 hr ago");
    expect(ago(5 * HR)).toBe("5 hr ago");
    expect(ago(23 * HR)).toBe("23 hr ago");
    expect(ago(23 * HR + 59 * MIN)).toBe("23 hr ago");
    expect(ago(24 * HR)).toBe("1 d ago");
    expect(ago(3 * DAY)).toBe("3 d ago");
    expect(ago(29 * DAY)).toBe("29 d ago");
  });

  it("moves to months at 30 d", () => {
    expect(ago(30 * DAY)).toBe("1 mo ago");
    expect(ago(65 * DAY)).toBe("2 mo ago");
  });

  it("reads a time in the future (clock skew) as 'just now'", () => {
    expect(agoLabel(NOW + 5 * MIN, NOW)).toBe("just now");
  });
});

const sub = (id, finishedAt) => ({
  id, name: `job-${id}`, kind: "finished", closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "finished", startedAt: null, finishedAt, ring: { kind: "none" },
});
const ctx = (open = null) => ({
  open, card: null, leaving: new Set(), cardHtml: () => "", ctxChip: () => "", ctxPct: () => null,
  when: () => "6:26 pm", full: () => "19 Nov, 6:26 pm",
});
const state = (doneAt) => ({
  subCount: 1,
  tasks: [{ key: "task:job", title: "Job", todoId: null, closing: false, doneAt, subs: [{ sub: sub("a", doneAt), report: null }] }],
});

describe("Done row age text", () => {
  it("is filled from data-ms, so the drawn HTML never changes as a row ages", () => {
    const html = renderDone(state(NOW - 20 * MIN), ctx());
    expect(html).toContain(`data-ms="${NOW - 20 * MIN}"`);
    expect(html).not.toContain("min ago");
    const host = document.createElement("div");
    host.innerHTML = html;
    fillAgo(host, NOW);
    expect(host.querySelector(".dn-at").textContent).toBe("20 min ago");
    // A minute later the same node reads 21 min: patched in place, same element.
    const el = host.querySelector(".dn-at");
    fillAgo(host, NOW + MIN);
    expect(host.querySelector(".dn-at")).toBe(el);
    expect(el.textContent).toBe("21 min ago");
  });

  it("leaves a node whose label did not change untouched", () => {
    const host = document.createElement("div");
    host.innerHTML = renderDone(state(NOW - 5 * HR), ctx());
    fillAgo(host, NOW);
    const seen = [];
    const obs = new MutationObserver((m) => seen.push(...m));
    obs.observe(host, { subtree: true, childList: true, characterData: true });
    fillAgo(host, NOW + 10 * MIN);
    return Promise.resolve().then(() => {
      obs.disconnect();
      expect(seen).toEqual([]);
    });
  });

  it("draws a task with no finish time without a time", () => {
    const html = renderDone(state(null), ctx());
    expect(html).not.toContain("dn-at");
  });
});
