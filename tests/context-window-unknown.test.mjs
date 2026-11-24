// @vitest-environment jsdom
//
// A chat on an endpoint account whose window nobody stated (window_known false)
// shows its token count and never a percent: a percent of a guessed window read
// 100% on a Kimi chat that was a quarter empty. Every surface takes the number
// through ctxPctOf, so the cards and hovers go quiet together.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { contextChipHtml } = await import("../src/views/sessions/statusbar-chips.ts");
const { ctxPctOf } = await import("../src/views/sessions/session-statusbar-helpers.ts");

const known = { model: "sonnet", window: 262_144, occupancy: 199_493, remaining: 62_651, pct_used: 76, pct_left: 24, confidence: "configured", window_known: true };
const unknown = { model: "sonnet", window: 0, occupancy: 199_493, remaining: 0, pct_used: 0, pct_left: 0, confidence: "unknown", window_known: false };

describe("a context status whose window is not known", () => {
  it("draws the token count and no percent, in both chip modes", () => {
    for (const asTokens of [false, true]) {
      const html = contextChipHtml(unknown, asTokens);
      expect(html).toContain("199k");
      expect(html).not.toContain("%");
      expect(html).toContain("199,493 tokens");
    }
  });

  it("yields no percent for the hover cards, the dashboard and the done card", () => {
    expect(ctxPctOf(unknown)).toBeNull();
    expect(ctxPctOf(null)).toBeNull();
    expect(ctxPctOf(undefined)).toBeNull();
  });

  it("still draws a percent when the window is the provider's stated one, without an estimate mark", () => {
    expect(ctxPctOf(known)).toBe(76);
    const html = contextChipHtml(known, false);
    expect(html).toContain("76%");
    expect(html).not.toContain("estimated");
  });

  it("keeps drawing a status that has no window_known field (a peer on an older build)", () => {
    const { window_known: _gone, ...legacy } = { ...known, confidence: "heuristic" };
    expect(ctxPctOf(legacy)).toBe(76);
    expect(contextChipHtml(legacy, false)).toContain("76%");
  });
});
