// @vitest-environment jsdom
// asserts: src/views/sessions/chat-heads-model.ts
// asserts: src/views/sessions/chat-heads.ts
// asserts: src/shared/chat/dashboard/answers-model.ts
//
// The top-right tag of a chat head: the unread-answer count (9+ over nine, nothing at zero) and,
// inline beside it, a pencil when the chat holds a draft to send. Hidden chats roll their unread
// count up onto the eye button. The count pops in once when it rises; every other change patches in
// place and replays nothing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const { unreadLabel, tagOf, hiddenUnread, draftOwners, headTagsEqual, UNREAD_CAP } = await import("../src/views/sessions/chat-heads-model.ts");
const { unreadAnswerCount, unreadAnswerCountFromEvents, emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");
const { tagHtml, patchHead, HEAD_RECONCILE } = await import("../src/views/sessions/chat-heads.ts");
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
  it("is null when there is neither an unread answer nor a draft", () => {
    expect(tagOf(0, false)).toBeNull();
    expect(tagOf(undefined, undefined)).toBeNull();
  });
  it("carries the count and the draft mark independently", () => {
    expect(tagOf(3, false)).toEqual({ unread: 3, draft: false });
    expect(tagOf(0, true)).toEqual({ unread: 0, draft: true });
    expect(tagOf(12, true)).toEqual({ unread: 12, draft: true });
  });
});

describe("hiddenUnread", () => {
  it("adds up the hidden chats' unread answers and nothing else", () => {
    const tags = new Map([
      ["h1", { unread: 2, draft: false }],
      ["h2", { unread: 3, draft: true }],
      ["shown", { unread: 7, draft: false }],
      ["h3", { unread: 0, draft: true }],
    ]);
    expect(hiddenUnread(["h1", "h2", "h3", "gone"], tags)).toBe(5);
    expect(hiddenUnread([], tags)).toBe(0);
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
  it("compares count and draft per chat", () => {
    const a = new Map([["x", { unread: 1, draft: false }]]);
    expect(headTagsEqual(a, new Map([["x", { unread: 1, draft: false }]]))).toBe(true);
    expect(headTagsEqual(a, new Map([["x", { unread: 2, draft: false }]]))).toBe(false);
    expect(headTagsEqual(a, new Map([["x", { unread: 1, draft: true }]]))).toBe(false);
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
    el.innerHTML = tagHtml({ unread: 3, draft: true });
    const tag = el.querySelector(".chat-head-tag");
    expect(tag).not.toBeNull();
    expect([...tag.children].map((c) => c.className)).toEqual(["ht-n", "ht-draft"]);
    expect(tag.querySelector(".ht-n").textContent).toBe("3");
    expect(tag.querySelector(".ht-draft .ph-pencil-simple")).not.toBeNull();
  });
  it("caps the number at 9+, and draws a lone pencil or a lone count", () => {
    const el = document.createElement("div");
    el.innerHTML = tagHtml({ unread: 14, draft: false });
    expect(el.querySelector(".ht-n").textContent).toBe("9+");
    expect(el.querySelector(".ht-draft")).toBeNull();
    el.innerHTML = tagHtml({ unread: 0, draft: true });
    expect(el.querySelector(".ht-n")).toBeNull();
    expect(el.querySelector(".ht-draft")).not.toBeNull();
  });
  it("draws nothing at zero and no draft", () => {
    expect(tagHtml(null)).toBe("");
    expect(tagHtml({ unread: 0, draft: false })).toBe("");
  });
});

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
    render(ul, { unread: 1, draft: false });
    const tag = li(ul, "a").querySelector(".chat-head-tag");
    expect(tag.classList.contains("is-pop")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(tag.classList.contains("is-pop")).toBe(false);
  });

  it("pops the number when it rises and patches a fall in place without a replay", () => {
    const ul = makeList();
    render(ul, { unread: 2, draft: false });
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".ht-n");
    render(ul, { unread: 3, draft: false });
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("3");
    expect(n.classList.contains("is-pop")).toBe(true);
    vi.advanceTimersByTime(400);
    render(ul, { unread: 1, draft: false });
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("1");
    expect(n.classList.contains("is-pop")).toBe(false);
  });

  it("does not pop when the count rises but the capped label stays 9+", () => {
    const ul = makeList();
    render(ul, { unread: 10, draft: false });
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".ht-n");
    render(ul, { unread: 11, draft: false });
    expect(li(ul, "a").querySelector(".ht-n")).toBe(n);
    expect(n.textContent).toBe("9+");
    expect(n.classList.contains("is-pop")).toBe(false);
  });

  it("replays nothing when the head re-renders with the same tag", () => {
    const ul = makeList();
    render(ul, { unread: 2, draft: true });
    vi.runAllTimers();
    const mutations = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(li(ul, "a"), { subtree: true, attributes: true, childList: true, characterData: true });
    render(ul, { unread: 2, draft: true });
    vi.runAllTimers();
    expect(mo.takeRecords().length + mutations.length).toBe(0);
  });

  it("adds and fades the pencil inside the same tag", () => {
    const ul = makeList();
    render(ul, { unread: 2, draft: false });
    vi.runAllTimers();
    const tag = li(ul, "a").querySelector(".chat-head-tag");
    render(ul, { unread: 2, draft: true });
    expect(li(ul, "a").querySelector(".chat-head-tag")).toBe(tag);
    expect(tag.querySelector(".ht-draft")).not.toBeNull();
    vi.runAllTimers();
    render(ul, { unread: 2, draft: false });
    expect(tag.querySelector(".ht-draft")?.classList.contains("is-leaving")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(tag.querySelector(".ht-draft")).toBeNull();
  });

  it("fades the whole tag out when the last answer is read", () => {
    const ul = makeList();
    render(ul, { unread: 1, draft: false });
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
    render(ul, { unread: 4, draft: true });
    render(ul, { unread: 5, draft: false });
    render(ul, null);
    expect(li(ul, "a").querySelector("img")).toBe(img);
  });
});
