/**
 * Todo 898: Joe leaves a note on a still-pending write_plan step from the
 * turn-footer checklist; the daemon holds it and hands it back to the
 * session the moment that step goes active (see
 * src-tauri/src/daemon/hooks_server/plan.rs's own tests for the delivery
 * half). This file covers the FRONTEND half: the comment affordance only
 * appears on a write_plan-sourced row (never TodoWrite's), submitting it
 * calls the `add_step_comment` daemon RPC, and a comment survives the row
 * being torn down (once the step activates) and the checklist settling
 * (once the turn ends) - the "not silently lost" acceptance bar.
 *
 * Drives the real ChatRenderer via JSDOM, same harness shape as
 * tests/turn-chips.test.mjs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";

function setupDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
  });
  const { window } = dom;
  const { document } = window;

  window.__TAURI__ = {
    core: {
      invoke: vi.fn(async () => null),
      convertFileSrc: (s) => s,
    },
    event: {
      listen: async () => () => {},
      emit: async () => {},
    },
  };

  return { dom, window, document };
}

function makeUserMessage(content = "Hello", tsMs = 0) {
  return {
    type: "user_message",
    content: [{ type: "text", text: content }],
    timestamp: BigInt(tsMs),
  };
}

function makeWritePlanToolUse(steps, id = "wp1", tsMs = 0) {
  return {
    type: "tool_use",
    tool_name: "mcp__cc_conductor__write_plan",
    input: { steps },
    id,
    timestamp: BigInt(tsMs),
    parent_tool_use_id: null,
  };
}

function makeTodoWriteToolUse(todos, id = "tw1", tsMs = 0) {
  return {
    type: "tool_use",
    tool_name: "TodoWrite",
    input: { todos },
    id,
    timestamp: BigInt(tsMs),
    parent_tool_use_id: null,
  };
}

describe("write_plan step comments (todo 898)", () => {
  let dom;
  let document;
  let window;

  beforeEach(() => {
    const setup = setupDom();
    dom = setup.dom;
    document = setup.document;
    window = setup.window;
    global.document = document;
    global.window = window;
    global.HTMLElement = window.HTMLElement;
    global.Node = window.Node;
    global.MutationObserver = window.MutationObserver || class {
      observe() {}
      disconnect() {}
    };
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    dom.window.close();
  });

  async function createRenderer(sessionId = "s1") {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const renderer = new ChatRenderer(container);
    renderer.sessionId = sessionId;
    return { renderer, container };
  }

  it("gives a pending write_plan step a comment affordance, absent from a TodoWrite step", async () => {
    const { renderer: wpRenderer, container: wpContainer } = await createRenderer();
    wpRenderer.handleEvent(makeUserMessage("Do the thing"));
    wpRenderer.handleEvent(makeWritePlanToolUse([
      { text: "Read the spec", status: "pending" },
      { text: "Wire the feed", status: "pending" },
    ]));
    expect(wpContainer.querySelectorAll(".todo-step-comment-btn").length).toBe(2);

    const { renderer: twRenderer, container: twContainer } = await createRenderer("s2");
    twRenderer.handleEvent(makeUserMessage("Do the thing"));
    twRenderer.handleEvent(makeTodoWriteToolUse([
      { content: "Read the spec", status: "pending" },
      { content: "Wire the feed", status: "pending" },
    ]));
    expect(twContainer.querySelectorAll(".todo-step-comment-btn").length).toBe(0);
  });

  it("submitting a note opens the editor, calls add_step_comment, and marks the row noted", async () => {
    const { renderer, container } = await createRenderer("s1");
    renderer.handleEvent(makeUserMessage("Do the thing"));
    renderer.handleEvent(makeWritePlanToolUse([
      { text: "Read the spec", status: "pending" },
    ]));

    const btn = container.querySelector(".todo-step-comment-btn");
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const textarea = container.querySelector(".todo-step-comment-textarea");
    expect(textarea).toBeTruthy();
    textarea.value = "skip this one";
    const send = container.querySelector(".todo-step-comment-send");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // Editor closes, row shows the noted indicator.
    expect(container.querySelector(".todo-step-comment-textarea")).toBeNull();
    expect(container.querySelector(".todo-step-comment-btn--noted")).toBeTruthy();
    expect(container.querySelector(".todo-step-comment-btn--noted").title).toBe("skip this one");

    expect(window.__TAURI__.core.invoke).toHaveBeenCalledWith(
      "add_step_comment",
      { sessionId: "s1", stepText: "Read the spec", comment: "skip this one" },
    );
  });

  it("submitting an empty box cancels instead of queuing a blank note", async () => {
    const { renderer, container } = await createRenderer("s1");
    renderer.handleEvent(makeUserMessage("Do the thing"));
    renderer.handleEvent(makeWritePlanToolUse([{ text: "Read the spec", status: "pending" }]));

    container.querySelector(".todo-step-comment-btn")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    container.querySelector(".todo-step-comment-textarea").value = "   ";
    container.querySelector(".todo-step-comment-send")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(container.querySelector(".todo-step-comment-textarea")).toBeNull();
    expect(container.querySelector(".todo-step-comment-btn--noted")).toBeNull();
    expect(window.__TAURI__.core.invoke).not.toHaveBeenCalledWith(
      "add_step_comment",
      expect.anything(),
    );
  });

  it("a step that goes active with no comment ever queued loses the affordance outright", async () => {
    const { renderer, container } = await createRenderer("s1");
    renderer.handleEvent(makeUserMessage("Do the thing"));
    renderer.handleEvent(makeWritePlanToolUse([{ text: "Read the spec", status: "pending" }], "wp1", 1));
    expect(container.querySelectorAll(".todo-step-comment-btn").length).toBe(1);

    renderer.handleEvent(makeWritePlanToolUse([{ text: "Read the spec", status: "active" }], "wp2", 2));
    expect(container.querySelectorAll(".todo-step-comment-btn").length).toBe(0);
  });

  it("a noted comment survives its step going active - the affordance stays, no longer clickable", async () => {
    const { renderer, container } = await createRenderer("s1");
    renderer.handleEvent(makeUserMessage("Do the thing"));
    renderer.handleEvent(makeWritePlanToolUse([{ text: "Read the spec", status: "pending" }], "wp1", 1));
    container.querySelector(".todo-step-comment-btn")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    container.querySelector(".todo-step-comment-textarea").value = "skip this one";
    container.querySelector(".todo-step-comment-send")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    renderer.handleEvent(makeWritePlanToolUse([{ text: "Read the spec", status: "active" }], "wp2", 2));

    const noted = container.querySelector(".todo-step-comment-btn--noted");
    expect(noted).toBeTruthy();
    expect(noted.title).toBe("skip this one");

    // No longer pending, so re-clicking must not reopen the editor.
    noted.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(container.querySelector(".todo-step-comment-textarea")).toBeNull();
  });

  it("a comment left on a step that never activates survives the checklist settling into a chip", async () => {
    const { renderer, container } = await createRenderer("s1");
    renderer.handleEvent(makeUserMessage("Do the thing"));
    renderer.handleEvent(makeWritePlanToolUse([
      { text: "Read the spec", status: "active" },
      { text: "Never gets here", status: "pending" },
    ], "wp1", 1));

    // Only the still-pending second step gets an affordance - the first is
    // already active.
    expect(container.querySelectorAll(".todo-step-comment-btn").length).toBe(1);
    container.querySelector(".todo-step-comment-btn")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    container.querySelector(".todo-step-comment-textarea").value = "do we need this?";
    container.querySelector(".todo-step-comment-send")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // End the turn without ever activating the second step.
    renderer.handleEvent({
      type: "turn_usage",
      input_tokens: 10n, output_tokens: 10n, cache_creation_input_tokens: 0n,
      cache_read_input_tokens: 0n, total_cost_usd: 0, duration_ms: 1000n,
      has_thinking: false, model: "claude-sonnet-4-6", awaiting: null,
    });

    expect(container.querySelector(".todo-checklist-collapsed")).toBeTruthy();
    const noted = container.querySelector(".todo-checklist-comment-noted");
    expect(noted).toBeTruthy();
    expect(noted.title).toBe("do we need this?");
  });
});
