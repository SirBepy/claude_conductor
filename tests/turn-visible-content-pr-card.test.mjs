import { describe, it, expect } from "vitest";
import { turnProducedVisibleContent } from "../src/shared/chat/turn-visible-content.ts";

// A finalized /create-pr row shows its card even with raw view off, so a turn
// that produced only that row must not be folded into an Auto-continued streak.
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const markers = `<cc-pr-title:T>\n<cc-pr-body:${b64("body")}>\n<cc-pr-commits:${b64("[]")}>`;

function rendererWith(messages) {
  return { activeTurnStart: 0, messages, sessionId: null };
}

describe("turnProducedVisibleContent - PR preview card", () => {
  it("counts a finalized assistant row carrying the PR markers", () => {
    const r = rendererWith([{ kind: "assistant", content: [{ type: "text", text: markers }], streaming: false }]);
    expect(turnProducedVisibleContent(r)).toBe(true);
  });

  it("does not count plain narration", () => {
    const r = rendererWith([{ kind: "assistant", content: [{ type: "text", text: "just prose" }], streaming: false }]);
    expect(turnProducedVisibleContent(r)).toBe(false);
  });

  it("does not count a still-streaming row (no card exists yet)", () => {
    const r = rendererWith([{ kind: "assistant", content: [{ type: "text", text: markers }], streaming: true }]);
    expect(turnProducedVisibleContent(r)).toBe(false);
  });
});
