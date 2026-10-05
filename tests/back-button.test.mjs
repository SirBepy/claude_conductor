import { describe, it, expect, beforeEach } from "vitest";
import {
  noteNavigation,
  registerOverlayBack,
  handleBack,
  resetBackButtonForTests,
  viewStackForTests,
} from "../src/shared/back-button.ts";

// The phone's hardware back button used to close the app because the hash
// router pushed no real history entries. back-button.ts traps back and routes
// each press through handleBack(): close the top overlay, else step back a
// view, else stay put (never exit). These cover the routing logic without a DOM
// (the popstate trap is a thin shell over handleBack).

let navCalls;

beforeEach(() => {
  resetBackButtonForTests();
  navCalls = [];
  // goBackView() reads window.navigateTo; stub it to record where back went.
  globalThis.window = { navigateTo: (n) => { navCalls.push(n); } };
});

describe("view-navigation stack", () => {
  it("pushes fresh views and ignores consecutive duplicates", () => {
    noteNavigation("dashboard");
    noteNavigation("sessions");
    noteNavigation("sessions");
    noteNavigation("news");
    expect(viewStackForTests()).toEqual(["dashboard", "sessions", "news"]);
  });

  it("rewinds when navigating to a view already in the stack", () => {
    // Mirrors an in-screen Back button: returning to an earlier view must not
    // leave a forward entry that hardware-back would bounce into.
    ["dashboard", "project-detail", "project-sessions"].forEach(noteNavigation);
    noteNavigation("project-detail");
    expect(viewStackForTests()).toEqual(["dashboard", "project-detail"]);
  });
});

describe("handleBack view stepping", () => {
  it("steps back to the previous view and pops the stack", () => {
    ["dashboard", "sessions"].forEach(noteNavigation);
    handleBack();
    expect(navCalls).toEqual(["dashboard"]);
    expect(viewStackForTests()).toEqual(["dashboard"]);
  });

  it("never navigates (never exits) on the chats list root", () => {
    noteNavigation("sessions");
    handleBack();
    expect(navCalls).toEqual([]);
    expect(viewStackForTests()).toEqual(["sessions"]);
  });

  it("falls back to the chats list from any other root view", () => {
    noteNavigation("settings");
    handleBack();
    expect(navCalls).toEqual(["sessions"]);
    expect(viewStackForTests()).toEqual(["sessions"]);
    handleBack();
    expect(navCalls).toEqual(["sessions"]);
  });
});

describe("overlay back handlers", () => {
  it("consumes back when an overlay handler returns true, skipping view back", () => {
    ["dashboard", "sessions"].forEach(noteNavigation);
    let closed = false;
    registerOverlayBack(() => { closed = true; return true; });
    handleBack();
    expect(closed).toBe(true);
    expect(navCalls).toEqual([]); // view back NOT reached
    expect(viewStackForTests()).toEqual(["dashboard", "sessions"]);
  });

  it("falls through to view back when the overlay handler returns false", () => {
    ["dashboard", "sessions"].forEach(noteNavigation);
    registerOverlayBack(() => false);
    handleBack();
    expect(navCalls).toEqual(["dashboard"]);
  });

  it("consults overlays most-recent-first (LIFO)", () => {
    noteNavigation("dashboard");
    const order = [];
    registerOverlayBack(() => { order.push("first"); return false; });
    registerOverlayBack(() => { order.push("second"); return true; });
    handleBack();
    expect(order).toEqual(["second"]); // second wins before first is consulted
  });

  it("stops consulting a disposed overlay", () => {
    ["dashboard", "sessions"].forEach(noteNavigation);
    const dispose = registerOverlayBack(() => true);
    dispose();
    handleBack();
    expect(navCalls).toEqual(["dashboard"]); // overlay gone, view back runs
  });
});
