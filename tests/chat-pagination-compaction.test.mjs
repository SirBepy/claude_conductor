// @vitest-environment jsdom
// ai_todo 742: a compaction opening the oldest turn on a scrolled-back page
// must fold like a real user message - it goes through eventToRenderedMessage,
// which used to disagree with the live-push path on turn-boundary status.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
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

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function toolResultEvent(id, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: ts };
}

function turnUsageEvent({ outputTokens = 0, durationMs = 0 } = {}) {
  return {
    type: "turn_usage",
    input_tokens: 100,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    duration_ms: durationMs,
    has_thinking: false,
    model: "m",
  };
}

// The `/compact` summary wrapper chat-classifiers.ts's isCompactUserMessage
// detects - a user_message event, not a distinct ChatEvent variant.
function compactEvent(ts = 0) {
  return { type: "user_message", content: [{ type: "text", text: "<command-name>compact</command-name>" }], timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-compact-page-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("a scrolled-back compaction folds as a turn boundary", () => {
  it("matches the un-paginated (initial-hydrate) turn structure", async () => {
    const olderTurnEvents = [
      compactEvent(1_000_000),
      assistantEvent("old answer", 1_005_000),
      toolUseEvent("Bash", { command: "ls" }, "t1", 1_010_000),
      toolResultEvent("t1", 1_011_000),
      turnUsageEvent({ outputTokens: 1200, durationMs: 0 }),
    ];
    const laterTurnEvents = [assistantEvent("later answer", 2_001_000)];

    // Baseline: everything in one initial hydrate - handleUserMessageEvent's
    // live-push path, which never lost the boundary/pill.
    invokeRouter.queueOnce("load_history_page", {
      events: [...olderTurnEvents, ...laterTurnEvents],
      oldest_seq: 0,
      newest_seq: 12,
      has_more: false,
    });
    const baseline = await makeRenderer();
    const baselineFlat = [...baseline.container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    const baselineStrips = baseline.container.querySelectorAll(".tool-strip").length;
    const baselineFooters = baseline.container.querySelectorAll(".turn-footer").length;
    expect(baselineFlat.length).toBe(0);
    expect(baselineStrips).toBe(1);

    // Same content, but the compaction-opened turn arrives via scrollback -
    // the exact path eventToRenderedMessage takes, never handleUserMessageEvent.
    invokeRouter.queueOnce("load_history_page", {
      events: laterTurnEvents,
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: olderTurnEvents,
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });
    const paged = await makeRenderer();
    await paged.renderer.fetchOlder();

    const pagedFlat = [...paged.container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    const pagedStrips = paged.container.querySelectorAll(".tool-strip").length;
    const pagedFooters = paged.container.querySelectorAll(".turn-footer").length;

    expect(pagedFlat.length).toBe(baselineFlat.length);
    expect(pagedStrips).toBe(baselineStrips);
    expect(pagedFooters).toBe(baselineFooters);
    expect(paged.container.querySelector(".compact-chip")).not.toBeNull();
  });
});
