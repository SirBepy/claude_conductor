// asserts: src/shared/tracker-icons.ts, src/shared/formatters.ts, src/shared/chat/dashboard/links-model.ts, src/views/sessions/drafts-panel-render.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts

// The tracker marks (outline line art, one stroke weight) replace the plain ticket glyph wherever
// a ticket is shown, and a ticket is told apart by its address or the way its id is written.

import { describe, it, expect } from "vitest";

const { trackerSvg, trackerOfUrl, ticketIdIn, TRACKER_NAME } = await import("../src/shared/tracker-icons.ts");
const { classifyUrl } = await import("../src/shared/chat/dashboard/links-model.ts");
const { shortDateTime } = await import("../src/shared/formatters.ts");

describe("tracker marks", () => {
  it("draws every tracker as one outline mark in the current colour", () => {
    for (const mark of Object.keys(TRACKER_NAME)) {
      const svg = trackerSvg(mark);
      expect(svg, mark).toContain('stroke="currentColor"');
      expect(svg, mark).toContain('fill="none"');
      expect(svg, mark).toContain('stroke-width="1.75"');
      expect(svg, mark).toMatch(/<(path|circle)\b/);
    }
    expect(Object.keys(TRACKER_NAME).sort()).toEqual(["clickup", "jira", "linear", "shortcut", "trello"]);
  });

  it("names the tracker an address belongs to, Jira and ClickUp included", () => {
    expect(trackerOfUrl("https://app.shortcut.com/acme/story/12345/x")).toBe("shortcut");
    expect(trackerOfUrl("https://linear.app/acme/issue/ABC-1/t")).toBe("linear");
    expect(trackerOfUrl("https://acme.atlassian.net/browse/PROJ-9")).toBe("jira");
    expect(trackerOfUrl("https://trello.com/c/AbCd1234")).toBe("trello");
    expect(trackerOfUrl("https://app.clickup.com/t/86abc12")).toBe("clickup");
    expect(trackerOfUrl("https://github.com/acme/app/issues/7")).toBeNull();
    expect(trackerOfUrl("not a url")).toBeNull();
  });

  it("calls a ClickUp task link a ticket", () => {
    expect(classifyUrl("https://app.clickup.com/t/86abc12")).toEqual({ kind: "ticket", label: "Task 86abc12" });
  });
});

describe("a ticket id written in a sub's name", () => {
  it("reads Shortcut's own spelling and a team key, and leaves prose numbers alone", () => {
    expect(ticketIdIn("sc-56709 invite modal")).toEqual({ id: "sc-56709", tracker: "shortcut" });
    expect(ticketIdIn("Fix ENG-123 retry")).toEqual({ id: "ENG-123", tracker: "linear" });
    expect(ticketIdIn("ISO-8601 dates")).toBeNull();
    expect(ticketIdIn("utf-8 and gpt-4")).toBeNull();
    expect(ticketIdIn("pc-1804 run lanes")).toBeNull();
  });
});

describe("the short date", () => {
  it("is day, month, a dash, then a 12 hour clock with AM or PM", () => {
    expect(shortDateTime(new Date(2026, 10, 23, 15, 17).getTime())).toBe("23 Nov - 3:17PM");
    expect(shortDateTime(new Date(2026, 0, 2, 0, 5).getTime())).toBe("2 Jan - 12:05AM");
    expect(shortDateTime(new Date(2026, 5, 9, 12, 0).getTime())).toBe("9 Jun - 12:00PM");
  });
});
