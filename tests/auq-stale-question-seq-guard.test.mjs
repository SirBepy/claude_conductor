import { describe, it, expect } from "vitest";
import { isLatestQuestion, markLatestQuestion, markQuestionSuperseded } from "../src/views/sessions/permission-modal/gating.ts";

// Contract: an id is stale only once explicitly passed to markQuestionSuperseded
// (todo 833's ghost-swap). Recency alone is never supersession, so a sibling
// card (todo 860) or an out-of-order ghost mark (todo 773) cannot drop a
// genuinely open card's answer.

describe("stale-question guard - explicit supersession", () => {
  it("todo 773: an out-of-order ghost mark never drops the genuinely open card", () => {
    markLatestQuestion("s1", "newer", 5);
    markLatestQuestion("s1", "older-ghost", 2); // arrives out of order
    expect(isLatestQuestion("s1", "newer")).toBe(true);
    expect(isLatestQuestion("s1", "older-ghost")).toBe(true); // not marked superseded, so not dropped
  });

  it("todo 860: answering the older of two pending siblings is still allowed", () => {
    markLatestQuestion("s2", "older", 1);
    markLatestQuestion("s2", "newer", 2);
    expect(isLatestQuestion("s2", "older")).toBe(true);
    expect(isLatestQuestion("s2", "newer")).toBe(true);
  });

  it("todo 833: markQuestionSuperseded drops only the marked ghost id", () => {
    markLatestQuestion("s3", "real");
    markLatestQuestion("s3", "ghost");
    markQuestionSuperseded("s3", "ghost");
    expect(isLatestQuestion("s3", "ghost")).toBe(false);
    expect(isLatestQuestion("s3", "real")).toBe(true);
    expect(isLatestQuestion("s4", "ghost")).toBe(true); // same id, different session, untouched
  });

  it("markLatestQuestion un-supersedes a previously superseded id", () => {
    markQuestionSuperseded("s5", "q1");
    expect(isLatestQuestion("s5", "q1")).toBe(false);
    markLatestQuestion("s5", "q1");
    expect(isLatestQuestion("s5", "q1")).toBe(true);
  });

  it("no session ever marked treats any id as latest", () => {
    expect(isLatestQuestion("never-seen", "whatever")).toBe(true);
  });

  it("undefined sessionId is a no-op for both mark functions and never throws", () => {
    expect(() => markLatestQuestion(undefined, "q")).not.toThrow();
    expect(() => markQuestionSuperseded(undefined, "q")).not.toThrow();
    expect(isLatestQuestion(undefined, "q")).toBe(true);
  });
});
