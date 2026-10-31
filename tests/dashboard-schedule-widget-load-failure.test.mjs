// @vitest-environment jsdom

// A failed `schedule_list` read is not an empty calendar: the Home widget must
// log it and say it couldn't load, never "Nothing scheduled". A refresh that
// fails after rows were painted keeps those rows. The two enrichment reads
// (external jobs, chat titles) still degrade quietly.

import { describe, it, expect, vi } from "vitest";

const hooks = { replies: {}, changed: () => {} };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: (cmd) => hooks.replies[cmd](),
}));
vi.mock("../src/shared/events.ts", () => ({
  listen: async (_event, cb) => {
    hooks.changed = cb;
    return () => {};
  },
}));
vi.mock("../src/shared/open-schedule.ts", () => ({ openSchedule: () => {} }));

const { scheduleWidget } = await import("../src/views/dashboard/widgets/schedule-widget.ts");

const pending = {
  id: "a",
  kind: { type: "message", session_id: "s1", cwd: "C:/p/proj" },
  prompt: "run the nightly check",
  fire_at: "2030-01-01T10:00:00Z",
  recurrence: null,
  status: { type: "pending" },
  created_at: "2029-12-01T00:00:00Z",
  last_fired_at: null,
  last_result: null,
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function setReplies(over) {
  hooks.replies = {
    schedule_list: async () => [pending],
    schedule_list_external: async () => [],
    list_instances: async () => [],
    ...over,
  };
}

describe("schedule widget, failed reads", () => {
  it("a failed schedule_list shows an error line and logs, not 'Nothing scheduled'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setReplies({ schedule_list: async () => { throw new Error("daemon down"); } });
    const root = document.createElement("div");
    const cleanup = scheduleWidget.render(root, {});
    await tick();
    expect(root.textContent).toContain("Couldn't load the schedule");
    expect(root.textContent).not.toContain("Nothing scheduled");
    expect(root.querySelector(".sched-w-open")).not.toBeNull();
    expect(err).toHaveBeenCalled();
    cleanup?.();
    err.mockRestore();
  });

  it("a refresh that fails after rows were painted keeps the rows", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setReplies({});
    const root = document.createElement("div");
    const cleanup = scheduleWidget.render(root, {});
    await tick();
    expect(root.querySelectorAll(".sched-w-row").length).toBe(1);
    setReplies({ schedule_list: async () => { throw new Error("daemon down"); } });
    hooks.changed();
    await tick();
    expect(root.querySelectorAll(".sched-w-row").length).toBe(1);
    expect(err).toHaveBeenCalled();
    cleanup?.();
    err.mockRestore();
  });

  it("a genuinely empty list still says 'Nothing scheduled'", async () => {
    setReplies({ schedule_list: async () => [] });
    const root = document.createElement("div");
    const cleanup = scheduleWidget.render(root, {});
    await tick();
    expect(root.textContent).toContain("Nothing scheduled");
    cleanup?.();
  });

  it("a failed enrichment read still draws the rows", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setReplies({
      schedule_list_external: async () => { throw new Error("no scheduler"); },
      list_instances: async () => { throw new Error("no daemon"); },
    });
    const root = document.createElement("div");
    const cleanup = scheduleWidget.render(root, {});
    await tick();
    expect(root.querySelectorAll(".sched-w-row").length).toBe(1);
    cleanup?.();
    err.mockRestore();
  });
});
