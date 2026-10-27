// @vitest-environment jsdom
//
// The Alt+1-4 model shortcuts are named after, and ranged by, the live model
// list the handler indexes (readModels), not a fixed Haiku/Sonnet/Opus/Fable.

import { describe, it, expect, afterEach } from "vitest";
import { setApiModels } from "../src/shared/effort-presets.ts";
import { modelShortcutHint, modelShortcutLabel } from "../src/shared/model-shortcuts.ts";
import { renderShortcutsView } from "../src/views/settings/subviews/shortcuts/shortcuts.ts";

afterEach(() => setApiModels([]));

describe("a 3-family model list", () => {
  const THREE = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"];

  it("names three slots after those families and nothing for Alt+4", () => {
    setApiModels(THREE);
    expect([0, 1, 2, 3].map((s) => modelShortcutLabel(s))).toEqual(["Model: Haiku", "Model: Sonnet", "Model: Opus", null]);
    expect(modelShortcutHint()).toBe("Alt 1-3");
  });

  it("Settings lists three model shortcuts, not four", async () => {
    setApiModels(THREE);
    const root = document.createElement("div");
    const dispose = await renderShortcutsView(root);
    const rows = [...root.querySelectorAll('.shortcut-row[data-id^="set-model-"]')];
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["set-model-1", "set-model-2", "set-model-3"]);
    dispose();
  });

  it("a list without Sonnet renames slot 2", () => {
    setApiModels(["claude-haiku-4-5", "claude-opus-4-5", "claude-fable-1"]);
    expect(modelShortcutLabel(1)).toBe("Model: Opus");
  });
});

it("the seed list keeps the four labels and Alt 1-4", () => {
  expect([0, 1, 2, 3].map((s) => modelShortcutLabel(s))).toEqual(["Model: Haiku", "Model: Sonnet", "Model: Opus", "Model: Fable"]);
  expect(modelShortcutHint()).toBe("Alt 1-4");
});
