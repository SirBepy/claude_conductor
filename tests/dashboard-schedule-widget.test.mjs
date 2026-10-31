import { describe, it, expect } from "vitest";
import {
  upcomingRows,
  whenLabel,
  UPCOMING_LIMIT,
} from "../src/views/dashboard/widgets/schedule-widget-logic.ts";

function item(over = {}) {
  return {
    id: "a",
    kind: { type: "message", session_id: "s1", cwd: "C:/p/proj" },
    prompt: "run the nightly check",
    fire_at: "2030-01-01T10:00:00Z",
    recurrence: null,
    status: { type: "pending" },
    created_at: "2029-12-01T00:00:00Z",
    last_fired_at: null,
    last_result: null,
    ...over,
  };
}

describe("upcomingRows", () => {
  const titles = new Map([["s1", "Nightly chat"]]);

  it("keeps only pending/firing items, soonest first", () => {
    const rows = upcomingRows(
      [
        item({ id: "late", fire_at: "2030-01-03T10:00:00Z" }),
        item({ id: "done", status: { type: "sent" }, fire_at: "2029-01-01T10:00:00Z" }),
        item({ id: "soon", fire_at: "2030-01-01T09:00:00Z", status: { type: "firing" } }),
        item({ id: "bad", status: { type: "failed", reason: "x" } }),
        item({ id: "gone", status: { type: "missed" } }),
        item({ id: "skip", status: { type: "skipped" } }),
      ],
      [],
      titles,
    );
    expect(rows.map((r) => r.id)).toEqual(["soon", "late"]);
    expect(rows[0].firing).toBe(true);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      item({ id: `i${i}`, fire_at: `2030-01-0${i + 1}T10:00:00Z` }),
    );
    expect(upcomingRows(many, [], titles)).toHaveLength(UPCOMING_LIMIT);
  });

  it("labels a message by chat title, falling back to the prompt", () => {
    const [titled] = upcomingRows([item()], [], titles);
    expect(titled.label).toBe("Nightly chat");
    const [bare] = upcomingRows([item()], [], new Map());
    expect(bare.label).toBe("run the nightly check");
  });

  it("labels a new chat by its project folder and flags repeats", () => {
    const [r] = upcomingRows(
      [
        item({
          kind: { type: "new_chat", cwd: "C:/work/my_app", model: "m", effort: "e", account_id: null },
          recurrence: { rule: { type: "daily" } },
        }),
      ],
      [],
      titles,
    );
    expect(r.label).toBe("New chat: my_app");
    expect(r.recurring).toBe(true);
    expect(r.icon).toBe("ph-plus-circle");
  });

  it("cuts a long prompt label with the calendar's ellipsis character", () => {
    const [r] = upcomingRows([item({ prompt: "x".repeat(80) })], [], new Map());
    expect(r.label).toBe(`${"x".repeat(60)}…`);
  });

  it("drops an item with an unparseable fire time", () => {
    expect(upcomingRows([item({ fire_at: "nope" })], [], titles)).toEqual([]);
  });
});

describe("whenLabel", () => {
  const now = new Date(2030, 0, 1, 8, 0);
  it("shows just the time for today", () => {
    expect(whenLabel(new Date(2030, 0, 1, 9, 5).getTime(), now)).toBe("09:05");
  });
  it("says Tomorrow for the next day", () => {
    expect(whenLabel(new Date(2030, 0, 2, 23, 30).getTime(), now)).toBe("Tomorrow 23:30");
  });
  it("shows just the time for an overdue item on a past day", () => {
    expect(whenLabel(new Date(2029, 11, 30, 21, 15).getTime(), now)).toBe("21:15");
  });
  it("shows the weekday and date further out", () => {
    expect(whenLabel(new Date(2030, 0, 5, 7, 0).getTime(), now)).toMatch(/Sat.*5.*Jan.*07:00/);
  });
});
