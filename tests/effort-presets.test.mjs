import { describe, it, expect, afterEach } from "vitest";
import {
  MODELS,
  readModels,
  readDefaultFlags,
  readLastChoice,
  sortByImpressiveness,
  setApiModels,
  latestIdForFamily,
  modelDisplayLabel,
} from "../src/shared/effort-presets.ts";

// Realistic /v1/models id list (newest-first per family, as the API delivers).
const API_IDS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

describe("readModels", () => {
  it("returns the default seed when settings.models is absent", () => {
    expect(readModels({})).toEqual([...MODELS]);
  });

  it("returns the default seed when settings.models is empty", () => {
    expect(readModels({ models: [] })).toEqual([...MODELS]);
  });

  it("returns the default seed when settings.models is not an array", () => {
    expect(readModels({ models: "haiku,sonnet" })).toEqual([...MODELS]);
  });

  it("returns the default seed when the array has no non-empty strings", () => {
    expect(readModels({ models: ["", "  ", 5, null] })).toEqual([...MODELS]);
  });

  it("returns a custom list, trimmed and deduped, order preserved", () => {
    expect(
      readModels({ models: [" opus ", "sonnet", "opus", "", "glm-4.6"] }),
    ).toEqual(["opus", "sonnet", "glm-4.6"]);
  });

  it("does not mutate the MODELS seed (returns a fresh array)", () => {
    const a = readModels({});
    a.push("extra");
    expect(readModels({})).toEqual([...MODELS]);
  });
});

describe("sortByImpressiveness", () => {
  it("orders families least-impressive-first (haiku, sonnet, opus, fable)", () => {
    const apiOrder = [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ];
    expect(sortByImpressiveness(apiOrder)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-fable-5",
    ]);
  });

  it("pushes unknown families to the end, preserving their relative order", () => {
    expect(sortByImpressiveness(["glm-4.6", "claude-opus-4-8", "kimi-k2"])).toEqual([
      "claude-opus-4-8",
      "glm-4.6",
      "kimi-k2",
    ]);
  });
});

describe("family-canonical model identity (API loaded)", () => {
  // _apiModels is module state; reset it so later describes see no API data.
  afterEach(() => setApiModels([]));

  it("readModels returns families, least-to-most impressive", () => {
    setApiModels(API_IDS);
    expect(readModels({})).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });

  it("appends unknown user families after the API set", () => {
    setApiModels(API_IDS);
    expect(readModels({ models: ["glm-4.6"] })).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "fable",
      "glm-4.6",
    ]);
  });

  it("latestIdForFamily resolves a family to its newest full id", () => {
    setApiModels(API_IDS);
    expect(latestIdForFamily("opus")).toBe("claude-opus-4-8");
    expect(latestIdForFamily("fable")).toBe("claude-fable-5");
    expect(latestIdForFamily("glm-4.6")).toBeNull();
  });

  it("modelDisplayLabel shows the latest version for a family", () => {
    setApiModels(API_IDS);
    expect(modelDisplayLabel("opus")).toBe("Opus 4.8");
    expect(modelDisplayLabel("fable")).toBe("Fable 5");
  });
});

describe("modelDisplayLabel without API data", () => {
  it("falls back to the bare family, capitalized", () => {
    setApiModels([]);
    expect(modelDisplayLabel("opus")).toBe("Opus");
    expect(latestIdForFamily("opus")).toBeNull();
  });
});

describe("model identity migration (full id -> family)", () => {
  it("readLastChoice normalizes a stored full id to its family", () => {
    const settings = {
      projectLastChoice: { "/proj": { model: "claude-opus-4-8", effort: "high" } },
    };
    expect(readLastChoice(settings, "/proj")).toEqual({ model: "opus", effort: "high" });
  });
});

describe("readDefaultFlags", () => {
  it("defaults both flags to true when absent", () => {
    expect(readDefaultFlags({})).toEqual({ autoAccept: true, remote: true });
  });

  it("respects explicit false", () => {
    expect(
      readDefaultFlags({ defaultAutoAllow: false, defaultRemoteControl: false }),
    ).toEqual({ autoAccept: false, remote: false });
  });

  it("treats any non-false value as true", () => {
    expect(
      readDefaultFlags({ defaultAutoAllow: true, defaultRemoteControl: 0 }),
    ).toEqual({ autoAccept: true, remote: true });
  });

  it("flips flags independently", () => {
    expect(readDefaultFlags({ defaultAutoAllow: false })).toEqual({
      autoAccept: false,
      remote: true,
    });
  });
});

describe("readLastChoice loosened model validation", () => {
  it("accepts a user-defined model string", () => {
    const settings = {
      projectLastChoice: {
        "/proj": { model: "glm-4.6", effort: "high" },
      },
    };
    expect(readLastChoice(settings, "/proj")).toEqual({
      model: "glm-4.6",
      effort: "high",
    });
  });

  it("still rejects an invalid effort", () => {
    const settings = {
      projectLastChoice: {
        "/proj": { model: "glm-4.6", effort: "bogus" },
      },
    };
    expect(readLastChoice(settings, "/proj")).toBeNull();
  });
});
