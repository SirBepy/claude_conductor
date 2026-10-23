// @vitest-environment jsdom

// The header's model/effort are the only surface left for changing either
// mid-run (the Sep 4 statusline rebuild dropped both chips from the default
// rows). The statusbar re-emits its config on EVERY render, so the two spans
// must be text/icon-swapped, never rebuilt - a replaced node silently detaches
// the slider popover anchored to it.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { SessionHeader } from "../src/views/sessions/session-header.ts";

let header;

beforeEach(() => {
  document.body.innerHTML = "";
  header = new SessionHeader({ title: "Alpha chat", meta: "alpha" });
  document.body.appendChild(header.el);
});

const modelEl = () => header.el.querySelector(".meta-cfg-model");
const effortEl = () => header.el.querySelector(".meta-cfg-effort");
const battery = () => modelEl().querySelector(".meta-cfg-model-battery");
const shortEffort = () => effortEl().querySelector(".meta-cfg-effort-short");

describe("session header config", () => {
  it("prints the model name and effort word (desktop), with a rank battery and short effort for the phone", () => {
    header.setConfig("claude-opus-5", "high");
    expect(modelEl().querySelector(".meta-cfg-model-text").textContent).toBe("Opus 5");
    expect(battery().classList.contains("ph-battery-high")).toBe(true);
    expect(effortEl().querySelector(".meta-cfg-effort-full").textContent).toBe("high");
    expect(shortEffort().textContent).toBe("high");
    expect(effortEl().dataset.effort).toBe("high");
  });

  it("battery follows the model family and the phone effort word is 3-4 letters", () => {
    const rows = [["claude-haiku-5", "low", "ph-battery-low", "low"], ["claude-sonnet-5", "medium", "ph-battery-medium", "mid"],
      ["claude-opus-5", "xhigh", "ph-battery-high", "xhi"], ["claude-fable-5", "max", "ph-battery-full", "max"]];
    for (const [m, e, icon, word] of rows) {
      header.setConfig(m, e);
      expect(battery().classList.contains(icon)).toBe(true);
      expect(shortEffort().textContent).toBe(word);
    }
  });

  it("keeps the same nodes across repeated setConfig calls", () => {
    header.setConfig("claude-opus-5", "high");
    const model = modelEl();
    const effort = effortEl();
    const short = shortEffort();
    header.setConfig("claude-sonnet-5", "max");
    expect(modelEl()).toBe(model);
    expect(effortEl()).toBe(effort);
    expect(shortEffort()).toBe(short);
    expect(model.textContent).toContain("Sonnet 5");
    expect(effort.dataset.effort).toBe("max");
  });

  it("routes a click on either to onConfigClick with that element as anchor", () => {
    header.setConfig("claude-opus-5", "high");
    const seen = [];
    header.onConfigClick = (which, anchor) => seen.push([which, anchor]);

    modelEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    shortEffort().dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(seen).toEqual([["model", modelEl()], ["effort", effortEl()]]);
  });

  it("drops the effort affordance when the session is read-only", () => {
    header.setConfig("claude-opus-5", "high", false);
    let fired = 0;
    header.onConfigClick = () => { fired += 1; };

    effortEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(effortEl().classList.contains("meta-cfg-btn")).toBe(false);
    expect(effortEl().hasAttribute("tabindex")).toBe(false);
    expect(fired).toBe(0);
    // Locked, it still names the level on hover.
    expect(effortEl().title).toBe("Effort high");
    // The model half stays clickable - only effort is locked on an external session.
    expect(modelEl().classList.contains("meta-cfg-btn")).toBe(true);
  });

  it("names the model in its tooltip", () => {
    header.setConfig("claude-opus-5", "high");
    expect(modelEl().title).toBe("Opus 5: change model");
  });

  it("an unranked model family shows its name on the phone instead of an empty battery", () => {
    header.setConfig("claude-mystery-9", "high");
    expect(modelEl().hidden).toBe(false);
    expect(modelEl().classList.contains("no-rank")).toBe(true);
    header.setConfig("claude-opus-5", "high");
    expect(modelEl().classList.contains("no-rank")).toBe(false);
    const css = readFileSync("src/views/sessions/session-header.css", "utf8");
    expect(css).toMatch(/\.meta-cfg-model\.no-rank \.meta-cfg-model-text \{ display: inline; \}/);
  });

  it("hides a half that has no value", () => {
    header.setConfig(null, "high");
    expect(modelEl().hidden).toBe(true);
    expect(modelEl().classList.contains("meta-cfg-btn")).toBe(false);
    header.setConfig("claude-opus-5", "");
    expect(effortEl().hidden).toBe(true);
  });
});

// Code mode moved into the chat FAB menu (fab-dial.ts), so the header carries
// no `</>` button on any screen size.
describe("session header Code mode button", () => {
  it("is gone from the header", () => {
    expect(header.el.querySelector(".code-mode-btn")).toBeNull();
    expect(header.onCodeModeClick).toBeUndefined();
  });
});

// The short effort word is uncoloured on the phone: the word already names the
// level (Joe, 2026-10-23).
describe("session header effort colour", () => {
  it("does not colour the effort word by level", () => {
    const css = readFileSync("src/views/sessions/session-header.css", "utf8");
    expect(css).not.toMatch(/meta-cfg-effort\[data-effort/);
  });
});
