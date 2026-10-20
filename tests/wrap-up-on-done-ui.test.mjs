// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { wrapUpChipHtml, wrapUpTooltip } from "../src/views/sessions/sidebar-row-visuals.ts";
import { refreshWrapUpIndicator, SessionHeader } from "../src/views/sessions/session-header.ts";

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

describe("SessionHeader's wrap-up badge lives on the avatar and survives it being rebuilt", () => {
  it("is nested inside .session-header-avatar-wrap, not the icon row, right after construction", () => {
    const header = new SessionHeader({ title: "t", meta: "m" });
    const badge = header.el.querySelector(".session-header-avatar-wrap .wrap-up-btn");
    expect(badge).not.toBeNull();
  });

  it("the SAME button node (and its on state) survives a setAvatar call, which replaces the wrap's innerHTML", () => {
    const header = new SessionHeader({ title: "t", meta: "m" });
    const before = header.el.querySelector(".wrap-up-btn");
    header.setWrapUpOnDone(true);

    // A character swap - exactly what wipes `_wrap.innerHTML` wholesale.
    header.setAvatar("some-char-id", null, "st-done", "/Users/joe/repo", null);

    const after = header.el.querySelector(".session-header-avatar-wrap .wrap-up-btn");
    expect(after).toBe(before); // relocated, never cloned - same node, same listener
    expect(after.classList.contains("is-on")).toBe(true); // state untouched by the rebuild
  });

  it("the badge click fires onWrapUpToggleClick even after a setAvatar rebuild", () => {
    const header = new SessionHeader({ title: "t", meta: "m" });
    header.setAvatar("some-char-id", null, "st-done", "/Users/joe/repo", null);
    let fired = 0;
    header.onWrapUpToggleClick = () => { fired += 1; };
    header.el.querySelector(".wrap-up-btn").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fired).toBe(1);
  });
});
