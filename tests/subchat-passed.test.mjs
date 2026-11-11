// @vitest-environment jsdom
// asserts: src/shared/chat/chat-subchat-passed.ts, src/shared/chat/chat-event-handler-tools.ts, src/shared/chat/chat-event-to-message.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/chat-transforms.ts

// "Passed to X": the quiet row where a main chat's agent sent Joe's message on
// to a sub. It comes from the `subchat` tool_use in the main chat's transcript,
// so it has to come out the same by every path a row can arrive by: the load, an
// older page, and the live frame. The real CSS and the phone width are driven by
// e2e/view-harness/subchat-passed.view.spec.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { applyPassedResult, isSubchatSend, passedRowFromToolUse, renderPassedRow } = await import("../src/shared/chat/chat-subchat-passed.ts");

const SUBCHAT = "mcp__cc_conductor__subchat";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let pages;
beforeEach(() => {
  invokeMock.mockReset();
  pages = [];
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "load_history_page") {
      const page = args?.beforeSeq !== undefined ? pages[1] : pages[0];
      return Promise.resolve(page ?? { events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
    }
    if (cmd === "list_subchat_cards") return Promise.resolve([]);
    if (cmd === "list_channel_messages") return Promise.resolve({ messages: [] });
    if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  document.body.innerHTML = "";
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.window.__TAURI__ = makeBus();
});

const call = (id, ts, input) => toolUseEvent(SUBCHAT, input, id, ts);
const result = (id, body, isError = false) => ({
  type: "tool_result", tool_use_id: id, output: { type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }, is_error: isError, timestamp: 0,
});
const page = (events, hasMore = false) => ({ events, oldest_seq: 1, newest_seq: events.length, has_more: hasMore });

let seq = 0;
async function open() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(`sess-passed-${++seq}`);
  await r.loadFromStore();
  return { r, container };
}
const rows = (container) => [...container.querySelectorAll(".msg.passed-row")].map((el) => el.textContent.trim());

describe("which calls draw a row", () => {
  it("only a send does, and never one made by a subagent", () => {
    expect(isSubchatSend(SUBCHAT, { action: "send", sub: "x" })).toBe(true);
    for (const action of ["list", "status", "log"]) expect(isSubchatSend(SUBCHAT, { action })).toBe(false);
    expect(isSubchatSend("mcp__cc_conductor__send_message", { action: "send" })).toBe(false);
    expect(isSubchatSend(SUBCHAT, { action: "send" }, "agent-1")).toBe(false);
    expect(isSubchatSend(SUBCHAT, null)).toBe(false);
  });
});

describe("the row's words", () => {
  it("names the sub the daemon says got it, not the prefix the agent typed", () => {
    const row = passedRowFromToolUse("p1", { action: "send", sub: "head" }, T0);
    expect(renderPassedRow(row)).toContain("Passed to <b>head</b>");
    const done = applyPassedResult(row, { type: "text", text: JSON.stringify({ ok: true, passed_to: ["Header"] }) }, false);
    expect(renderPassedRow(done)).toContain("Passed to <b>Header</b>");
  });

  it("keeps a follow-up's question and, once the daemon answers, the ids of the subs it reached", () => {
    const row = passedRowFromToolUse("p1", { action: "send", sub: "ime", question: "  Is it the same\n on desktop? " }, T0);
    expect(row.passedQuestion).toBe("Is it the same on desktop?");
    expect(row.passedSubIds).toBeUndefined();
    const done = applyPassedResult(row, { type: "text", text: JSON.stringify({ ok: true, passed_to: ["phone-ime"], sub_ids: ["sub-1"] }) }, false);
    expect(done.passedSubIds).toEqual(["sub-1"]);
    expect(done.passedQuestion).toBe("Is it the same on desktop?");
    expect(passedRowFromToolUse("p2", { action: "send", sub: "ime" }, T0).passedQuestion).toBeUndefined();
  });

  it("a send to all says all running subs", () => {
    const row = passedRowFromToolUse("p1", { action: "send", all: true }, T0);
    const done = applyPassedResult(row, { type: "text", text: JSON.stringify({ ok: true, passed_to: ["A", "B"] }) }, false);
    expect(renderPassedRow(done)).toContain("Passed to all running subs");
  });

  it("a refusal, an unreadable answer and an ok:false are not shown as passed", () => {
    const row = passedRowFromToolUse("p1", { action: "send", sub: "Foo" }, T0);
    for (const [out, err] of [[{ type: "text", text: "ambiguous" }, true], [{ type: "text", text: "not json" }, false], [{ type: "text", text: JSON.stringify({ ok: false }) }, false]]) {
      const html = renderPassedRow(applyPassedResult(row, out, err));
      expect(html).toContain("Could not pass to");
      expect(html).toContain("passed-row--failed");
    }
  });

  it("escapes a name that carries markup", () => {
    const row = passedRowFromToolUse("p1", { action: "send", sub: "<img src=x onerror=alert(1)>" }, T0);
    expect(renderPassedRow(row)).not.toContain("<img");
  });
});

describe("through the renderer", () => {
  it("a load draws one row for a send, none for a list, and absorbs both results", async () => {
    pages = [page([
      userEvent("do the same for signup", T0),
      call("p1", T0 + MIN, { action: "send", sub: "head" }),
      result("p1", { ok: true, passed_to: ["Header"] }),
      call("l1", T0 + 2 * MIN, { action: "list" }),
      result("l1", { ok: true, subs: [] }),
    ])];
    const { container } = await open();
    expect(rows(container)).toEqual(["Passed to Header"]);
    // The send's result is folded into its row; the list's stays a tool row.
    expect(container.querySelectorAll(".msg.tool_result, .msg.chat-narration").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).not.toContain("\"passed_to\"");
  });

  it("a refused send draws 'Could not pass to'", async () => {
    pages = [page([userEvent("go", T0), call("p1", T0 + MIN, { action: "send", sub: "Foo" }), result("p1", "Foo matches more than one sub", true)])];
    const { container } = await open();
    expect(rows(container)).toEqual(["Could not pass to Foo"]);
  });

  it("an older page draws its row before the newer one, in order", async () => {
    pages = [
      page([userEvent("late", T0 + 30 * MIN), call("p2", T0 + 31 * MIN, { action: "send", sub: "Footer" }), result("p2", { ok: true, passed_to: ["Footer"] })], true),
      page([userEvent("early", T0), call("p1", T0 + MIN, { action: "send", sub: "Header" }), result("p1", { ok: true, passed_to: ["Header"] })]),
    ];
    const { r, container } = await open();
    expect(rows(container)).toEqual(["Passed to Footer"]);
    await r.fetchOlder();
    expect(rows(container)).toEqual(["Passed to Header", "Passed to Footer"]);
    expect(container.textContent).not.toContain("\"passed_to\"");
  });

  it("a send that arrives live gets its row and then its resolved name", async () => {
    pages = [page([userEvent("go", T0)])];
    const { r, container } = await open();
    r.handleEvent(call("p9", T0 + MIN, { action: "send", sub: "foot" }));
    expect(rows(container)).toEqual(["Passed to foot"]);
    r.handleEvent(result("p9", { ok: true, passed_to: ["Footer"] }));
    expect(rows(container)).toEqual(["Passed to Footer"]);
  });
});
