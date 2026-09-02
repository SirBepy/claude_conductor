// Replaying a still-open turn must rebuild the SAME chip strip the live path
// built. A meta tick (wake, task-notification, auq-answer) keeps the footer but
// moves activeTurnStart past everything before it, so a replay - a switch back
// that missed the pane cache, a resync - came back with only post-tick calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

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

function use(tool, input, id) {
  return { type: "tool_use", tool_name: tool, input, id, timestamp: 1, parent_tool_use_id: null };
}
function result(id) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: 1 };
}
function metaTick() {
  return { type: "user_message", content: [{ type: "text", text: "[schedule] tick" }], timestamp: 1, is_meta: true };
}

/** One open turn: two Bash + two Read calls, split by a meta tick. */
function transcript() {
  return [
    { type: "user_message", content: [{ type: "text", text: "go" }], timestamp: 1 },
    use("Bash", { command: "ls" }, "b1"), result("b1"),
    use("Read", { file_path: "/a/x.ts" }, "r1"), result("r1"),
    metaTick(),
    use("Bash", { command: "pwd" }, "b2"), result("b2"),
    use("Read", { file_path: "/a/y.ts" }, "r2"), result("r2"),
  ];
}

async function replay(sessionId, events) {
  invokeMock.mockResolvedValue({ events, oldest_seq: 1, newest_seq: events.length, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sessionId);
  await r.loadFromStore(undefined, { resumeLiveTicking: true });
  return { r, container };
}

function chipCounts(container) {
  return [...container.querySelectorAll(".turn-footer > .tool-strip > .tool-chip")]
    .map((c) => `${c.dataset.tool}:${c.dataset.count}`);
}

describe("replaying an open turn that contains a meta tick", () => {
  it("keeps every call in the strip, not just the ones after the tick", async () => {
    const { r, container } = await replay("s-tick", transcript());
    expect(container.querySelectorAll(".turn-footer").length).toBe(1);
    expect(chipCounts(container)).toEqual(["Bash:2", "Read:2"]);
    const paths = [...container.querySelectorAll(".tool-file-row")].map((e) => e.dataset.path);
    expect(paths).toEqual(["/a/x.ts", "/a/y.ts"]);
    r.detach();
  });

  it("matches the tick-free replay of the same calls", async () => {
    const withTick = await replay("s-a", transcript());
    const without = await replay("s-b", transcript().filter((e) => !e.is_meta));
    expect(chipCounts(withTick.container)).toEqual(chipCounts(without.container));
    withTick.r.detach();
    without.r.detach();
  });
});
