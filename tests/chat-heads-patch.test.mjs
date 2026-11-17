// @vitest-environment jsdom
//
// A status update patches a chat head part by part (the reconciler's `patch` hook) instead of
// replacing the face, and a head stays the same DOM node across renders. Replacing the face
// restarted the hover nudge (the "bounce") and reloaded the portrait.
//
// asserts: src/views/sessions/chat-heads.ts
// asserts: src/views/sessions/sidebar-anim.ts

import { describe, it, expect, beforeEach, vi } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const { patchHead, HEAD_RECONCILE } = await import("../src/views/sessions/chat-heads.ts");
const { reconcileList } = await import("../src/views/sessions/sidebar-anim.ts");

const portrait = `<span class="chat-head-portrait"><img class="char-avatar chat-head-img" data-character-id="a" alt="a"></span>`;
const ring = (tone, delay = 10) =>
  `<svg class="avatar-ring" style="animation-delay:-${delay}ms"><circle data-tone="${tone}"></circle></svg>`;
const count = (n) => `<span class="chat-head-count">${n}</span>`;

function head(id, tone, extra = "") {
  return `<li class="chat-head" data-row-key="${id}" data-session-id="${id}"><span class="chat-head-face">${portrait}${ring(tone)}${extra}</span></li>`;
}

function makeList() {
  const ul = document.createElement("ul");
  ul.className = "chat-heads-list";
  document.body.appendChild(ul);
  return ul;
}

const li = (ul, id) => ul.querySelector(`li[data-row-key="${id}"]`);

describe("chat head patching", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("keeps the face, the portrait, the image and the ring circle across a ring colour change", () => {
    const ul = makeList();
    reconcileList(ul, [{ key: "a", html: head("a", "working") }], true, HEAD_RECONCILE);
    vi.runAllTimers();
    const el = li(ul, "a");
    const face = el.querySelector(".chat-head-face");
    const img = el.querySelector("img");
    const circle = el.querySelector("circle");

    reconcileList(ul, [{ key: "a", html: head("a", "question") }], true, HEAD_RECONCILE);
    vi.runAllTimers();

    expect(li(ul, "a")).toBe(el);
    expect(el.querySelector(".chat-head-face")).toBe(face);
    expect(el.querySelector("img")).toBe(img);
    expect(el.querySelector("circle")).toBe(circle);
    expect(circle.getAttribute("data-tone")).toBe("question");
  });

  it("touches nothing when only the ring's animation phase differs", () => {
    const ul = makeList();
    const mutations = [];
    reconcileList(ul, [{ key: "a", html: head("a", "working") }], true, HEAD_RECONCILE);
    vi.runAllTimers();
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(li(ul, "a"), { subtree: true, attributes: true, childList: true, characterData: true });
    const next = head("a", "working").replace("animation-delay:-10ms", "animation-delay:-777ms");
    reconcileList(ul, [{ key: "a", html: next }], true, HEAD_RECONCILE);
    vi.runAllTimers();
    expect(mo.takeRecords().length + mutations.length).toBe(0);
  });

  it("re-appends no head that is already in place", () => {
    const ul = makeList();
    const entries = (tone) => ["a", "b", "c"].map((id) => ({ key: id, html: head(id, tone) }));
    reconcileList(ul, entries("working"), true, HEAD_RECONCILE);
    vi.runAllTimers();
    const added = [];
    const mo = new MutationObserver(() => {});
    mo.observe(ul, { childList: true });
    reconcileList(ul, entries("question"), true, HEAD_RECONCILE);
    vi.runAllTimers();
    added.push(...mo.takeRecords().flatMap((r) => [...r.addedNodes]));
    mo.disconnect();
    expect(added).toEqual([]);
  });

  it("moving one head down re-attaches only that head", () => {
    const ul = makeList();
    const entries = (ids) => ids.map((id) => ({ key: id, html: head(id, "working") }));
    reconcileList(ul, entries(["a", "b", "c", "d", "e"]), true, HEAD_RECONCILE);
    vi.runAllTimers();
    const added = [];
    const mo = new MutationObserver(() => {});
    mo.observe(ul, { childList: true });
    reconcileList(ul, entries(["b", "c", "d", "a", "e"]), true, HEAD_RECONCILE);
    vi.runAllTimers();
    added.push(...mo.takeRecords().flatMap((r) => [...r.addedNodes].map((n) => n.dataset.rowKey)));
    mo.disconnect();
    expect([...ul.children].map((n) => n.dataset.rowKey)).toEqual(["b", "c", "d", "a", "e"]);
    expect(added).toEqual(["a"]);
  });

  it("moving one head up, and a new head in the middle, leave the order right", () => {
    const ul = makeList();
    const entries = (ids) => ids.map((id) => ({ key: id, html: head(id, "working") }));
    reconcileList(ul, entries(["a", "b", "c", "d"]), true, HEAD_RECONCILE);
    vi.runAllTimers();
    reconcileList(ul, entries(["d", "a", "x", "b", "c"]), true, HEAD_RECONCILE);
    expect([...ul.querySelectorAll("li:not(.row-exiting)")].map((n) => n.dataset.rowKey)).toEqual(["d", "a", "x", "b", "c"]);
  });

  it("adds a count in place and fades a removed count out before dropping it", () => {
    const ul = makeList();
    reconcileList(ul, [{ key: "a", html: head("a", "working") }], true, HEAD_RECONCILE);
    vi.runAllTimers();
    const face = li(ul, "a").querySelector(".chat-head-face");

    reconcileList(ul, [{ key: "a", html: head("a", "working", count(2)) }], true, HEAD_RECONCILE);
    expect(li(ul, "a").querySelector(".chat-head-face")).toBe(face);
    expect(face.querySelector(".chat-head-count")?.textContent).toBe("2");

    reconcileList(ul, [{ key: "a", html: head("a", "working") }], true, HEAD_RECONCILE);
    expect(face.querySelector(".chat-head-count")?.classList.contains("is-leaving")).toBe(true);
    vi.advanceTimersByTime(250);
    expect(face.querySelector(".chat-head-count")).toBeNull();
  });

  it("changes a count's number in place", () => {
    const ul = makeList();
    reconcileList(ul, [{ key: "a", html: head("a", "working", count(2)) }], true, HEAD_RECONCILE);
    vi.runAllTimers();
    const n = li(ul, "a").querySelector(".chat-head-count");
    reconcileList(ul, [{ key: "a", html: head("a", "working", count(3)) }], true, HEAD_RECONCILE);
    expect(li(ul, "a").querySelector(".chat-head-count")).toBe(n);
    expect(n.textContent).toBe("3");
  });

  it("falls back to the whole-row swap when there is no earlier markup", () => {
    const host = document.createElement("ul");
    host.innerHTML = head("a", "working");
    const kept = host.firstElementChild;
    const fresh = document.createElement("ul");
    fresh.innerHTML = head("a", "question");
    expect(patchHead(kept, fresh.firstElementChild, undefined)).toBe(false);
  });
});

describe("staggered open and close", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  const toggle = `<li class="chat-head chat-head-toggle" data-row-key="__toggle"><span class="chat-head-face"></span></li>`;
  const entry = (id) => ({ key: id, html: head(id, "working") });
  const all = [{ key: "__toggle", html: toggle }, entry("a"), entry("b"), entry("c")];

  it("a head that joins an open stack enters with a stagger delay and travels from the toggle", () => {
    const ul = makeList();
    reconcileList(ul, [all[0]], true, HEAD_RECONCILE);
    vi.runAllTimers();
    reconcileList(ul, all, true, HEAD_RECONCILE);
    const entering = [...ul.querySelectorAll("li.row-entering")];
    expect(entering.map((e) => e.dataset.rowKey)).toEqual(["a", "b", "c"]);
    const delays = entering.map((e) => parseFloat(e.style.getPropertyValue("--stagger-delay")));
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1] - delays[0]).toBeCloseTo(35, 0);
    for (const e of entering) expect(e.style.getPropertyValue("--travel-y")).not.toBe("");
  });

  it("the whole list arriving at once does not animate in", () => {
    const ul = makeList();
    reconcileList(ul, all, true, HEAD_RECONCILE);
    expect(ul.querySelectorAll("li.row-entering").length).toBe(0);
  });

  it("closing sends the last head out first, 20ms ahead of the one before", () => {
    const ul = makeList();
    reconcileList(ul, all, true, HEAD_RECONCILE);
    vi.runAllTimers();
    reconcileList(ul, [all[0]], true, HEAD_RECONCILE);
    const exiting = [...ul.querySelectorAll("li.row-exiting")];
    const byKey = Object.fromEntries(exiting.map((e) => [e.dataset.rowKey, parseFloat(e.style.animationDelay || e.style.getPropertyValue("--stagger-delay"))]));
    expect(Object.keys(byKey).sort()).toEqual(["a", "b", "c"]);
    expect(byKey.c).toBeLessThan(byKey.b);
    expect(byKey.b).toBeLessThan(byKey.a);
  });

  it("a child's animationend does not remove an exiting head", () => {
    const ul = makeList();
    reconcileList(ul, all, true, HEAD_RECONCILE);
    vi.runAllTimers();
    reconcileList(ul, [all[0]], true, HEAD_RECONCILE);
    const a = ul.querySelector('li.row-exiting[data-row-key="a"]');
    a.querySelector(".chat-head-face").dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(a.isConnected).toBe(true);
    a.dispatchEvent(new Event("animationend"));
    expect(a.isConnected).toBe(false);
  });
});
