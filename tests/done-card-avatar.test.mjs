// asserts: src/views/sessions/chat-dashboard/done-card.ts

// pc-1771 item 12: a Done row whose chat left no finish card has a disabled row button, so its
// avatar must not be a click target either; a click would set `ui.doneCard` and the card would
// pop open later, when the finish card loads.

import { describe, it, expect } from "vitest";

const { renderDone } = await import("../src/views/sessions/chat-dashboard/done-card.ts");

const sub = (id) => ({
  id, name: `job-${id}`, kind: "finished", closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "finished", startedAt: null, finishedAt: 1_000, ring: { kind: "none" },
});
const report = { id: "card-a", kind: "message", subCard: { id: "card-a", kind: "finish", verdict: "Built it", sub_id: "a" } };

const ctx = (key) => ({
  open: key, card: null, leaving: new Set(), cardHtml: () => "<p>card</p>", ctxChip: () => "", ctxPct: () => null, when: () => "now",
});
const state = (withReport) => ({
  subCount: 1,
  tasks: [{ key: "task:job-a", title: "Job a", todoId: null, closing: false, doneAt: 1_000, subs: [{ sub: sub("a"), report: withReport ? report : null }] }],
});
const avatarOf = (html) => /<span class="dn-av"([^>]*)>/.exec(html)?.[1] ?? null;

describe("Done row avatar", () => {
  it("carries no click action when the row has no report to open", () => {
    const attrs = avatarOf(renderDone(state(false), ctx("task:job-a")));
    expect(attrs).not.toBeNull();
    expect(attrs).not.toContain("data-act");
  });

  it("opens the report when there is one", () => {
    expect(avatarOf(renderDone(state(true), ctx("task:job-a")))).toContain('data-act="done-card"');
  });
});
