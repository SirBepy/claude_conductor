// A due after-meeting item is held by the daemon, not late: the panel must
// read it as waiting and mark every after-meeting row, while an ordinary
// overdue item stays exactly as it was.

import { describe, it, expect } from "vitest";
// schedule-state first: it and schedule-format import each other, and only this
// entry order evaluates MONTH_NAMES before state uses it.
import "../src/views/schedule/schedule-state";
import { isWaitingForMeeting, meetingMarker, meetingDrawer } from "../src/views/schedule/schedule-format";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const HOUR = 3600 * 1000;

const item = (over = {}) => ({
  id: "i1",
  kind: { type: "message", session_id: "s1" },
  prompt: "p",
  fire_at: new Date(NOW - 60 * 1000).toISOString(),
  recurrence: null,
  status: { type: "pending" },
  created_at: new Date(NOW - HOUR).toISOString(),
  last_fired_at: null,
  last_result: null,
  last_session_id: null,
  guard: null,
  last_skip: null,
  after_meeting: true,
  ...over,
});

describe("isWaitingForMeeting", () => {
  it("is true for a due pending after-meeting item", () => {
    expect(isWaitingForMeeting(item(), NOW)).toBe(true);
  });

  it("is false for an ordinary overdue item", () => {
    expect(isWaitingForMeeting(item({ after_meeting: undefined }), NOW)).toBe(false);
    expect(isWaitingForMeeting(item({ after_meeting: false }), NOW)).toBe(false);
  });

  it("is false before the item is due", () => {
    expect(isWaitingForMeeting(item({ fire_at: new Date(NOW + 60 * 1000).toISOString() }), NOW)).toBe(false);
  });

  it("is false once the daemon's 3 hour max wait has passed", () => {
    expect(isWaitingForMeeting(item({ fire_at: new Date(NOW - 3 * HOUR).toISOString() }), NOW)).toBe(false);
    expect(isWaitingForMeeting(item({ fire_at: new Date(NOW - 3 * HOUR + 1000).toISOString() }), NOW)).toBe(true);
  });

  it("is false for any non-pending status", () => {
    for (const type of ["firing", "sent", "failed", "missed", "skipped"]) {
      expect(isWaitingForMeeting(item({ status: { type } }), NOW)).toBe(false);
    }
  });

  it("is false for an unparseable fire_at", () => {
    expect(isWaitingForMeeting(item({ fire_at: "nope" }), NOW)).toBe(false);
  });
});

describe("meetingMarker / meetingDrawer", () => {
  it("renders a toggle button only on an after-meeting row", () => {
    expect(meetingMarker(item(), "i1|1", false)).toContain('data-action="meeting-toggle"');
    expect(meetingMarker(item({ after_meeting: undefined }), "i1|1", false)).toBe("");
    expect(meetingDrawer(item({ after_meeting: false }))).toBe("");
  });

  it("states the debounce and the max wait in the drawer", () => {
    const html = meetingDrawer(item());
    expect(html).toContain("20 seconds");
    expect(html).toContain("3 hours");
  });
});
