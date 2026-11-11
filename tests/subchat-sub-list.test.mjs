// @vitest-environment jsdom
// The sub list's data and the pieces of reading a sub in place that have no DOM of
// their own: row markup, the ring each status gets, which window a sub belongs to,
// and the phone transport case for "Move to sidebar".

import { describe, it, expect, beforeEach, vi } from "vitest";
import { subInitials, subRingSpec, subListHtml } from "../src/views/sessions/sub-list.ts";
import { subMetaText } from "../src/views/sessions/subchat-view.ts";
import { mainChatInfo } from "../src/views/sessions/main-chat.ts";
import { state, windowIdOf } from "../src/views/sessions/state.ts";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const main = inst({ session_id: "main", name: "CV redesign" });
const sub = (id, over = {}) => inst({ session_id: id, name: id, subchat_of: "main", busy: true, ...over });

describe("sub list rows", () => {
  it("takes up to two letters from a name for the avatar stand-in", () => {
    expect(subInitials("Fix login test")).toBe("FL");
    expect(subInitials("Footer")).toBe("FO");
    expect(subInitials("  ")).toBe("?");
  });

  it("gives each status the ring the sidebar already uses for it", () => {
    const plan = [{ text: "a", status: "done" }, { text: "b", status: "active" }, { text: "c", status: "pending" }];
    expect(subRingSpec({ id: "x", name: "x", kind: "asking", progress: "" }, undefined)).toMatchObject({ kind: "solid", tone: "question", pulse: true });
    expect(subRingSpec({ id: "x", name: "x", kind: "finished", progress: "" }, sub("x"))).toEqual({ kind: "solid", tone: "done" });
    expect(subRingSpec({ id: "x", name: "x", kind: "finished", progress: "" }, sub("x", { closing: true }))).toEqual({ kind: "solid", tone: "closing" });
    expect(subRingSpec({ id: "x", name: "x", kind: "working", progress: "" }, sub("x", { progress: { plan, state_since: null } }))).toEqual({ kind: "plan", done: 1, total: 3 });
    expect(subRingSpec({ id: "x", name: "x", kind: "working", progress: "" }, sub("x"))).toMatchObject({ kind: "solid", tone: "working", glow: true });
  });

  it("draws a queued sub as a plain working-yellow ring with no glow, no arc and no window button", () => {
    const held = sub("Footer", { busy: false, progress: { plan: null, state_since: null, waiting_for: "waiting for Header" } });
    const spec = subRingSpec({ id: "Footer", name: "Footer", kind: "queued", progress: "waiting for Header" }, held);
    expect(spec).toEqual({ kind: "solid", tone: "working" });
    const all = [main, held];
    const html = subListHtml(mainChatInfo(main, all).subs, all);
    expect(html).toContain('data-kind="queued"');
    expect(html).toContain("waiting for Header");
    // A queued sub has no claude process: it sits under Queued, never under Running.
    expect(html).toContain('<h5 class="sub-list-head">Queued</h5>');
    expect(html).not.toContain('<h5 class="sub-list-head">Running</h5>');
    expect(html).not.toContain("data-popout");
  });

  it("names the tier on the row and in the in-place header, and a window button only where a window can open", () => {
    const tiered = sub("a", { busy: false, model: "claude-sonnet-4-5", effort: "medium" });
    const all = [main, tiered];
    const subs = mainChatInfo(main, all).subs;
    expect(subListHtml(subs, all)).toContain('<span class="sub-tier">Sonnet medium</span>');
    expect(subMetaText(tiered, main)).toBe("Subchat of CV redesign, Sonnet medium");
    expect(subListHtml(subs, all)).toContain('data-popout title="Open in new window"');
    expect(subListHtml(subs, all)).not.toContain("data-move");
    // The phone has no second window, so no button.
    expect(subListHtml(subs, all, false)).not.toContain("data-popout");
    expect(subListHtml(subs, all, false)).toContain('data-sub-id="a"');
  });

  it("says in the in-place header that a sub is waiting, and for what", () => {
    const held = sub("a", { busy: false, progress: { plan: null, state_since: null, waiting_for: "waiting for Header" } });
    expect(subMetaText(held, main)).toBe("Subchat of CV redesign, waiting for Header");
  });

  it("groups running above finished and escapes the name", () => {
    const all = [main, sub("<b>Footer</b>"), sub("Header", { subchat_finished: true, busy: false, progress: { plan: null, state_since: new Date().toISOString() } })];
    const html = subListHtml(mainChatInfo(main, all).subs, all);
    expect(html.indexOf("Running")).toBeLessThan(html.indexOf("Finished"));
    expect(html).not.toContain("<b>Footer</b>");
    expect(html).toContain("&lt;b&gt;Footer&lt;/b&gt;");
    expect(html).toContain('data-kind="finished"');
  });

  describe("finished subs past the dashboard card's hour", () => {
    const NOW = Date.parse("2026-11-11T12:00:00Z");
    const at = (minutesAgo) => ({ progress: { plan: null, state_since: new Date(NOW - minutesAgo * 60_000).toISOString() } });
    const all = [
      main, sub("Run1"),
      sub("Fresh", { busy: false, subchat_finished: true, ...at(10) }),
      sub("Old1", { busy: false, subchat_finished: true, ...at(120) }),
      sub("Old2", { busy: false, subchat_finished: true, ...at(300) }),
      sub("Undated", { busy: false, subchat_finished: true }),
    ];
    const ids = (html) => [...html.matchAll(/data-sub-id="(\w+)"/g)].map((m) => m[1]);
    const subs = mainChatInfo(main, all).subs;

    it("keeps the recent ones and folds the rest behind one +N earlier row", () => {
      const html = subListHtml(subs, all, true, new Map(), false, NOW);
      expect(ids(html)).toEqual(["Run1", "Fresh"]);
      expect(html).toContain("+3 earlier");
      expect(html).toContain('aria-expanded="false"');
    });

    it("lists the folded ones, newest first, once the row is expanded", () => {
      const html = subListHtml(subs, all, true, new Map(), false, NOW, true);
      expect(ids(html)).toEqual(["Run1", "Fresh", "Old1", "Old2", "Undated"]);
      expect(html).toContain("Hide earlier");
    });

    it("never folds a running, queued or asking sub, nor a finish card inside the hour", () => {
      const cards = new Map([["Old1", NOW - 5 * 60_000]]);
      expect(ids(subListHtml(subs, all, true, cards, false, NOW))).toEqual(["Run1", "Old1", "Fresh"]);
      const held = sub("Held", { busy: false, ...at(500), progress: { plan: null, state_since: new Date(NOW - 500 * 60_000).toISOString(), waiting_for: "waiting for Run1" } });
      const mixed = [main, held];
      expect(ids(subListHtml(mainChatInfo(main, mixed).subs, mixed, true, new Map(), false, NOW))).toEqual(["Held"]);
    });

    it("draws no +N earlier row when nothing is folded", () => {
      const few = [main, sub("Fresh", { busy: false, subchat_finished: true, ...at(10) })];
      expect(subListHtml(mainChatInfo(main, few).subs, few, true, new Map(), false, NOW)).not.toContain("earlier");
    });
  });

  it("draws no heading for an empty group", () => {
    const all = [main, sub("Footer")];
    const html = subListHtml(mainChatInfo(main, all).subs, all);
    expect(html).toContain("Running");
    expect(html).not.toContain("Finished");
  });

  it("says whose sub it is and whether it can continue", () => {
    expect(subMetaText(sub("a"), main)).toBe("Subchat of CV redesign");
    expect(subMetaText(sub("a", { subchat_finished: true }), main)).toBe("Subchat of CV redesign, finished, can continue");
    expect(subMetaText(sub("a", { closing: true }), main)).toBe("Subchat of CV redesign, closing");
    expect(subMetaText(sub("a"), undefined)).toBe("Subchat of its main chat");
  });
});

describe("windowIdOf", () => {
  beforeEach(() => { state.sessions = [main, sub("sub-a"), inst({ session_id: "plain" }), sub("orphan", { subchat_of: "gone" })]; });

  it("reads a sub in its main chat's window and any other chat in its own", () => {
    expect(windowIdOf("sub-a")).toBe("main");
    expect(windowIdOf("main")).toBe("main");
    expect(windowIdOf("plain")).toBe("plain");
  });

  it("keeps a sub whose main chat is not listed as itself, so it is never an unreachable id", () => {
    expect(windowIdOf("orphan")).toBe("orphan");
    expect(windowIdOf("unknown")).toBe("unknown");
    expect(windowIdOf(null)).toBeNull();
  });
});

describe("HttpTransport - move_sub_to_sidebar", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = fetchMock;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  });

  it("reaches the daemon RPC with snake_case params instead of throwing as unavailable", async () => {
    const { HttpTransport } = await import("../src/shared/http-transport.ts");
    await new HttpTransport().call("move_sub_to_sidebar", { sessionId: "sub-a" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: "move_sub_to_sidebar",
      params: { session_id: "sub-a" },
    });
  });
});
