// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { wrapUpChipHtml } from "../src/views/sessions/sidebar-row-visuals.ts";
import { wrapUpTooltip, refreshWrapUpIndicator } from "../src/views/sessions/session-header.ts";

describe("wrapUpChipHtml (sidebar row chip)", () => {
  it("renders nothing when off", () => {
    expect(wrapUpChipHtml(false, "data-tip")).toBe("");
  });

  it("renders the flag chip with a tooltip when on", () => {
    const html = wrapUpChipHtml(true, "data-tip");
    expect(html).toContain("wrap-up-chip");
    expect(html).toContain("ph-flag-checkered");
    expect(html).toContain('data-tip="');
  });
});

describe("wrapUpTooltip (shared header/row/menu wording)", () => {
  it("names the shortcut and the on/off state distinctly", () => {
    const on = wrapUpTooltip(true);
    const off = wrapUpTooltip(false);
    expect(on).toContain("Ctrl+Shift+W");
    expect(off).toContain("Ctrl+Shift+W");
    expect(on).toContain("ON");
    expect(on).not.toBe(off);
  });
});

describe("refreshWrapUpIndicator (live header update from the menu/shortcut path)", () => {
  function mountHeaderButton() {
    document.body.innerHTML = `<div class="session-pane"><button class="wrap-up-btn"></button></div>`;
    return document.querySelector(".wrap-up-btn");
  }

  it("does nothing when the toggled session isn't the one on screen", () => {
    const btn = mountHeaderButton();
    refreshWrapUpIndicator("other-session", "sess-1", true);
    expect(btn.classList.contains("is-on")).toBe(false);
  });

  it("updates the mounted button's class and title when the session matches", () => {
    const btn = mountHeaderButton();
    refreshWrapUpIndicator("sess-1", "sess-1", true);
    expect(btn.classList.contains("is-on")).toBe(true);
    expect(btn.title).toContain("ON");

    refreshWrapUpIndicator("sess-1", "sess-1", false);
    expect(btn.classList.contains("is-on")).toBe(false);
    expect(btn.title).not.toContain("ON");
  });

  it("is a no-op when no header is mounted", () => {
    document.body.innerHTML = "";
    expect(() => refreshWrapUpIndicator("sess-1", "sess-1", true)).not.toThrow();
  });
});
