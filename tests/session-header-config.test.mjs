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

// Desktop folds model and effort into one battery: tinted by effort, named in its
// tooltip, and a click lists both with a way into each slider.
describe("session header desktop battery", () => {
  const combo = () => header.el.querySelector(".meta-cfg-combo");
  const popover = () => document.querySelector(".meta-cfg-popover");
  const comboBattery = () => combo().querySelector(".meta-cfg-combo-battery");

  it("is the model's rank battery, tinted by effort, named in its tooltip and label", () => {
    header.setConfig("claude-sonnet-5", "medium");
    expect(combo().hidden).toBe(false);
    expect(comboBattery().classList.contains("ph-battery-medium")).toBe(true);
    expect(comboBattery().dataset.batteryEffort).toBe("medium");
    expect(combo().dataset.tip).toBe("Sonnet 5 · medium");
    expect(combo().getAttribute("aria-label")).toContain("Sonnet 5 · medium");
    // High is the default and keeps the battery's own grey.
    header.setConfig("claude-opus-5", "high");
    expect(comboBattery().dataset.batteryEffort).toBeUndefined();
    expect(combo().dataset.tip).toBe("Opus 5 · high");
  });

  it("hides when there is neither a model nor an effort, and keeps the same node across updates", () => {
    const node = combo();
    header.setConfig(null, "");
    expect(combo().hidden).toBe(true);
    header.setConfig("claude-opus-5", "high");
    expect(combo()).toBe(node);
  });

  it("opens a popover with both values on click, and a row opens that slider anchored to the battery", () => {
    header.setConfig("claude-opus-5", "high");
    const seen = [];
    header.onConfigClick = (which, anchor) => seen.push([which, anchor]);
    combo().click();
    expect(popover().textContent).toContain("Opus 5");
    expect(popover().textContent).toContain("high");
    expect(combo().classList.contains("on")).toBe(true);
    popover().querySelector('[data-which="effort"]').click();
    expect(popover()).toBeNull();
    expect(combo().classList.contains("on")).toBe(false);
    // Anchored on a sibling overlay, never the battery: a click inside the anchor's tree counts as
    // inside the slider, so a later click on the battery would leave both popovers open.
    const anchor = header.el.querySelector(".meta-cfg-anchor");
    expect(seen).toEqual([["effort", anchor]]);
    expect(anchor.contains(combo())).toBe(false);
  });

  it("a second click closes it, and a changed config repaints it in place", () => {
    header.setConfig("claude-opus-5", "high");
    combo().click();
    expect(combo().getAttribute("aria-expanded")).toBe("true");
    header.setConfig("claude-sonnet-5", "low");
    expect(popover().textContent).toContain("Sonnet 5");
    expect(popover().textContent).toContain("low");
    combo().click();
    expect(popover()).toBeNull();
    expect(combo().getAttribute("aria-expanded")).toBe("false");
  });

  it("an unchanged config re-emit leaves the open popover's nodes alone", () => {
    header.setConfig("claude-opus-5", "high");
    combo().click();
    const node = popover();
    const row = node.querySelector(".mcp-row");
    header.setConfig("claude-opus-5", "high");
    expect(popover()).toBe(node);
    expect(popover().querySelector(".mcp-row")).toBe(row);
  });

  it("closes on a click elsewhere even when that click's own handler stops propagation", () => {
    header.setConfig("claude-opus-5", "high");
    const chip = document.createElement("button");
    chip.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(chip);
    combo().click();
    expect(popover()).not.toBeNull();
    chip.click();
    expect(popover()).toBeNull();
  });

  it("a keyboard open moves focus to the first row, a pointer open does not", () => {
    header.setConfig("claude-opus-5", "high");
    combo().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(popover().querySelector(".mcp-row"));
    combo().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(popover()).toBeNull();
    // click() has detail 0, the same as Enter or Space on a button.
    combo().click();
    expect(popover().getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(popover().querySelector(".mcp-row"));
  });

  it("shows a locked effort as plain text, not a button", () => {
    header.setConfig("claude-opus-5", "high", false);
    combo().click();
    expect(popover().querySelector('[data-which="effort"]')).toBeNull();
    expect(popover().textContent).toContain("high");
    expect(popover().querySelector('[data-which="model"]')).not.toBeNull();
  });
});

// One line on desktop; the phone keeps its two. The sub count is the phone's way into the sub list.
describe("session header desktop layout", () => {
  const css = readFileSync("src/views/sessions/session-header.css", "utf8");
  const desktop = css.slice(css.indexOf("@media (min-width: 769px)"));

  it("lays title and project on one row and drops the two-word model/effort and the trail", () => {
    expect(desktop).toMatch(/\.session-header \.session-header-text \{\s*flex-direction: row;/);
    expect(desktop).toMatch(/\.session-header \.session-header-trail:not\(:empty\) \{ display: none; \}/);
    expect(desktop).toMatch(/\.session-header \.meta-cfg-model,\s*\.session-header \.meta-cfg-effort,\s*\.session-header \.meta-cfg-sep \{ display: none; \}/);
  });

  it("keeps the battery off the phone, which has its own", () => {
    expect(css).toMatch(/\.session-header \.meta-cfg-combo,\s*\.session-header \.meta-cfg-anchor \{ display: none; \}/);
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
