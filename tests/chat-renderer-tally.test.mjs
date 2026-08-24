// Tests for the by-type tool tally on ChatRenderer: counts every tool_use once,
// dedups by tool_use id, and splits image vs file targets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

/** byType mapped to {tool,count} only, for terse order/count assertions. */
function counts(tally) {
  return tally.byType.map((b) => ({ tool: b.tool, count: b.count }));
}

describe("ChatRenderer — tool tally", () => {
  it("counts by type in first-seen order with repeat counts", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "t1"), { silent: true });
    r.handleEvent(toolUseEvent("Bash", { command: "ls" }, "t2"), { silent: true });
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/y.ts" }, "t3"), { silent: true });

    expect(counts(r.toolTally)).toEqual([
      { tool: "Read", count: 2 },
      { tool: "Bash", count: 1 },
    ]);
  });

  it("records distinct per-tool targets with repeat counts", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "t1"), { silent: true });
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "t2"), { silent: true });
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/y.ts" }, "t3"), { silent: true });

    const read = r.toolTally.byType.find((b) => b.tool === "Read");
    expect(read.count).toBe(3);
    expect(read.items).toEqual([
      { label: "x.ts", kind: "file", path: "/a/x.ts", filename: undefined, count: 2 },
      { label: "y.ts", kind: "file", path: "/a/y.ts", filename: undefined, count: 1 },
    ]);
  });

  it("de-dupes by tool_use id (re-delivery cannot double-count)", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "dup"), { silent: true });
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "dup"), { silent: true });

    const read = r.toolTally.byType.find((b) => b.tool === "Read");
    expect(read.count).toBe(1);
    expect(read.items.map((i) => i.count)).toEqual([1]);
  });

  it("classifies image vs file targets and records Grep patterns as text", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.png" }, "t1"), { silent: true });
    r.handleEvent(toolUseEvent("Grep", { pattern: "foo.*bar" }, "t2"), { silent: true });

    const read = r.toolTally.byType.find((b) => b.tool === "Read");
    expect(read.items).toEqual([
      { label: "x.png", kind: "image", path: "/a/x.png", filename: "x.png", count: 1 },
    ]);
    const grep = r.toolTally.byType.find((b) => b.tool === "Grep");
    expect(grep.items).toEqual([
      { label: "foo.*bar", kind: "text", path: undefined, filename: undefined, count: 1 },
    ]);
  });

  it("fires onToolTally with a cloned snapshot after each tool_use", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onToolTally = (t) => seen.push(t);
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "t1"), { silent: true });
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/y.ts" }, "t2"), { silent: true });

    expect(seen.length).toBe(2);
    // Snapshots are clones: the first must not have mutated to count 2.
    expect(counts(seen[0])).toEqual([{ tool: "Read", count: 1 }]);
    expect(counts(seen[1])).toEqual([{ tool: "Read", count: 2 }]);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
