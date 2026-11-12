// asserts: src/shared/auto-compact.ts
// The frontend reads and writes the same `autoCompact` shape, with the same
// fallbacks, as the daemon's `subchats::compaction::threshold_for` (the Rust
// test `the_threshold_is_on_at_300k_by_default_and_a_project_overrides_it`
// uses these very cases).

import { describe, it, expect } from "vitest";
import { kToTokens, readAutoCompact, tokensToK, withAutoCompact } from "../src/shared/auto-compact.ts";

describe("readAutoCompact", () => {
  it("is on at 300K when nothing is set", () => {
    expect(readAutoCompact({}, "p")).toEqual({ on: true, tokens: 300_000 });
  });

  it("reads the global entry and lets a project override it field by field", () => {
    const s = { autoCompact: { on: false, tokens: 400000, projects: { p: { on: true }, q: { tokens: 250000 } } } };
    expect(readAutoCompact(s, null)).toEqual({ on: false, tokens: 400_000 });
    expect(readAutoCompact(s, "p")).toEqual({ on: true, tokens: 400_000 });
    expect(readAutoCompact(s, "q")).toEqual({ on: false, tokens: 250_000 });
    expect(readAutoCompact(s, "other")).toEqual({ on: false, tokens: 400_000 });
  });

  it("falls back on malformed values like the daemon does", () => {
    expect(readAutoCompact({ autoCompact: { on: "yes", tokens: 0 } }, "p")).toEqual({ on: true, tokens: 300_000 });
    expect(readAutoCompact({ autoCompact: { tokens: 1.5 } }, null).tokens).toBe(300_000);
    expect(readAutoCompact({ autoCompact: "junk" }, "p")).toEqual({ on: true, tokens: 300_000 });
  });
});

describe("withAutoCompact", () => {
  it("writes the global entry and keeps every other key", () => {
    const out = withAutoCompact({ keep: 1, autoCompact: { projects: { p: { on: false } } } }, null, { on: false });
    expect(out).toEqual({ keep: 1, autoCompact: { on: false, projects: { p: { on: false } } } });
  });

  it("writes one project's entry without touching the global or another project", () => {
    const base = { autoCompact: { on: true, tokens: 300000, projects: { q: { tokens: 1000 } } } };
    const out = withAutoCompact(base, "p", { tokens: 250000 });
    expect(out.autoCompact).toEqual({ on: true, tokens: 300000, projects: { q: { tokens: 1000 }, p: { tokens: 250000 } } });
    expect(base.autoCompact.projects).toEqual({ q: { tokens: 1000 } });
  });

  it("merges a second field into the project's entry", () => {
    const once = withAutoCompact({}, "p", { on: false });
    expect(withAutoCompact(once, "p", { tokens: 200000 }).autoCompact).toEqual({ projects: { p: { on: false, tokens: 200000 } } });
  });
});

describe("the K field", () => {
  it("converts both ways and refuses what the daemon would not accept", () => {
    expect(tokensToK(300_000)).toBe(300);
    expect(kToTokens(" 250 ")).toBe(250_000);
    expect(kToTokens("0")).toBeNull();
    expect(kToTokens("-5")).toBeNull();
    expect(kToTokens("1.5")).toBeNull();
    expect(kToTokens("")).toBeNull();
    expect(kToTokens("abc")).toBeNull();
    // Forms Number() accepts that the daemon's integer read would not.
    for (const odd of ["1e20", "1e3", "0x10", "10001", "99999999999999999999"]) expect(kToTokens(odd), odd).toBeNull();
    expect(kToTokens("10000")).toBe(10_000_000);
    expect(readAutoCompact({ autoCompact: { tokens: 1e23 } }, null).tokens).toBe(300_000);
  });
});
