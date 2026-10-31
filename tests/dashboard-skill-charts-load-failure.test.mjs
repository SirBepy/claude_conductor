// @vitest-environment jsdom

// A failed or empty skill-usage read must leave the Home skill widgets in their
// empty state, not surface an unhandled rejection (which vitest reports as a
// run error and the webview logs as an uncaught promise).

import { describe, it, expect, vi, afterEach } from "vitest";

const calls = { week: async () => null };
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getSkillUsageWeek: () => calls.week(),
    getSkillUsageDetail: async () => ({ events: [] }),
    onSkillUsageChanged: () => () => {},
  },
}));

const { skillTopWidget, skillRunsWidget } = await import(
  "../src/views/dashboard/widgets/skill-charts-widget.ts"
);

const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

describe.each([
  ["top skills", skillTopWidget],
  ["skill runs per day", skillRunsWidget],
])("%s widget", (_name, widget) => {
  for (const [label, week] of [
    ["a null week", async () => null],
    ["a rejected read", async () => { throw new Error("daemon down"); }],
  ]) {
    it(`survives ${label} without an unhandled rejection`, async () => {
      process.on("unhandledRejection", onUnhandled);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      calls.week = week;
      const root = document.createElement("div");
      const cleanup = widget.render(root, {});
      await new Promise((r) => setTimeout(r, 20));
      cleanup?.();
      err.mockRestore();
      expect(unhandled).toEqual([]);
    });
  }
});
