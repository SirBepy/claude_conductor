import { describe, it, expect } from "vitest";
import { isLatestQuestion, markLatestQuestion } from "../src/views/sessions/permission-modal/gating.ts";

// Regression for todo 773: `list_pending_prompts` snapshot order is not
// chronological (a Rust HashMap), so a poll could process a ghost/stale
// question after a genuinely newer one and mark the OLDER id "latest" -
// silently failing isLatestQuestion for the real card's answer.

describe("stale-question guard - seq ordering", () => {
  it("keeps the higher-seq id latest even when the lower-seq one is marked afterward", () => {
    markLatestQuestion("s1", "newer", 5);
    markLatestQuestion("s1", "older-ghost", 2); // arrives out of order, must not win
    expect(isLatestQuestion("s1", "newer")).toBe(true);
    expect(isLatestQuestion("s1", "older-ghost")).toBe(false);
  });

  it("still advances latest when seq increases normally", () => {
    markLatestQuestion("s2", "first", 1);
    markLatestQuestion("s2", "second", 2);
    expect(isLatestQuestion("s2", "second")).toBe(true);
    expect(isLatestQuestion("s2", "first")).toBe(false);
  });

  it("falls back to always-overwrite when seq is absent (older daemon payload shape)", () => {
    markLatestQuestion("s3", "first");
    markLatestQuestion("s3", "second");
    expect(isLatestQuestion("s3", "second")).toBe(true);
    expect(isLatestQuestion("s3", "first")).toBe(false);
  });

  it("an undefined-seq call still overwrites a seq-tracked entry (permissive fallback)", () => {
    markLatestQuestion("s4", "first", 1);
    markLatestQuestion("s4", "second"); // no seq - trusted as-is, matches pre-seq behavior
    expect(isLatestQuestion("s4", "second")).toBe(true);
  });

  it("no session ever marked treats any id as latest", () => {
    expect(isLatestQuestion("never-seen", "whatever")).toBe(true);
  });
});
