// @vitest-environment jsdom

// A draft chat's header carries no quick "Discard draft" X (Joe, 2026-10-23:
// "we dont need it"); the view-more menu's "Delete draft" and the sidebar row's
// context menu drop a draft instead.

import { describe, it, expect } from "vitest";
import { SessionHeader } from "../src/views/sessions/session-header.ts";

describe("session header: draft chrome", () => {
  it("renders no discard button", () => {
    const header = new SessionHeader({ title: "New chat", meta: "alpha" });
    expect(header.el.querySelector(".discard-btn")).toBeNull();
    expect(header.el.querySelector(".ph-x-circle")).toBeNull();
  });
});
