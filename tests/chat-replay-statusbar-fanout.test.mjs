// @vitest-environment jsdom
//
// A chat open replays its history page through the live event handlers. Each
// onMetaUpdate makes the statusbar re-scan the whole transcript twice
// (instance_token_stats + context_status) and each onToolTally re-renders it,
// so per-event callbacks during the replay cost a 5.5MB chat 63 + 63 scans and
// 74 statusbar renders on every open (measured 2026-10-29). The replay must
// report each once, with the final state, and live events must still report.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent, finalEvent, toolUseEvent } from "./helpers/chat-events.mjs";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function turnUsage(inputTokens) {
  return {
    type: "turn_usage",
    input_tokens: inputTokens,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    duration_ms: 0,
    has_thinking: false,
    model: "claude-sonnet",
  };
}

function toolResult(id) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 };
}

/** 20 turns, each: user, tool call + result, assistant reply, usage. */
function history() {
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push(userEvent(`q${i}`, i * 10));
    out.push(toolUseEvent("Read", { file_path: `/r/f${i}.ts` }, `t${i}`, i * 10 + 1));
    out.push(toolResult(`t${i}`));
    out.push(finalEvent(`a${i}`, i * 10 + 2));
    out.push(turnUsage(1000 + i));
  }
  return out;
}

beforeEach(() => {
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
});

describe("history replay -> statusbar callbacks", () => {
  it("reports meta and tool tally once, with the final state, not per replayed event", async () => {
    const r = new ChatRenderer(document.createElement("div"));
    const metas = [];
    const tallies = [];
    r.onMetaUpdate = (m) => metas.push({ ...m });
    r.onToolTally = (t) => tallies.push(t);

    await r.loadHistory(history());

    expect(metas).toHaveLength(1);
    expect(metas[0].inputTokens).toBe(1019);
    expect(metas[0].hasUsage).toBe(true);
    // One reset at the start of the replay, one final - never one per tool row.
    expect(tallies.length).toBeLessThanOrEqual(2);
    expect(tallies.at(-1).byType.find((b) => b.tool === "Read").count).toBe(20);
  });

  it("still reports every live event once the replay is done", async () => {
    const r = new ChatRenderer(document.createElement("div"));
    await r.loadHistory(history());
    const metas = [];
    const tallies = [];
    r.onMetaUpdate = (m) => metas.push(m);
    r.onToolTally = (t) => tallies.push(t);

    r.handleEvent(toolUseEvent("Bash", { command: "ls" }, "live1"));
    r.handleEvent(turnUsage(5000));

    expect(tallies.length).toBeGreaterThanOrEqual(1);
    expect(metas).toHaveLength(1);
    expect(metas[0].inputTokens).toBe(5000);
  });

  it("pushes no meta for a replay that carried no usage or model", async () => {
    const r = new ChatRenderer(document.createElement("div"));
    const metas = [];
    r.onMetaUpdate = (m) => metas.push(m);

    await r.loadHistory([userEvent("hi", 0), finalEvent("hello", 1)]);

    expect(metas).toHaveLength(0);
  });
});
