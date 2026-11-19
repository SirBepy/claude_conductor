// asserts: src/views/sessions/chat-dashboard/done-card.ts

// The opened Done row shows the chats of its task as an avatar stack (the Subchats card's own avatar):
// at most STACK_MAX faces, the rest as "+N", with the count as visible text beside it. A compact row
// draws no avatar at all (Joe, 2026-11-19). The faces are no tab stops and the stack takes no click,
// so the row's button stays the one control.

import { describe, it, expect } from "vitest";

const { renderDone, STACK_MAX } = await import("../src/views/sessions/chat-dashboard/done-card.ts");

const sub = (id) => ({
  id, name: `job-${id}`, kind: "finished", closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "finished", startedAt: null, finishedAt: 1_000, ring: { kind: "none" },
});
const ctx = (open = null) => ({
  open, card: null, leaving: new Set(), cardHtml: () => "<p>card</p>", ctxChip: () => "", ctxPct: () => null, when: () => "now",
  full: () => "19 Nov, 6:26 pm",
});
const taskOf = (n) => ({
  subCount: n,
  tasks: [{ key: "task:job", title: "Job", todoId: null, closing: false, doneAt: 1_000, subs: Array.from({ length: n }, (_, i) => ({ sub: sub(`s${i}`), report: null })) }],
});
const faces = (html) => (html.match(/class="sx-av/g) ?? []).length;
const OPEN = "task:job";

describe("Done row avatar stack", () => {
  it("draws no avatar, chevron or count in a compact row", () => {
    const html = renderDone(taskOf(3), ctx());
    expect(faces(html)).toBe(0);
    expect(html).not.toContain("dn-avs");
    expect(html).not.toContain("dn-chev");
    expect(html).not.toContain("caret-right");
  });

  it("draws every chat up to the cap in the opened row and no +N", () => {
    expect(STACK_MAX).toBe(3);
    for (const n of [1, 2, 3]) {
      const html = renderDone(taskOf(n), ctx(OPEN));
      // The stack's faces, plus one avatar per chat row below it.
      expect(html.match(/class="dn-avs-i"/g)).toHaveLength(n);
      expect(html).not.toContain("dn-avs-more");
    }
  });

  it("caps at three faces and counts the rest as +N", () => {
    const html = renderDone(taskOf(5), ctx(OPEN));
    expect(html.match(/class="dn-avs-i"/g)).toHaveLength(3);
    expect(html).toContain('class="dn-avs-more">+2<');
    expect(renderDone(taskOf(4), ctx(OPEN))).toContain(">+1<");
  });

  it("keeps the count as text, singular for one chat", () => {
    expect(renderDone(taskOf(1), ctx(OPEN))).toContain('<span class="dn-n">1 chat</span>');
    expect(renderDone(taskOf(5), ctx(OPEN))).toContain('<span class="dn-n">5 chats</span>');
  });

  it("shows the full date and time beside the stack", () => {
    expect(renderDone(taskOf(2), ctx(OPEN))).toContain('<time class="dn-full">19 Nov, 6:26 pm</time>');
  });

  it("makes the stack's faces no tab stops and gives the stack no click action", () => {
    const html = renderDone(taskOf(2), ctx(OPEN));
    const stack = /<span class="dn-avs">(.*?)<\/span><span class="dn-n">/.exec(html)?.[1] ?? "";
    expect(stack.match(/<button tabindex="-1" type="button" class="sx-av/g)).toHaveLength(2);
    expect(stack).not.toContain("data-act");
  });

  it("draws the details only for the open task, as the settled state", () => {
    expect(renderDone(taskOf(2), ctx())).not.toContain("dn-det");
    const open = renderDone(taskOf(2), ctx(OPEN));
    expect(open).toContain('class="dn-det"');
    expect(open).not.toContain("is-shut");
    expect(open).toContain('class="dn-task is-open"');
  });
});
