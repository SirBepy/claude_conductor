// asserts: src/views/sessions/chat-dashboard/done-card.ts

// A Done row shows the chats of its task as an avatar stack (the Subchats card's own avatar): at
// most STACK_MAX faces, the rest as "+N", with the count as text for a screen reader. The stack's
// faces are no tab stops and its click opens the row, so the row's button stays the one control.

import { describe, it, expect } from "vitest";

const { renderDone, STACK_MAX } = await import("../src/views/sessions/chat-dashboard/done-card.ts");

const sub = (id) => ({
  id, name: `job-${id}`, kind: "finished", closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "finished", startedAt: null, finishedAt: 1_000, ring: { kind: "none" },
});
const ctx = (open = null) => ({
  open, card: null, leaving: new Set(), cardHtml: () => "<p>card</p>", ctxChip: () => "", ctxPct: () => null, when: () => "now",
});
const taskOf = (n) => ({
  subCount: n,
  tasks: [{ key: "task:job", title: "Job", todoId: null, closing: false, doneAt: 1_000, subs: Array.from({ length: n }, (_, i) => ({ sub: sub(`s${i}`), report: null })) }],
});
const faces = (html) => (html.match(/class="sx-av/g) ?? []).length;

describe("Done row avatar stack", () => {
  it("draws every chat up to the cap and no +N", () => {
    expect(STACK_MAX).toBe(3);
    for (const n of [1, 2, 3]) {
      const html = renderDone(taskOf(n), ctx());
      expect(faces(html)).toBe(n);
      expect(html).not.toContain("dn-avs-more");
    }
  });

  it("caps at three faces and counts the rest as +N", () => {
    const html = renderDone(taskOf(5), ctx());
    expect(faces(html)).toBe(3);
    expect(html).toContain('class="dn-avs-more" style="--k:0">+2<');
    expect(renderDone(taskOf(4), ctx())).toContain(">+1<");
  });

  it("keeps the count as text, singular for one chat", () => {
    expect(renderDone(taskOf(1), ctx())).toContain('<em class="dn-n">1 chat</em>');
    expect(renderDone(taskOf(5), ctx())).toContain('<em class="dn-n">5 chats</em>');
  });

  it("makes the faces no tab stops, and a click on the stack opens the row", () => {
    const html = renderDone(taskOf(2), ctx());
    expect(html.match(/<button tabindex="-1" type="button" class="sx-av/g)).toHaveLength(2);
    expect(/<span class="dn-avs" data-act="done-open" data-task="task:job">/.test(html)).toBe(true);
  });

  it("draws the first (earliest) face with the largest spread offset so the stack opens leftward", () => {
    const html = renderDone(taskOf(3), ctx());
    expect([...html.matchAll(/class="dn-avs-i" style="--k:(\d)"/g)].map((m) => m[1])).toEqual(["2", "1", "0"]);
  });

  it("counts the +N chip as the rightmost item, so the spread steps are even", () => {
    const html = renderDone(taskOf(5), ctx());
    expect([...html.matchAll(/class="dn-avs-i" style="--k:(\d)"/g)].map((m) => m[1])).toEqual(["3", "2", "1"]);
    expect(html).toContain('class="dn-avs-more" style="--k:0"');
  });

  it("draws the details only for the open task, as the settled state", () => {
    expect(renderDone(taskOf(2), ctx())).not.toContain("dn-det");
    const open = renderDone(taskOf(2), ctx("task:job"));
    expect(open).toContain('class="dn-det"');
    expect(open).not.toContain("is-shut");
    expect(open).toContain('class="dn-task is-open"');
  });
});
