// @vitest-environment jsdom

// A single configured model (an account limited to one family, or a
// user-pruned settings.models list) is a confirmation, not a choice (todo
// 930, same reasoning as the account popover: listCachedAccounts().length
// <= 1). The slider never mounts; the popover just names the model.

import { describe, it, expect, afterEach } from "vitest";
import { ModelPopover, hasModelChoice } from "../src/views/sessions/model-popover.ts";
import { setApiModels } from "../src/shared/effort-presets.ts";

function anchor() {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  setApiModels([]); // reset the module-level API model cache between tests
  document.body.innerHTML = "";
});

describe("hasModelChoice", () => {
  it("is false for zero models", () => {
    expect(hasModelChoice([])).toBe(false);
  });

  it("is false for exactly one model", () => {
    expect(hasModelChoice(["opus"])).toBe(false);
  });

  it("is true for two or more models", () => {
    expect(hasModelChoice(["opus", "sonnet"])).toBe(true);
    expect(hasModelChoice(["opus", "sonnet", "haiku"])).toBe(true);
  });
});

describe("ModelPopover.open - exactly one model configured", () => {
  it("renders a static name, no slider", () => {
    setApiModels(["claude-opus-4-8"]); // account limited to one family
    const popover = new ModelPopover();
    popover.open(anchor(), { model: "opus", sessionId: "s1", onCommit: () => {} });
    const el = document.querySelector(".sb-model-popover");
    expect(el).not.toBeNull();
    expect(el.querySelector("input[type=\"range\"]")).toBeNull();
    expect(el.querySelector(".sb-model-popover-name")).not.toBeNull();
  });
});

describe("ModelPopover.open - two or more models (unchanged)", () => {
  it("renders the interactive slider with one stop per model", () => {
    setApiModels(["claude-opus-4-8", "claude-sonnet-4-5"]);
    const popover = new ModelPopover();
    popover.open(anchor(), { model: "opus", sessionId: "s1", onCommit: () => {} });
    const el = document.querySelector(".sb-model-popover");
    expect(el.querySelector("input[type=\"range\"]")).not.toBeNull();
    expect(el.querySelectorAll(".sb-model-stop").length).toBe(2);
  });
});
