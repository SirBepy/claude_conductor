// @vitest-environment jsdom

// The Chats window's global rail group: which entry each router view lights up,
// what the group renders, and that a click routes in-window (the window is the
// app's one desktop window, so Dashboard/Schedule/Settings must be reachable from it).

import { describe, it, expect, vi, beforeEach } from "vitest";

const showView = vi.fn();
const openJarvisSafely = vi.fn();
vi.mock("../src/shared/navigation.ts", () => ({ showView, getActiveView: () => "sessions" }));
vi.mock("../src/shared/open-jarvis-safely.ts", () => ({ openJarvisSafely }));
vi.mock("../src/shared/transport.ts", () => ({ isTauri: () => true }));
vi.mock("../src/views/sessions/split-panels/split.css", () => ({}));
vi.mock("../src/shared/app-rail.css", () => ({}));

const rail = await import("../src/shared/app-rail.ts");

beforeEach(() => {
  showView.mockClear();
  openJarvisSafely.mockClear();
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
  it("renders Jarvis then Dashboard, Schedule and Settings as plain icons, with no News entry", () => {
    const host = document.createElement("div");
    host.innerHTML = rail.globalGroupHtml("dashboard");
    const jarvis = host.querySelector("[data-rail-jarvis]");
    expect(jarvis).not.toBeNull();
    // A plain strip tab: no bespoke orb styling to shout over its neighbours.
    expect(jarvis.classList.contains("sp-tab")).toBe(true);
    expect(host.querySelector('[data-rail-go="dashboard"] i').classList.contains("ph-squares-four")).toBe(true);
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

  it("opens Jarvis through the shared safe opener", () => {
    const host = document.createElement("div");
    host.innerHTML = rail.globalGroupHtml("sessions");
    expect(rail.handleRailClick(host.querySelector("[data-rail-jarvis] i"))).toBe(true);
    expect(openJarvisSafely).toHaveBeenCalledTimes(1);
    expect(showView).not.toHaveBeenCalled();
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
