// @vitest-environment jsdom

// The runs-per-day widget reads per-day counts in ONE daemon call however many
// skills ran, not one getSkillUsageDetail call per skill.

import { describe, it, expect, vi } from "vitest";

const spies = {
  perDay: vi.fn(async () => []),
  detail: vi.fn(async () => ({ events: [] })),
};
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getSkillUsageWeek: async () => ({
      entries: Array.from({ length: 9 }, (_, i) => ({ skill: `s${i}`, invocations: { total: i + 1 } })),
    }),
    getSkillRunsPerDay: (skills) => spies.perDay(skills),
    getSkillUsageDetail: (s) => spies.detail(s),
    onSkillUsageChanged: () => () => {},
  },
}));

const { skillRunsWidget } = await import("../src/views/dashboard/widgets/skill-charts-widget.ts");

describe("skill runs widget", () => {
  it("makes one per-day call for all skills and no per-skill detail calls", async () => {
    const root = document.createElement("div");
    const cleanup = skillRunsWidget.render(root, {});
    await new Promise((r) => setTimeout(r, 20));
    cleanup?.();
    expect(spies.perDay).toHaveBeenCalledTimes(1);
    expect(spies.perDay.mock.calls[0][0]).toHaveLength(9);
    expect(spies.detail).not.toHaveBeenCalled();
  });
});
