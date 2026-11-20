// @vitest-environment jsdom
// asserts: src/views/sessions/chat-heads-model.ts
// asserts: src/views/sessions/chat-heads.ts
// asserts: src/shared/chat/dashboard/answers-model.ts
//
// The top-right badge of a chat head: ONE number by priority (red cards, purple unread answers, green
// finished subs; 9+ over nine, nothing at zero) and, inline beside it, a pencil when the chat holds a
// draft to send. A hidden chat shows no number. The number pops in once when it rises or changes
// priority; every other change patches in place and replays nothing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const { unreadLabel, tagOf, headMark, finishedUnseen, draftOwners, headTagsEqual, UNREAD_CAP } = await import("../src/views/sessions/chat-heads-model.ts");
const { unreadAnswerCount, unreadAnswerCountFromEvents, emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");
const { tagHtml, HEAD_RECONCILE } = await import("../src/views/sessions/chat-heads.ts");
const { reconcileList } = await import("../src/views/sessions/sidebar-anim.ts");

const SEND = "mcp__cc_conductor__send_message";
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });
const answer = (id, ts) => toolUseEvent(SEND, { kind: "answer", verdict: `Yes ${id}`, text: "Done." }, id, ts);

describe("unreadLabel", () => {
  it("is empty at zero, the number to nine and 9+ above", () => {
    expect(UNREAD_CAP).toBe(9);
    expect(unreadLabel(0)).toBe("");
    expect(unreadLabel(-2)).toBe("");
    expect(unreadLabel(1)).toBe("1");
    expect(unreadLabel(9)).toBe("9");
    expect(unreadLabel(10)).toBe("9+");
    expect(unreadLabel(400)).toBe("9+");
  });
});

describe("tagOf", () => {
  it("is null when there is neither an unread answer, a finished sub nor a draft", () => {
    expect(tagOf(0, false)).toBeNull();
    expect(tagOf(undefined, undefined)).toBeNull();
  });
  it("carries the counts and the draft mark independently", () => {
    expect(tagOf(3, false)).toEqual({ unread: 3, finished: 0, draft: false });
    expect(tagOf(0, true)).toEqual({ unread: 0, finished: 0, draft: true });
    expect(tagOf(12, true, 2)).toEqual({ unread: 12, finished: 2, draft: true });
    expect(tagOf(0, false, 1)).toEqual({ unread: 0, finished: 1, draft: false });
  });
});

describe("headMark: one number by priority", () => {
  const base = { waiting: 0, unread: 0, finished: 0, hidden: false, open: false, draft: false };
  const mark = (over) => headMark({ ...base, ...over });
  it("shows nothing when nothing is unseen and no draft waits", () => {
    expect(mark({})).toBeNull();
  });
  it("red (cards waiting) outranks purple (unread answers), which outranks green (finished subs)", () => {
    expect(mark({ waiting: 2, unread: 3, finished: 4 })).toEqual({ badge: { kind: "red", n: 2 }, draft: false });
    expect(mark({ unread: 3, finished: 4 })).toEqual({ badge: { kind: "purple", n: 3 }, draft: false });
    expect(mark({ finished: 4 })).toEqual({ badge: { kind: "green", n: 4 }, draft: false });
  });
  it("never carries two numbers: every combination shows exactly the one its priority picks", () => {
    for (const waiting of [0, 1, 5]) for (const unread of [0, 2]) for (const finished of [0, 3]) for (const open of [false, true]) {
      const want = waiting > 0 ? { kind: "red", n: waiting }
        : !open && unread > 0 ? { kind: "purple", n: unread }
        : !open && finished > 0 ? { kind: "green", n: finished }
        : null;
      expect(mark({ waiting, unread, finished, open })?.badge ?? null, JSON.stringify({ waiting, unread, finished, open })).toEqual(want);
    }
  });
  it("keeps the pencil beside the number, or alone", () => {
    expect(mark({ unread: 1, draft: true })).toEqual({ badge: { kind: "purple", n: 1 }, draft: true });
    expect(mark({ draft: true })).toEqual({ badge: null, draft: true });
  });
  it("a hidden chat shows no number, whatever it holds, and keeps its pencil", () => {
    expect(mark({ hidden: true, waiting: 3, unread: 2, finished: 1 })).toBeNull();
    expect(mark({ hidden: true, waiting: 3, draft: true })).toEqual({ badge: null, draft: true });
  });
  it("the open chat has nothing unseen: viewing clears purple and green, but a card stays red until answered", () => {
    expect(mark({ open: true, unread: 3, finished: 2 })).toBeNull();
    expect(mark({ open: true, waiting: 1, unread: 3 })).toEqual({ badge: { kind: "red", n: 1 }, draft: false });
  });
});

describe("finishedUnseen", () => {
  const subs = [
    { id: "s1", kind: "finished", finishedAt: 100 },
    { id: "s2", kind: "finished", finishedAt: 300 },
    { id: "s3", kind: "working", finishedAt: null },
    { id: "s4", kind: "finished", finishedAt: null },
  ];
  it("counts finished subs that ended after the main chat was last viewed", () => {
    expect(finishedUnseen(subs, () => 0, "m")).toBe(2);
    expect(finishedUnseen(subs, (id) => (id === "m" ? 200 : 0), "m")).toBe(1);
    expect(finishedUnseen(subs, (id) => (id === "m" ? 400 : 0), "m")).toBe(0);
  });
  it("a sub viewed on its own is seen even when the main chat was not", () => {
    expect(finishedUnseen(subs, (id) => (id === "s2" ? 300 : 0), "m")).toBe(1);
  });
  it("ignores subs that are not finished or carry no finish time", () => {
    expect(finishedUnseen([subs[2], subs[3]], () => 0, "m")).toBe(0);
  });
});

describe("draftOwners", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const draft = (over = {}) => ({
    id: "d", state: "needs-you", updated_at: "2026-11-18T10:00:00Z",
    origin_session_id: "chat-a", variants: [{ sent: false }], ...over,
  });
  it("names the chat that wrote an open draft, and the main chat of a sub that did", () => {
    const owners = draftOwners([
      draft(),
      draft({ id: "d2", origin_session_id: "sub-1", origin_main_session_id: "main-1" }),
    ], now);
    expect([...owners].sort()).toEqual(["chat-a", "main-1", "sub-1"]);
  });
  it("skips copied, archived, stale and fully sent drafts", () => {
    const owners = draftOwners([
      draft({ state: "copied" }),
      draft({ state: "archived", origin_session_id: "b" }),
      draft({ updated_at: "2026-10-01T10:00:00Z", origin_session_id: "c" }),
      draft({ variants: [{ sent: true }], origin_session_id: "d" }),
    ], now);
    expect(owners.size).toBe(0);
  });
  it("counts a draft with one wording still to send", () => {
    expect(draftOwners([draft({ variants: [{ sent: true }, { sent: false }] })], now).has("chat-a")).toBe(true);
  });
});

describe("headTagsEqual", () => {
  it("compares counts and draft per chat", () => {
    const a = new Map([["x", { unread: 1, finished: 0, draft: false }]]);
    expect(headTagsEqual(a, new Map([["x", { unread: 1, finished: 0, draft: false }]]))).toBe(true);
    expect(headTagsEqual(a, new Map([["x", { unread: 2, finished: 0, draft: false }]]))).toBe(false);
    expect(headTagsEqual(a, new Map([["x", { unread: 1, finished: 1, draft: false }]]))).toBe(false);
    expect(headTagsEqual(a, new Map([["x", { unread: 1, finished: 0, draft: true }]]))).toBe(false);
    expect(headTagsEqual(a, new Map())).toBe(false);
  });
});

describe("unreadAnswerCount", () => {
  it("counts the answers Joe has not read, the same set the Answers card keeps", () => {
    const events = [userEvent("q1", 1), answer("a1", 2), userEvent("q2", 3), answer("a2", 4), answer("a3", 5)];
    expect(unreadAnswerCountFromEvents(events, { store: emptyStore(), threads: [] })).toBe(3);
  });
  it("drops an answer once Got it marked it read", () => {
    const events = [userEvent("q1", 1), answer("a1", 2), answer("a2", 3)];
    const store = { ...emptyStore(), read: { a1: 1000 } };
    expect(unreadAnswerCountFromEvents(events, { store, threads: [] })).toBe(1);
  });
  it("is zero when the chat holds no answer, and ignores other message kinds", () => {
    const events = [userEvent("hello", 1), toolUseEvent(SEND, { kind: "report", text: "done" }, "r1", 2), ok("r1")];
    expect(unreadAnswerCountFromEvents(events, { store: emptyStore(), threads: [] })).toBe(0);
    expect(unreadAnswerCountFromEvents([], { store: emptyStore(), threads: [] })).toBe(0);
  });
  it("counts rendered rows the same way as events", () => {
    const rows = [{ kind: "message", id: "a1", text: "x", ts: 1, parentToolUseId: null, card: { kind: "answer", verdict: "Yes" } }];
    expect(unreadAnswerCount(rows, { store: emptyStore(), threads: [] })).toBe(1);
  });
});

describe("tagHtml", () => {
  it("draws the count first and the pencil beside it in one tag", () => {
    const el = document.createElement("div");
    el.innerHTML = tagHtml(P(3, true));
    const tag = el.querySelector(".chat-head-tag");
    expect(tag).not.toBeNull();
    expect([...tag.children].map((c) => c.className)).toEqual(["ht-n is-purple", "ht-draft"]);
    expect(tag.querySelector(".ht-n").textContent).toBe("3");
    expect(tag.querySelector(".ht-draft .ph-pencil-simple")).not.toBeNull();
  });
  it("caps the number at 9+, and draws a lone pencil or a lone count", () => {
    const el = document.createElement("div");
    el.innerHTML = tagHtml(P(14, false));
    expect(el.querySelector(".ht-n").textContent).toBe("9+");
    expect(el.querySelector(".ht-draft")).toBeNull();
    el.innerHTML = tagHtml({ badge: null, draft: true });
    expect(el.querySelector(".ht-n")).toBeNull();
    expect(el.querySelector(".ht-draft")).not.toBeNull();
  });
  it("draws nothing at zero and no draft", () => {
    expect(tagHtml(null)).toBe("");
    expect(tagHtml({ badge: null, draft: false })).toBe("");
    expect(tagHtml({ badge: { kind: "purple", n: 0 }, draft: false })).toBe("");
  });
});

/** A purple mark with `n` and the draft pencil, the shape headMark hands the head. */
const P = (n, draft, kind = "purple") => ({ badge: { kind, n }, draft });

const portrait = `<span class="chat-head-portrait"><img class="char-avatar chat-head-img" data-character-id="a" alt="a"></span>`;
const head = (id, tag) => `<li class="chat-head" data-row-key="${id}" data-session-id="${id}"><span class="chat-head-face">${portrait}${tagHtml(tag)}</span></li>`;
const makeList = () => {
  const ul = document.createElement("ul");
  document.body.appendChild(ul);
  return ul;
};
const li = (ul, id) => ul.querySelector(`li[data-row-key="${id}"]`);
const render = (ul, tag) => reconcileList(ul, [{ key: "a", html: head("a", tag) }], true, HEAD_RECONCILE);

describe("patching a head's tag", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("pops the tag in once when the first unread answer arrives", () => {
    const ul = makeList();
    render(ul, null);
    vi.runAllTimers();
    render(ul, P(1, false));
    const tag = li(ul, "a").querySelector(".chat-head-tag");
    expect(tag.classList.contains("is-pop")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(tag.classList.contains("is-pop")).toBe(false);
  });

  it("pops the number when it rises and patches a fall in place without a replay", () => {
    const ul = makeList();
    render(ul, P(2, false));
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".ht-n");
    render(ul, P(3, false));
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("3");
    expect(n.classList.contains("is-pop")).toBe(true);
    vi.advanceTimersByTime(400);
    render(ul, P(1, false));
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("1");
    expect(n.classList.contains("is-pop")).toBe(false);
  });

  it("a change of priority keeps the node, eases its colour class and pops the number once", () => {
    const ul = makeList();
    render(ul, P(2, false, "purple"));
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".ht-n");
    expect(n.classList.contains("is-purple")).toBe(true);
    render(ul, P(1, false, "red"));
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.classList.contains("is-red")).toBe(true);
    expect(n.classList.contains("is-purple")).toBe(false);
    expect(n.textContent).toBe("1");
    expect(li(ul, "a").querySelector(".chat-head-tag").getAttribute("data-kind")).toBe("red");
    // The number fell (2 to 1) yet the new priority pops it: it is a different kind of number.
    expect(n.classList.contains("is-pop")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(n.classList.contains("is-pop")).toBe(false);
  });

  it("draws the kind on the number and as a label a screen reader can say", () => {
    const el = document.createElement("div");
    for (const [kind, word] of [["red", "waiting"], ["purple", "unread"], ["green", "finished"]]) {
      el.innerHTML = tagHtml(P(2, false, kind));
      const n = el.querySelector(".ht-n");
      expect(n.classList.contains(`is-${kind}`)).toBe(true);
      expect(n.getAttribute("aria-label")).toContain(word);
    }
  });

  it("does not pop when the count rises but the capped label stays 9+", () => {
    const ul = makeList();
    render(ul, P(10, false));
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".ht-n");
    render(ul, P(11, false));
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("9+");
    expect(n.classList.contains("is-pop")).toBe(false);
  });

  it("replays nothing when the head re-renders with the same tag", () => {
    const ul = makeList();
    render(ul, P(2, true));
    vi.runAllTimers();
    const mutations = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(li(ul, "a"), { subtree: true, attributes: true, childList: true, characterData: true });
    render(ul, P(2, true));
    vi.runAllTimers();
    expect(mo.takeRecords().length + mutations.length).toBe(0);
  });

  it("adds and fades the pencil inside the same tag", () => {
    const ul = makeList();
    render(ul, P(2, false));
    vi.runAllTimers();
    const tag = li(ul, "a").querySelector(".chat-head-tag");
    render(ul, P(2, true));
    expect(li(ul, "a").querySelector(".chat-head-tag")).toBe(tag);
    expect(tag.querySelector(".ht-draft")).not.toBeNull();
    vi.runAllTimers();
    render(ul, P(2, false));
    expect(tag.querySelector(".ht-draft")?.classList.contains("is-leaving")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(tag.querySelector(".ht-draft")).toBeNull();
  });

  it("fades the whole tag out when the last answer is read", () => {
    const ul = makeList();
    render(ul, P(1, false));
    vi.runAllTimers();
    const tag = li(ul, "a").querySelector(".chat-head-tag");
    render(ul, null);
    expect(tag.classList.contains("is-leaving")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(li(ul, "a").querySelector(".chat-head-tag")).toBeNull();
  });

  it("keeps the portrait node across every tag change", () => {
    const ul = makeList();
    render(ul, null);
    vi.runAllTimers();
    const img = li(ul, "a").querySelector("img");
    render(ul, P(4, true));
    render(ul, P(5, false));
    render(ul, null);
    expect(li(ul, "a").querySelector("img")).toBe(img);
  });
});
