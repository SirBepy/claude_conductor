// @vitest-environment jsdom

// An ack renders as hidden narration, so a wake/peer/schedule turn that only
// acked left no bubble: its chips must fold into the previous turn's footer
// instead of standing alone as a detached block.

import { describe, it, expect } from "vitest";

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { turnProducedVisibleContent } = await import("../src/shared/chat/turn-visible-content.ts");
const { enqueueTurnClose } = await import("../src/shared/chat/chat-turn-fold.ts");

const ack = { kind: "message", card: { kind: "ack" }, text: "on it", ts: 1 };
const report = { kind: "message", card: { kind: "report" }, text: "done", ts: 1 };

function rendererWith(messages) {
  return { activeTurnStart: 0, messages, sessionId: null };
}

describe("turnProducedVisibleContent - ack", () => {
  it("does not count an ack-only turn", () => {
    expect(turnProducedVisibleContent(rendererWith([ack]))).toBe(false);
  });

  it("counts a non-ack message beside the ack", () => {
    expect(turnProducedVisibleContent(rendererWith([ack, report]))).toBe(true);
  });

  it("still counts a retracted message, which draws a Retracted pill", () => {
    expect(turnProducedVisibleContent(rendererWith([{ ...report, retracted: true }]))).toBe(true);
  });

  it("does not count a failed message", () => {
    expect(turnProducedVisibleContent(rendererWith([{ ...report, failed: true }]))).toBe(false);
  });
});

describe("a meta turn that only acked", () => {
  // Opens a meta turn the way handleUserMessageEvent does, with a previous
  // turn's footer to merge into.
  function closeMetaTurnWith(rows) {
    const r = new ChatRenderer(document.createElement("div"));
    r.prevTurnChipKey = 1;
    r.activeTurnChipKey = 2;
    r.activeTurnIsMeta = true;
    r.activeTurnStart = 0;
    r.messages.push(...rows);
    enqueueTurnClose(r);
    return r.closeTurnQueue[0];
  }

  it("merges its footer into the previous turn's", () => {
    expect(closeMetaTurnWith([ack]).mergeIntoKey).toBe(1);
  });

  it("keeps its own footer once it showed a report", () => {
    expect(closeMetaTurnWith([ack, report]).mergeIntoKey).toBeNull();
  });
});
