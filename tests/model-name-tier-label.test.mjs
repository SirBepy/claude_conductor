// asserts: src/shared/model-name.ts

// A sub's tier label is the family without its version at its effort. Fable is
// a family a chat or sub can run on, so it names itself like the other three
// instead of falling through to the raw model id.

import { describe, it, expect } from "vitest";
import { tierLabel } from "../src/shared/model-name.ts";

describe("tierLabel", () => {
  it("names the Claude families without their version", () => {
    expect(tierLabel("claude-opus-5-5", "high")).toBe("Opus high");
    expect(tierLabel("sonnet", "medium")).toBe("Sonnet medium");
    expect(tierLabel("claude-haiku-5-5", "")).toBe("Haiku");
  });

  it("names Fable the same way, not by its raw id", () => {
    expect(tierLabel("claude-fable-5-2", "high")).toBe("Fable high");
    expect(tierLabel("fable", "low")).toBe("Fable low");
  });

  it("keeps a foreign endpoint id verbatim and gives no label for an empty model", () => {
    expect(tierLabel("k3.1-pro", "medium")).toBe("k3.1-pro medium");
    expect(tierLabel("", "high")).toBe("");
  });
});
