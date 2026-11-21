// The opened sub view's Attachments tab (src/shared/chat/dashboard/peek-attachments.ts): what its
// four tabs hold for one sub, read from the newest page of its history, the daemon's image list
// and the family's preview list.

import { describe, it, expect } from "vitest";

const { peekRows, peekImages, peekPreviews, peekLinksState, attachTotal } = await import("../src/shared/chat/dashboard/peek-attachments.ts");

const SEND = "mcp__cc_conductor__send_message";
let n = 0;
const send = (text, over = {}) => ({ type: "tool_use", tool_name: SEND, input: { kind: "report", verdict: "Done", text, ...over }, id: `t${++n}`, timestamp: 0, parent_tool_use_id: null });
const edit = (file_path) => ({ type: "tool_use", tool_name: "Edit", input: { file_path }, id: `t${++n}`, timestamp: 0, parent_tool_use_id: null });
const preview = (id, owner) => ({ id, slug: id, title: id, source: "chat_card", session_id: owner, version: 1, created_at: null, published: null, versions: [] });

describe("peekRows", () => {
  it("turns history events into the rows the link and file readers scan, dropping what draws nothing", () => {
    const rows = peekRows([send("done"), { type: "something_new" }, edit("C:/p/a.ts")]);
    expect(rows.map((r) => r.kind)).toEqual(["message", "tool_use"]);
  });
});

describe("peekImages", () => {
  it("lists the newest first, each keeping its place in the daemon's list (oldest first)", () => {
    const rows = peekImages([{ id: "a" }, { id: "b", at_ms: 0 }, { id: "c" }]);
    expect(rows.map((r) => r.index)).toEqual([2, 1, 0]);
    expect(rows.map((r) => r.title)).toEqual(["Image 3", "Image 2", "Image 1"]);
  });

  it("a picture with no time has no label, one with a time has one", () => {
    const [timed, bare] = peekImages([{ id: "a" }, { id: "b", at_ms: Date.now() }]);
    expect(timed.label).not.toBe("");
    expect(bare.label).toBe("");
  });
});

describe("peekPreviews", () => {
  it("keeps only the previews this sub pushed, in the order given", () => {
    const list = [preview("p1", "sub-a"), preview("p2", "main"), preview("p3", "sub-a")];
    expect(peekPreviews(list, "sub-a").map((m) => m.id)).toEqual(["p1", "p3"]);
  });
});

describe("peekLinksState", () => {
  const events = [send("Opened https://github.com/o/r/pull/12 and touched C:/p/src/footer.ts"), edit("C:/p/src/footer.ts")];

  it("reads links and files off the sub's history, previews and images off the lists", () => {
    const s = peekLinksState(events, [{ id: "i1" }, { id: "i2" }], [preview("p1", "sub-a"), preview("px", "other")], "sub-a");
    expect(s.links.map((l) => l.kind)).toEqual(["pr"]);
    expect(s.files).toEqual([{ path: "C:/p/src/footer.ts", touched: true }]);
    expect(s.previews?.own.map((m) => m.id)).toEqual(["p1"]);
    expect(s.previews?.otherCount).toBe(0);
    expect(s.images).toHaveLength(2);
    expect(s.tabs).toEqual(["previews", "images", "files", "links"]);
    expect(attachTotal(s)).toBe(1 + 1 + 1 + 2);
  });

  it("a sub with nothing reads as empty tabs that all stay, never as no card", () => {
    const s = peekLinksState([], [], [], "sub-a");
    expect(s.previews).toBeNull();
    expect(s.tabs).toHaveLength(4);
    expect(attachTotal(s)).toBe(0);
  });
});
