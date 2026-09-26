import { describe, it, expect, beforeEach } from "vitest";
import {
  LoadTracker,
  aggregateSnapshot,
  beginLoad,
  clearDurationHistory,
  estimateMs,
  readTrackedJson,
  recordDuration,
  resetActiveLoads,
} from "../src/shared/load-progress.ts";

// The module reads/writes localStorage directly; vitest runs in `node`, so
// stand one up rather than pulling in jsdom for a store this small.
function installLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

beforeEach(() => {
  installLocalStorage();
  clearDurationHistory();
  resetActiveLoads();
});

describe("duration history", () => {
  it("falls back to the seed before anything has been recorded", () => {
    expect(estimateMs("get_settings")).toBe(1800);
  });

  it("returns the median, not the mean, so one outlier cannot skew it", () => {
    for (const ms of [100, 110, 120, 130, 9000]) recordDuration("m", ms);
    expect(estimateMs("m")).toBe(120);
  });

  it("keeps only the newest ten samples", () => {
    // Twelve slow, then ten fast: the slow ones must have aged out entirely.
    for (let i = 0; i < 12; i++) recordDuration("m", 5000);
    for (let i = 0; i < 10; i++) recordDuration("m", 200);
    expect(estimateMs("m")).toBe(200);
  });

  it("ignores nonsense durations", () => {
    recordDuration("m", 0);
    recordDuration("m", -5);
    recordDuration("m", NaN);
    expect(estimateMs("m")).toBe(1800);
  });

  it("survives localStorage being unavailable", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(() => recordDuration("m", 100)).not.toThrow();
    expect(estimateMs("m")).toBe(1800);
  });
});

describe("LoadTracker phases", () => {
  it("is indeterminate before the first byte - never a made-up percent", () => {
    const t = new LoadTracker("m", 0);
    const snap = t.snapshot(300);
    expect(snap.phase).toBe("waiting");
    expect(snap.fraction).toBeNull();
    expect(snap.etaMs).toBe(1500);
  });

  it("reports a real percent once bytes land against a Content-Length", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(1000, 200);
    t.onChunk(500);
    const snap = t.snapshot(400);
    expect(snap.phase).toBe("streaming");
    // Half the body, mapped into the 12..100 band the handoff reserves.
    expect(snap.fraction).toBeCloseTo(0.12 + 0.5 * 0.88, 5);
    expect(snap.totalBytes).toBe(1000);
  });

  it("never steps backwards at the handoff from time to bytes", () => {
    const t = new LoadTracker("m", 0);
    const waiting = t.snapshot(100);
    expect(waiting.fraction).toBeNull();
    t.onHead(1000, 120);
    t.onChunk(1);
    // The very first byte must not land below where the indeterminate phase
    // handed over, or the arc would visibly snap back.
    expect(t.snapshot(130).fraction).toBeGreaterThanOrEqual(0.12);
  });

  it("abandons the countdown instead of running it negative", () => {
    const t = new LoadTracker("m", 0);
    const snap = t.snapshot(5000);
    expect(snap.phase).toBe("overdue");
    expect(snap.etaMs).toBeNull();
  });

  it("asymptotes below 100% while overdue, and keeps moving", () => {
    const t = new LoadTracker("m", 0);
    const a = t.snapshot(3000).fraction;
    const b = t.snapshot(9000).fraction;
    const c = t.snapshot(60000).fraction;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(0.95);
  });

  // Caught by looking at the render: at the original time constant this painted
  // 90% while the copy said "longer than usual", which reads as almost-done at
  // exactly the moment the estimate has been given up on.
  it("does not look nearly-done shortly after going overdue", () => {
    const t = new LoadTracker("m", 0);
    expect(t.snapshot(12000).fraction).toBeLessThan(0.7);
    expect(t.snapshot(30000).fraction).toBeLessThan(0.85);
  });

  it("never lets an overdue load outrank a still-measured one", () => {
    const overdue = new LoadTracker("m", 0);
    // The overdue ceiling sits under the 0.95 cap the measurable paths use.
    expect(overdue.snapshot(600000).fraction).toBeLessThanOrEqual(0.9);
  });

  it("falls back to time when the response carries no Content-Length", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(null, 100);
    const snap = t.snapshot(900);
    expect(snap.phase).toBe("streaming");
    expect(snap.totalBytes).toBeNull();
    expect(snap.fraction).toBeCloseTo(0.5, 5);
  });

  // Regression: the overdue branch used to be evaluated before the
  // no-Content-Length streaming branch AND anchored at HANDOFF, so a body
  // already climbing on time alone snapped from 95% to 12% in one frame the
  // instant it crossed the estimate - the exact backward step the handoff
  // design exists to prevent, on the slow-network case the feature targets.
  it("does not snap backwards crossing into overdue with no Content-Length", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(null, 5);
    const before = t.snapshot(1799).fraction;
    const after = t.snapshot(1801).fraction;
    expect(before).toBeGreaterThan(0.8);
    expect(after).toBeGreaterThanOrEqual(before - 0.001);
  });

  it("climbs monotonically across the whole no-Content-Length lifetime", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(null, 5);
    let prev = -1;
    for (let ms = 10; ms <= 120000; ms += 37) {
      const f = t.snapshot(ms).fraction ?? 0;
      expect(f).toBeGreaterThanOrEqual(prev - 0.001);
      prev = f;
    }
  });

  it("caps the no-Content-Length estimate below a claimed completion", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(null, 100);
    // Elapsed is under the estimate here, so this stays in the time branch
    // rather than falling through to overdue.
    expect(t.snapshot(1790).fraction).toBeLessThanOrEqual(0.95);
  });

  it("only reaches 100% on a real completion", () => {
    const t = new LoadTracker("m", 0);
    t.onHead(1000, 100);
    t.onChunk(1000);
    expect(t.snapshot(500).fraction).toBeCloseTo(1, 5);
    t.finish(600);
    const snap = t.snapshot(700);
    expect(snap.phase).toBe("done");
    expect(snap.fraction).toBe(1);
  });

  it("records its duration on finish", () => {
    const t = new LoadTracker("m", 0);
    t.finish(450);
    expect(estimateMs("m")).toBe(450);
  });

  // A failed request's duration says nothing about how long success takes, so
  // letting it into the median would poison every later estimate.
  it("does NOT record a duration when abandoned", () => {
    const t = new LoadTracker("m", 0);
    t.abandon(450);
    expect(estimateMs("m")).toBe(1800);
    expect(t.snapshot(500).phase).toBe("done");
  });

  it("ignores a second finish", () => {
    const t = new LoadTracker("m", 0);
    t.finish(200);
    t.finish(9000);
    expect(estimateMs("m")).toBe(200);
  });
});

describe("aggregateSnapshot", () => {
  it("counts a not-yet-started leg as zero rather than skipping it", () => {
    const a = beginLoad("a");
    a.onHead(100, 0);
    a.onChunk(100);
    a.finish();
    // 'b' never started. Averaging only over 'a' would read as 100% done.
    const snap = aggregateSnapshot(["a", "b"]);
    expect(snap.phase).not.toBe("done");
    expect(snap.fraction).toBeLessThanOrEqual(0.5);
  });

  it("is done only when every leg is done", () => {
    beginLoad("a").finish();
    const b = beginLoad("b");
    expect(aggregateSnapshot(["a", "b"]).phase).not.toBe("done");
    b.finish();
    const snap = aggregateSnapshot(["a", "b"]);
    expect(snap.phase).toBe("done");
    expect(snap.fraction).toBe(1);
  });

  it("stays indeterminate while no leg has a measurable number", () => {
    beginLoad("a");
    beginLoad("b");
    expect(aggregateSnapshot(["a", "b"]).fraction).toBeNull();
  });

  it("reports overdue if any single leg is overdue, and drops the eta", () => {
    beginLoad("fast").finish();
    beginLoad("slow");
    // 'slow' started now, so reading an hour later puts it well past its
    // estimate while 'fast' is already done.
    const snap = aggregateSnapshot(["fast", "slow"], Date.now() + 60000);
    expect(snap.phase).toBe("overdue");
    expect(snap.etaMs).toBeNull();
  });

  it("sums bytes across legs that have a Content-Length", () => {
    const a = beginLoad("a");
    a.onHead(1000, 0);
    a.onChunk(250);
    const b = beginLoad("b");
    b.onHead(3000, 0);
    b.onChunk(750);
    const snap = aggregateSnapshot(["a", "b"]);
    expect(snap.receivedBytes).toBe(1000);
    expect(snap.totalBytes).toBe(4000);
  });

  it("treats an empty method list as already done", () => {
    expect(aggregateSnapshot([]).phase).toBe("done");
  });
});

describe("readTrackedJson", () => {
  it("feeds chunk sizes to the tracker and returns the parsed body", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const bytes = new TextEncoder().encode(payload);
    const tracker = new LoadTracker("m", 0);
    const res = {
      headers: { get: (k) => (k === "Content-Length" ? String(bytes.length) : null) },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      text: async () => payload,
    };
    expect(await readTrackedJson(res, tracker)).toEqual({ hello: "world" });
    const snap = tracker.snapshot(50);
    expect(snap.receivedBytes).toBe(bytes.length);
    expect(snap.totalBytes).toBe(bytes.length);
  });

  it("falls back to text() when the body is not a readable stream", async () => {
    const tracker = new LoadTracker("m", 0);
    const res = {
      headers: { get: () => null },
      body: null,
      text: async () => "{}",
    };
    expect(await readTrackedJson(res, tracker)).toEqual({});
    expect(tracker.snapshot(10).totalBytes).toBeNull();
  });

  // A response exposing only json() - no stream, no text() - must still work.
  // Dropping to text() unconditionally is what broke every transport-http test.
  it("falls back to json() when text() is absent too", async () => {
    const tracker = new LoadTracker("m", 0);
    const res = { json: async () => ({ ok: true }) };
    expect(await readTrackedJson(res, tracker)).toEqual({ ok: true });
  });

  it("reassembles a body split across several chunks", async () => {
    const parts = ["{\"a\":", "1,\"b\":", "2}"].map((p) => new TextEncoder().encode(p));
    const tracker = new LoadTracker("m", 0);
    let i = 0;
    const res = {
      headers: { get: () => "14" },
      body: {
        getReader: () => ({
          read: async () =>
            i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined },
        }),
      },
      text: async () => "",
    };
    expect(await readTrackedJson(res, tracker)).toEqual({ a: 1, b: 2 });
  });
});
