// singleFlight backs the statusbar's transcript-scanning refreshes: a burst of
// calls must run the work once now plus once after, never N times at once.

import { describe, it, expect } from "vitest";

const { singleFlight } = await import("../src/shared/single-flight.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("singleFlight", () => {
  it("collapses a burst into one in-flight run plus one trailing rerun", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const gates = [];
    const run = singleFlight(async () => {
      runs++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      const g = deferred();
      gates.push(g);
      await g.promise;
      running--;
    });

    const calls = [];
    for (let i = 0; i < 60; i++) calls.push(run());
    expect(runs).toBe(1);

    gates[0].resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    gates[1].resolve();
    await Promise.all(calls);

    expect(runs).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("starts fresh once idle and survives a throwing run", async () => {
    let runs = 0;
    const run = singleFlight(async () => {
      runs++;
      if (runs === 1) throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    await run();
    expect(runs).toBe(2);
  });
});
