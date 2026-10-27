// @vitest-environment jsdom
//
// Alt+1-4 picks a model, Alt+Up/Down steps effort, and each press animates
// in the direction it moved (shake at the end of the scale).

import { describe, it, expect } from "vitest";
import { modelKeyTarget, effortStepTarget } from "../src/views/sessions/model-effort-keys.ts";
import { playConfigBump } from "../src/views/sessions/config-bump.ts";
import { normalizeEvent, getBinding } from "../src/shared/shortcuts.ts";

const MODELS = ["haiku", "sonnet", "opus", "fable"];

describe("modelKeyTarget", () => {
  it("Alt+1 from Opus goes down to Haiku, Alt+4 goes up to Fable", () => {
    expect(modelKeyTarget(MODELS, "claude-opus-5-5", 0)).toEqual({ next: "haiku", dir: -1 });
    expect(modelKeyTarget(MODELS, "claude-opus-5-5", 3)).toEqual({ next: "fable", dir: 1 });
  });

  it("the current model's own key changes nothing", () => {
    expect(modelKeyTarget(MODELS, "opus", 2)).toEqual({ next: null, dir: 0 });
  });

  it("a slot past a pruned model list is no target", () => {
    expect(modelKeyTarget(["sonnet", "opus"], "opus", 3)).toBeNull();
  });
});

describe("effortStepTarget", () => {
  it("steps one level each way", () => {
    expect(effortStepTarget("high", 1)).toEqual({ next: "xhigh", dir: 1 });
    expect(effortStepTarget("high", -1)).toEqual({ next: "medium", dir: -1 });
  });

  it("stops at either end", () => {
    expect(effortStepTarget("max", 1)).toEqual({ next: null, dir: 0 });
    expect(effortStepTarget("low", -1)).toEqual({ next: null, dir: 0 });
  });
});

describe("shortcut bindings", () => {
  it("defaults to Alt+1-4 and Alt+Up/Down, matching what a real key event normalizes to", () => {
    const ev = (key) => normalizeEvent({ key, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
    expect(getBinding("set-model-1")).toBe(ev("1"));
    expect(getBinding("set-model-4")).toBe(ev("4"));
    expect(getBinding("effort-up")).toBe(ev("ArrowUp"));
    expect(getBinding("effort-down")).toBe(ev("ArrowDown"));
  });
});

describe("playConfigBump", () => {
  it("animates both the statusline chip and the header value in the moved direction", () => {
    document.body.innerHTML = `
      <div class="session-header"><span class="meta-cfg-effort"></span><span class="meta-cfg-model"></span></div>
      <span class="sb-chip sb-effort"></span><span class="sb-chip sb-model"></span>`;
    playConfigBump("effort", 1);
    expect(document.querySelector(".sb-effort").classList.contains("cfg-bump-up")).toBe(true);
    expect(document.querySelector(".meta-cfg-effort").classList.contains("cfg-bump-up")).toBe(true);
    expect(document.querySelector(".sb-model").classList.contains("cfg-bump-up")).toBe(false);
    playConfigBump("effort", -1);
    expect(document.querySelector(".sb-effort").className).toContain("cfg-bump-down");
    expect(document.querySelector(".sb-effort").className).not.toContain("cfg-bump-up");
    playConfigBump("model", 0);
    expect(document.querySelector(".sb-model").classList.contains("cfg-bump-edge")).toBe(true);
  });
});
