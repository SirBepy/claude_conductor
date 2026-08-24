import { describe, it, expect } from "vitest";
import { splitSuggestion } from "../src/views/sessions/ask-suggestion.ts";

describe("splitSuggestion", () => {
  it("returns the whole answer when there is no suggestion", () => {
    const r = splitSuggestion("Backpressure is slowing the producer.");
    expect(r.suggestion).toBeNull();
    expect(r.body).toBe("Backpressure is slowing the producer.");
  });

  it("splits a trailing suggestion off the body", () => {
    const r = splitSuggestion("You never split the tests.\n\nSUGGESTED: split the tests out of pump/mod.rs");
    expect(r.suggestion).toBe("split the tests out of pump/mod.rs");
    expect(r.body).toBe("You never split the tests.");
  });

  it("tolerates trailing blank lines after the suggestion", () => {
    const r = splitSuggestion("body\nSUGGESTED: do the thing\n\n  \n");
    expect(r.suggestion).toBe("do the thing");
    expect(r.body).toBe("body");
  });

  it("strips list and quote markers the model may prepend", () => {
    expect(splitSuggestion("body\n- SUGGESTED: do it").suggestion).toBe("do it");
    expect(splitSuggestion("body\n> SUGGESTED: do it").suggestion).toBe("do it");
  });

  it("ignores a mid-answer mention, only the last line counts", () => {
    const r = splitSuggestion("SUGGESTED: not this one\n\nthe real answer is here");
    expect(r.suggestion).toBeNull();
    expect(r.body).toBe("SUGGESTED: not this one\n\nthe real answer is here");
  });

  it("treats an empty suggestion as none", () => {
    const r = splitSuggestion("body\nSUGGESTED:   ");
    expect(r.suggestion).toBeNull();
    expect(r.body).toBe("body\nSUGGESTED:");
  });

  it("does not fire on a word merely containing the marker", () => {
    expect(splitSuggestion("body\nUNSUGGESTED: nope").suggestion).toBeNull();
  });
});
