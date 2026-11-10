// asserts: src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/sidebar-row-visuals.ts

// The Subchats card's rules (docs/chat-dashboard-design.md, "Subchats card"):
// who is listed, the one-hour fold of finished subs, and the effort palette
// every model battery in the app takes.

import { describe, it, expect } from "vitest";

const { buildSubsState, FINISHED_KEEP_MS, effortColor, EFFORT_COLORS, formatRunTime } = await import("../src/shared/chat/dashboard/subs-model.ts");
const { modelBatteryHtml } = await import("../src/views/sessions/sidebar-row-visuals.ts");

const NOW = 1_800_000_000_000;
const item = (id, kind, extra = {}) => ({
  id, name: id, kind, closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "", startedAt: null, finishedAt: null, ring: { kind: "none" }, ...extra,
});
const ids = (list) => list.map((i) => i.id);

describe("Subchats card list", () => {
  it("draws nothing when there are no subs", () => {
    expect(buildSubsState([], NOW)).toBeNull();
  });

  it("lists asking first, then working, then queued, then the finished ones newest first", () => {
    const s = buildSubsState([
      item("done-old", "finished", { finishedAt: NOW - 20 * 60_000 }),
      item("queued", "queued"),
      item("work", "working"),
      item("done-new", "finished", { finishedAt: NOW - 60_000 }),
      item("ask", "asking"),
    ], NOW);
    expect(ids(s.shown)).toEqual(["ask", "work", "queued", "done-new", "done-old"]);
    expect(s.earlier).toEqual([]);
  });

  it("keeps a finished sub for exactly one hour, then folds it under +N earlier", () => {
    const sub = (ago) => item("f", "finished", { finishedAt: NOW - ago });
    expect(ids(buildSubsState([sub(FINISHED_KEEP_MS - 1)], NOW).shown)).toEqual(["f"]);
    const folded = buildSubsState([sub(FINISHED_KEEP_MS)], NOW);
    expect(folded.shown).toEqual([]);
    expect(ids(folded.earlier)).toEqual(["f"]);
  });

  it("never folds a working, queued or asking sub, however long it has run", () => {
    const s = buildSubsState(["working", "queued", "asking"].map((k) => item(k, k, { finishedAt: NOW - 5 * FINISHED_KEEP_MS })), NOW);
    expect(s.shown).toHaveLength(3);
    expect(s.earlier).toEqual([]);
  });

  it("keeps a closing sub in view: it is not finished yet", () => {
    const s = buildSubsState([item("c", "finished", { closing: true, finishedAt: NOW - 3 * FINISHED_KEEP_MS })], NOW);
    expect(ids(s.shown)).toEqual(["c"]);
  });

  it("folds a finished sub nothing dates, rather than showing it for ever", () => {
    expect(ids(buildSubsState([item("u", "finished")], NOW).earlier)).toEqual(["u"]);
  });

  it("still draws the card when only folded subs remain", () => {
    const s = buildSubsState([item("old", "finished", { finishedAt: NOW - 2 * FINISHED_KEEP_MS })], NOW);
    expect(s.shown).toEqual([]);
    expect(s.earlier).toHaveLength(1);
  });

  it("says when the next shown finished sub folds so the view can redraw on time", () => {
    const s = buildSubsState([
      item("a", "finished", { finishedAt: NOW - 10 * 60_000 }),
      item("b", "finished", { finishedAt: NOW - 50 * 60_000 }),
      item("w", "working"),
    ], NOW);
    expect(s.foldsAt).toBe(NOW - 50 * 60_000 + FINISHED_KEEP_MS);
    expect(buildSubsState([item("w", "working")], NOW).foldsAt).toBeNull();
  });

  it("is a display rule only: it returns the same items, never a close", () => {
    const input = [item("a", "finished", { finishedAt: NOW - 9 * FINISHED_KEEP_MS })];
    const before = JSON.stringify(input);
    buildSubsState(input, NOW);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("effort palette", () => {
  it("is Joe's five colours, with high left as the battery's own grey", () => {
    expect(EFFORT_COLORS).toEqual({ low: "#ece6cf", medium: "#b3a67c", high: null, xhigh: "#f2994a", max: "#eb5757" });
    expect(effortColor("max")).toBe("#eb5757");
    expect(effortColor(" XHigh ")).toBe("#f2994a");
    expect(effortColor("high")).toBeNull();
    expect(effortColor("")).toBeNull();
    expect(effortColor(undefined)).toBeNull();
    expect(effortColor("turbo")).toBeNull();
  });

  it("tints a model battery by effort and leaves the default one plain", () => {
    expect(modelBatteryHtml("claude-opus-4-8", "max")).toContain('data-effort="max"');
    expect(modelBatteryHtml("claude-opus-4-8", "low")).toContain('data-effort="low"');
    expect(modelBatteryHtml("claude-opus-4-8", "high")).not.toContain("data-effort");
    expect(modelBatteryHtml("claude-opus-4-8")).not.toContain("data-effort");
    expect(modelBatteryHtml("claude-opus-4-8", "xhigh")).toContain("Opus 4.8, xhigh");
  });

  it("draws no battery for a model it does not rank, whatever the effort", () => {
    expect(modelBatteryHtml("mystery-1", "max")).toBe("");
  });
});

describe("run time", () => {
  it("reads mm:ss under an hour and h:mm:ss after", () => {
    expect(formatRunTime(0)).toBe("00:00");
    expect(formatRunTime(65_000)).toBe("01:05");
    expect(formatRunTime(3_725_000)).toBe("1:02:05");
    expect(formatRunTime(-5)).toBe("00:00");
  });
});
