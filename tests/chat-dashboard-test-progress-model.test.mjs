// The Test progress card's pure side (pc-1684): the daemon's `test-progress` event read
// leniently, the derive that decides when the card draws and what each run shows, and
// the zone's place in the dashboard. The card raises nothing, even for a failed run.

import { describe, it, expect } from "vitest";

const {
  normaliseRuns, deriveTestProgress, viewRun, nextStaleAt, stateLabel, countsParts, STALE_MS,
} = await import("../src/shared/chat/dashboard/test-progress-model.ts");
const { deriveDashboard, ZONES, SECTION_DEFAULTS } = await import("../src/shared/chat/dashboard/dashboard-model.ts");

const raw = (over = {}) => ({
  runner: "vitest", passed: 40, failed: 0, total: 100, failing: [], failing_more: 0, state: "running", at_ms: 5, ...over,
});
const runs = (list, seen = 1000) => normaliseRuns(list, seen);

describe("normaliseRuns", () => {
  it("reads the daemon's shape and drops rows that are not runs", () => {
    const out = runs([raw(), { runner: "" }, { passed: 3 }, null, "x", raw({ runner: "cargo test", failing: ["a::b", 7, ""] })]);
    expect(out.map((r) => r.runner)).toEqual(["vitest", "cargo test"]);
    expect(out[1].failing).toEqual(["a::b"]);
    expect(out[0].seenMs).toBe(1000);
  });

  it("reads a missing or bad number as 0 and an unknown state as failed, never as fine", () => {
    const [r] = runs([raw({ passed: -4, failed: "x", total: null, state: "melting" })]);
    expect([r.passed, r.failed, r.total]).toEqual([0, 0, 0]);
    expect(r.state).toBe("failed");
  });

  it("is empty for anything that is not a list", () => {
    expect(runs(undefined)).toEqual([]);
    expect(runs({ runner: "vitest" })).toEqual([]);
  });
});

describe("viewRun", () => {
  it("fills the bar by passed and failed over the total", () => {
    const v = viewRun(runs([raw({ passed: 40, failed: 10, total: 100 })])[0], 1000);
    expect(v.okFrac).toBeCloseTo(0.4);
    expect(v.badFrac).toBeCloseTo(0.1);
    expect(v.of).toBe(100);
    expect(v.indeterminate).toBe(false);
  });

  it("grows the total to what ran instead of overflowing the bar", () => {
    const v = viewRun(runs([raw({ passed: 90, failed: 30, total: 100 })])[0], 1000);
    expect(v.of).toBe(120);
    expect(v.okFrac + v.badFrac).toBeCloseTo(1);
  });

  it("a running run with no announced total is indeterminate, a finished one fills to what ran", () => {
    expect(viewRun(runs([raw({ total: 0, passed: 5 })])[0], 1000).indeterminate).toBe(true);
    const done = viewRun(runs([raw({ total: 0, passed: 8, failed: 2, state: "failed" })])[0], 1000);
    expect(done.indeterminate).toBe(false);
    expect(done.okFrac + done.badFrac).toBeCloseTo(1);
  });

  it("a run that stopped reporting reads as stopped, and not live", () => {
    const [r] = runs([raw()], 1000);
    expect(viewRun(r, 1000 + STALE_MS).stale).toBe(false);
    const v = viewRun(r, 1000 + STALE_MS + 1);
    expect(v.stale).toBe(true);
    expect(v.indeterminate).toBe(false);
    expect(stateLabel(v)).toBe("Stopped");
    expect(viewRun(runs([raw({ state: "passed" })], 1000)[0], 1e9).stale).toBe(false);
  });
});

describe("deriveTestProgress", () => {
  it("draws nothing until a run reported, or when the switch is off", () => {
    expect(deriveTestProgress(undefined, true, 0)).toBeNull();
    expect(deriveTestProgress({ runs: [] }, true, 0)).toBeNull();
    expect(deriveTestProgress({ runs: runs([raw()]) }, false, 1000)).toBeNull();
  });

  it("says whether a run is live", () => {
    const side = { runs: runs([raw(), raw({ runner: "cargo test", state: "passed" })], 1000) };
    expect(deriveTestProgress(side, true, 1000).live).toBe(true);
    expect(deriveTestProgress({ runs: runs([raw({ state: "passed" })]) }, true, 1000).live).toBe(false);
    expect(deriveTestProgress(side, true, 1000 + STALE_MS + 1).live).toBe(false);
  });
});

describe("nextStaleAt", () => {
  it("is the earliest moment a live run goes quiet, and null with no live run", () => {
    const side = { runs: [...runs([raw()], 1000), ...runs([raw({ runner: "b" })], 4000)] };
    expect(nextStaleAt(side, 5000)).toBe(1000 + STALE_MS + 1);
    expect(nextStaleAt({ runs: runs([raw({ state: "passed" })]) }, 5000)).toBeNull();
    expect(nextStaleAt(undefined, 5000)).toBeNull();
  });
});

describe("countsParts", () => {
  it("names only what says something", () => {
    const run = (o) => viewRun(runs([raw(o)])[0], 1000);
    expect(countsParts(run({ passed: 40, failed: 0, total: 100 }))).toEqual({ passed: "40 passed", failed: "", of: "of 100" });
    expect(countsParts(run({ passed: 90, failed: 10, total: 100, state: "failed" }))).toEqual({ passed: "90 passed", failed: "10 failed", of: "" });
    expect(countsParts(run({ passed: 7, failed: 0, total: 0, state: "passed" }))).toEqual({ passed: "7 passed", failed: "", of: "" });
  });
});

describe("the tests zone", () => {
  const input = (extra = {}) => ({ messages: [], plans: [], now: 1000, ...extra });
  const side = { runs: runs([raw({ state: "failed", failed: 2, failing: ["a > b"] })]) };

  it("sits on the right under Plan and is on by default", () => {
    expect(ZONES.tests.column).toBe("right");
    expect(ZONES.tests.order).toBeGreaterThan(ZONES.plan.order);
    expect(ZONES.tests.order).toBeLessThan(ZONES.done.order);
    expect(SECTION_DEFAULTS.tests).toBe(true);
  });

  it("appears once a run reported and not before, and the switch hides it", () => {
    expect(deriveDashboard(input()).right.map((z) => z.id)).not.toContain("tests");
    expect(deriveDashboard(input({ testProgress: side })).right.map((z) => z.id)).toContain("tests");
    expect(deriveDashboard(input({ testProgress: side, sections: { tests: false } })).right.map((z) => z.id)).not.toContain("tests");
  });

  it("raises nothing: a failed run adds no Waiting item and no strip", () => {
    const plain = deriveDashboard(input());
    const failed = deriveDashboard(input({ testProgress: side }));
    expect(failed.left.map((z) => z.id)).toEqual(plain.left.map((z) => z.id));
    expect(failed.strip).toEqual(plain.strip);
  });
});
