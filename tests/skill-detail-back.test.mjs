// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";

// The Skills list screen has no entry point, so skill-detail's Back arrow must
// not route there: it closes the settings popup it sits in, or returns to the
// view the detail was opened from.

const nav = vi.hoisted(() => ({ active: "sessions", shown: [] }));
const popup = vi.hoisted(() => ({ open: false, closed: 0 }));
vi.mock("../src/shared/navigation.ts", () => ({
  getActiveView: () => nav.active,
  showView: (v) => { nav.shown.push(v); },
}));
vi.mock("../src/shared/settings-popup.ts", () => ({
  isSettingsPopupOpen: () => popup.open,
  closeSettingsPopup: () => { popup.closed++; },
}));

const { openSkillDetail, leaveSkillDetail } = await import("../src/shared/open-skill-detail.ts");

beforeEach(() => {
  nav.active = "sessions";
  nav.shown = [];
  popup.open = false;
  popup.closed = 0;
});

describe("skill-detail Back", () => {
  it("returns to the view the detail was opened from, never to the Skills list", () => {
    nav.active = "history";
    openSkillDetail("deploy");
    nav.active = "skill-detail";
    nav.shown = [];
    leaveSkillDetail();
    expect(nav.shown).toEqual(["history"]);
  });

  it("opening a second skill from the detail keeps the original way back", () => {
    nav.active = "sessions";
    openSkillDetail("a");
    nav.active = "skill-detail";
    openSkillDetail("b");
    nav.shown = [];
    leaveSkillDetail();
    expect(nav.shown).toEqual(["sessions"]);
  });

  it("closes the settings popup when the detail sits in one", () => {
    popup.open = true;
    leaveSkillDetail();
    expect(popup.closed).toBe(1);
    expect(nav.shown).toEqual([]);
  });
});
