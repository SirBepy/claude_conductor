// @vitest-environment jsdom

// The Chats window's global rail group: which entry each router view lights up,
// what the group renders, and that a click routes in-window (the window is the
// app's one desktop window, so Home/Schedule/Settings must be reachable from it).

import { describe, it, expect, vi, beforeEach } from "vitest";

const showView = vi.fn();
vi.mock("../src/shared/navigation.ts", () => ({ showView, getActiveView: () => "sessions" }));
vi.mock("../src/shared/transport.ts", () => ({ isTauri: () => true }));
vi.mock("../src/views/sessions/split-panels/split.css", () => ({}));
vi.mock("../src/shared/app-rail.css", () => ({}));

const rail = await import("../src/shared/app-rail.ts");

beforeEach(() => {
  showView.mockClear();
  document.body.className = "";
  document.body.innerHTML = "";
});

describe("railActiveFor", () => {
  it("lights the matching global entry", () => {
    expect(rail.railActiveFor("dashboard")).toBe("dashboard");
    expect(rail.railActiveFor("schedule")).toBe("schedule");
  });

  it("files every settings page, and the detail pages Settings links to, under Settings", () => {
    for (const v of ["settings", "settings-accounts", "settings-characters", "characters", "character-detail", "skills", "skill-detail"]) {
      expect(rail.railActiveFor(v), v).toBe("settings");
    }
  });

  it("files Chats and History under Chats, and unknown views under nothing", () => {
    expect(rail.railActiveFor("sessions")).toBe("sessions");
    expect(rail.railActiveFor("history")).toBe("sessions");
    expect(rail.railActiveFor("nope")).toBeNull();
  });
});

describe("globalGroupHtml", () => {
  it("renders Jarvis then Home, Schedule and Settings, with no News entry", () => {
    const host = document.createElement("div");
    host.innerHTML = rail.globalGroupHtml("dashboard");
    expect(host.querySelector("[data-rail-jarvis]")).not.toBeNull();
    expect([...host.querySelectorAll("[data-rail-go]")].map((e) => e.dataset.railGo)).toEqual(["dashboard", "schedule", "settings"]);
    expect(host.querySelector('[data-rail-go="dashboard"]').classList.contains("is-on")).toBe(true);
    expect(host.querySelector('[data-rail-go="schedule"]').classList.contains("is-on")).toBe(false);
    expect(host.innerHTML).not.toMatch(/news/i);
  });
});

describe("handleRailClick", () => {
  it("routes a global entry in-window", () => {
    const host = document.createElement("div");
    host.innerHTML = rail.globalGroupHtml("sessions");
    expect(rail.handleRailClick(host.querySelector('[data-rail-go="settings"] i'))).toBe(true);
    expect(showView).toHaveBeenCalledWith("settings");
  });

  it("ignores clicks that are not on a rail control", () => {
    expect(rail.handleRailClick(document.createElement("div"))).toBe(false);
    expect(showView).not.toHaveBeenCalled();
  });
});

describe("standalone rail", () => {
  it("shows off Chats, hides while a split strip carries the group, and offers a way back to Chats", () => {
    rail.mountAppRail();
    const solo = document.getElementById("app-rail");
    rail.syncAppRail("dashboard");
    expect(solo.hidden).toBe(false);
    expect(solo.querySelector('[data-rail-go="sessions"]')).not.toBeNull();
    expect(document.body.classList.contains("app-rail-solo")).toBe(true);

    // On Chats with no strip (no chat open) the column still has to be there.
    rail.syncAppRail("sessions");
    expect(solo.hidden).toBe(false);

    rail.announceSplitStrip(true);
    expect(solo.hidden).toBe(true);
    expect(document.body.classList.contains("app-rail-solo")).toBe(false);

    // Leaving Chats brings it back even though the strip event said "present".
    rail.syncAppRail("settings");
    expect(solo.hidden).toBe(false);
  });
});
