// @vitest-environment jsdom
// jsdom: main-chat reads the mode gate, which imports the IPC layer.

import { describe, it, expect } from "vitest";
import { mainChatInfo } from "../src/views/sessions/main-chat.ts";
import { newestFinishedFirst, subListHtml, subInitials } from "../src/views/sessions/sub-list.ts";
import { closeWaitChipHtml, CLOSES_WHEN_SUBS_FINISH } from "../src/views/sessions/sidebar-row-visuals.ts";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const main = (over = {}) => inst({ session_id: "main", name: "CV redesign", ...over });
const sub = (id, over = {}) => inst({ session_id: id, name: id, subchat_of: "main", busy: true, ...over });
const done = (id, over = {}) => sub(id, { busy: false, subchat_finished: true, awaiting: "done", ...over });

describe("a main chat waiting for its subs to close", () => {
  it("is flagged when the daemon marks it closing while a sub still runs", () => {
    const info = mainChatInfo(main({ closing: true }), [main({ closing: true }), sub("a")]);
    expect(info.closesWhenSubsFinish).toBe(true);
    expect(info.hoverRows[0]).toMatchObject({ name: "This chat", progress: "closing when subs finish" });
  });

  it("is not flagged without a running sub (a plain close), nor without closing", () => {
    expect(mainChatInfo(main({ closing: true }), [main({ closing: true }), done("a")]).closesWhenSubsFinish).toBe(false);
    expect(mainChatInfo(main(), [main(), sub("a")]).closesWhenSubsFinish).toBe(false);
  });

  it("draws a quiet mark with the sentence only while waiting", () => {
    expect(closeWaitChipHtml(false, "title")).toBe("");
    expect(closeWaitChipHtml(undefined, "title")).toBe("");
    const html = closeWaitChipHtml(true, "data-tip");
    expect(html).toContain("session-close-wait");
    expect(html).toContain(CLOSES_WHEN_SUBS_FINISH);
    expect(CLOSES_WHEN_SUBS_FINISH).toContain("Close it again");
  });
});

describe("the sub list's Finished order", () => {
  const rows = ["a", "b", "c", "d"].map((id) => ({ id, name: id, kind: "finished", progress: "finished", tier: "", closing: false }));
  const byId = new Map([
    ["a", done("a")], ["b", done("b")],
    ["c", done("c", { progress: { plan: null, state_since: "2026-11-05T12:00:00Z" } })],
    ["d", done("d")],
  ]);

  it("puts the latest finish card first", () => {
    const order = newestFinishedFirst(rows, byId, new Map([["a", 100], ["b", 300], ["c", 200], ["d", 50]])).map((r) => r.id);
    expect(order).toEqual(["b", "c", "a", "d"]);
  });

  it("falls back to the last busy/idle flip, then keeps newer-started rows ahead of undated ones", () => {
    const order = newestFinishedFirst(rows, byId, new Map([["a", 1000]])).map((r) => r.id);
    // a has a card; c only a flip (2026 in ms is far above 1000); b and d have nothing and keep the later row first.
    expect(order).toEqual(["c", "a", "d", "b"]);
  });

  it("renders Finished in that order and the waiting note at the top", () => {
    const html = subListHtml(rows, [...byId.values()], true, new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]), true, 5);
    expect(html.indexOf("sub-list-note")).toBeLessThan(html.indexOf("Finished"));
    const ids = [...html.matchAll(/data-sub-id="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["d", "c", "b", "a"]);
  });
});

describe("a sub's initials", () => {
  it("are the first letters of the first two words", () => {
    expect(subInitials("Footer links")).toBe("FL");
    expect(subInitials("Header")).toBe("HE");
  });
});
