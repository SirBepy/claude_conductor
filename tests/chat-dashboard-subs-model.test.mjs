// asserts: src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/sidebar-row-visuals.ts

// The Subchats card's rules (docs/chat-dashboard-design.md, "Subchats card"):
// who is listed, the one-hour fold of finished subs, and the model + effort
// text every surface renders (the battery glyphs are gone).

import { describe, it, expect } from "vitest";

const { buildSubsState, FINISHED_KEEP_MS, formatRunTime, isStuckKind, subWhy, subStepLabel, STUCK_ROWS_SHOWN } = await import("../src/shared/chat/dashboard/subs-model.ts");
const { modelEffortTextHtml } = await import("../src/views/sessions/sidebar-row-visuals.ts");

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

describe("model + effort text", () => {
  it("names the family and the effort as words", () => {
    expect(modelEffortTextHtml("claude-sonnet-4-5", "high")).toContain("Sonnet high");
    expect(modelEffortTextHtml("claude-sonnet-4-5", "high")).toContain('class="session-model-text"');
  });

  it("keeps an Endpoint account's model id verbatim, with the effort", () => {
    expect(modelEffortTextHtml("k3.1-pro", "medium")).toContain("k3.1-pro medium");
  });

  it("names the model alone when no effort is recorded", () => {
    expect(modelEffortTextHtml("claude-opus-4-8")).toContain("Opus");
    expect(modelEffortTextHtml("claude-opus-4-8")).not.toContain("data-tip=\"Opus \"");
  });

  it("draws nothing without a model", () => {
    expect(modelEffortTextHtml("", "max")).toBe("");
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

describe("stuck rows (docs/chat-dashboard-design.md, \"Subchats card redesign\")", () => {
  it("gives every live kind but working a row, and keeps working subs in the avatar strip", () => {
    expect(["asking", "queued", "paused", "limited", "stopped"].every((k) => isStuckKind(k))).toBe(true);
    expect(isStuckKind("working")).toBe(false);
    expect(isStuckKind("finished")).toBe(false);
    expect(STUCK_ROWS_SHOWN).toBe(5);
  });

  it("says in one line why each stuck sub is not progressing", () => {
    const hover = (over) => ({ stateWord: "", step: null, action: null, queue: null, resetsAt: null, gaming: false, ...over });
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    expect(subWhy(item("a", "asking"), now)).toBe("Needs your answer");
    expect(subWhy(item("q", "queued", { hover: hover({ queue: { waitingFor: "Footer", place: 2, behind: null } }) }), now)).toBe("Waits for Footer, 2 in line");
    expect(subWhy(item("q", "queued", { hover: hover({ queue: { waitingFor: null, place: 1, behind: "Auth" } }) }), now)).toBe("Waits for Auth, next in line");
    expect(subWhy(item("q", "queued"), now)).toBe("Queued");
    expect(subWhy(item("p", "paused", { hover: hover({ gaming: true }) }), now)).toBe("Paused while you game");
    expect(subWhy(item("p", "paused"), now)).toBe("Paused");
    expect(subWhy(item("l", "limited", { hover: hover({ resetsAt: now + 3_600_000 }) }), now)).toMatch(/^Usage limit, back at \d/);
    expect(subWhy(item("l", "limited", { hover: hover({ resetsAt: now - 1 }) }), now)).toBe("At its usage limit");
    expect(subWhy(item("s", "stopped"), now)).toBe("Stopped without finishing");
    expect(subWhy(item("w", "working", { hover: hover({ action: { text: "Editing footer.css", at: now } }) }), now)).toBe("Editing footer.css");
  });

  it("labels a row with its plan step, else its progress words", () => {
    expect(subStepLabel(item("a", "working", { progress: "working", hover: { step: { n: 3, total: 6, text: "x" } } }))).toBe("step 3/6");
    expect(subStepLabel(item("a", "queued", { progress: "queued" }))).toBe("queued");
  });
});
