// @vitest-environment jsdom

// The header's model/effort text is the only surface left for changing either
// mid-run (the Sep 4 statusline rebuild dropped both chips from the default
// rows). The statusbar re-emits its config on EVERY render, so the two spans
// must be text-swapped, never rebuilt - a replaced node silently detaches the
// slider popover anchored to it.

import { describe, it, expect, beforeEach } from "vitest";
import { SessionHeader } from "../src/views/sessions/session-header.ts";

let header;

beforeEach(() => {
  document.body.innerHTML = "";
  header = new SessionHeader({ title: "Alpha chat", meta: "alpha" });
  document.body.appendChild(header.el);
});

const modelEl = () => header.el.querySelector(".meta-cfg-model");
const effortEl = () => header.el.querySelector(".meta-cfg-effort");

describe("session header config text", () => {
  it("prints the short model name and effort, separated", () => {
    header.setConfig("claude-opus-5", "high");
    expect(modelEl().textContent).toBe("Opus 5");
    expect(effortEl().textContent).toBe("high");
    expect(header.el.querySelector(".meta-cfg-sep").hidden).toBe(false);
  });

  it("keeps the same nodes across repeated setConfig calls", () => {
    header.setConfig("claude-opus-5", "high");
    const model = modelEl();
    const effort = effortEl();
    header.setConfig("claude-sonnet-5", "max");
    expect(modelEl()).toBe(model);
    expect(effortEl()).toBe(effort);
    expect(model.textContent).toBe("Sonnet 5");
    expect(effort.textContent).toBe("max");
  });

  it("routes a click on either to onConfigClick with that element as anchor", () => {
    header.setConfig("claude-opus-5", "high");
    const seen = [];
    header.onConfigClick = (which, anchor) => seen.push([which, anchor]);

    modelEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    effortEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));

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
    // The model half stays clickable - only effort is locked on an external session.
    expect(modelEl().classList.contains("meta-cfg-btn")).toBe(true);
  });

  it("hides the separator and the affordance when a half is empty", () => {
    header.setConfig(null, "high");
    expect(header.el.querySelector(".meta-cfg-sep").hidden).toBe(true);
    expect(modelEl().classList.contains("meta-cfg-btn")).toBe(false);
  });
});
