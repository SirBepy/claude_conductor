// @vitest-environment jsdom

// Dashboard and Schedule are a side panel of the Chats window, so every route
// into them (rail click, tray event, cold-start drain, internal showView) must
// land in the panel, stepping back to Chats first from any other full view.
// Anywhere but the Chats window the router views stay as they were.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/sidemenu.ts", () => ({ updateSidemenuActive: () => {} }));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: async () => true }));

const nav = await import("../src/shared/navigation.ts");
const panel = await import("../src/shared/global-panel.ts");

const navigateTo = vi.fn();

beforeEach(() => {
  navigateTo.mockClear();
  window.navigateTo = navigateTo;
  panel.setGlobalPanel(null);
  nav.setActiveView("sessions");
  document.body.className = "";
});

describe("showView in the Chats window", () => {
  beforeEach(() => document.body.classList.add("chats-window-mode"));

  it("opens Dashboard and Schedule as the panel without routing away from Chats", () => {
    nav.showView("dashboard");
    expect(panel.getGlobalPanel()).toBe("dashboard");
    nav.showView("schedule");
    expect(panel.getGlobalPanel()).toBe("schedule");
    expect(navigateTo).not.toHaveBeenCalled();
    expect(nav.getActiveView()).toBe("sessions");
  });

  it("steps back to Chats first when another full view is showing", () => {
    nav.setActiveView("history");
    nav.showView("dashboard");
    expect(panel.getGlobalPanel()).toBe("dashboard");
    expect(navigateTo).toHaveBeenCalledTimes(1);
    expect(navigateTo).toHaveBeenCalledWith("sessions");
  });

  it("still routes every other view", () => {
    nav.showView("settings");
    expect(navigateTo).toHaveBeenCalledWith("settings");
    expect(panel.getGlobalPanel()).toBeNull();
  });

  it("tells a listening split when the panel opens and closes", () => {
    const seen = [];
    const off = panel.onGlobalPanelChange(() => seen.push(panel.getGlobalPanel()));
    nav.showView("dashboard");
    panel.setGlobalPanel("dashboard");
    panel.setGlobalPanel(null);
    off();
    panel.setGlobalPanel("schedule");
    expect(seen).toEqual(["dashboard", null]);
  });
});

describe("showView outside the Chats window", () => {
  it("keeps Dashboard and Schedule as full views", () => {
    nav.showView("dashboard");
    expect(navigateTo).toHaveBeenCalledWith("dashboard");
    expect(panel.getGlobalPanel()).toBeNull();
    expect(nav.getActiveView()).toBe("dashboard");
  });
});
