// @vitest-environment jsdom

// onSkillUsageChanged can fire again before the previous read returns. An older,
// slower reply must not repaint over a newer one (the runs widget fans out up to
// a dozen detail reads per load, so overlap is the normal case there).

import { describe, it, expect, vi } from "vitest";

const hooks = {
  week: async () => null,
  detail: async (_s) => [],
  changed: () => {},
};
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getSkillUsageWeek: () => hooks.week(),
    getSkillRunsPerDay: (skills) => hooks.detail(skills),
    onSkillUsageChanged: (cb) => {
      hooks.changed = cb;
      return () => {};
    },
  },
}));

const { skillTopWidget, skillRunsWidget } = await import(
  "../src/views/dashboard/widgets/skill-charts-widget.ts"
);

const weekOf = (skill, total) => ({ entries: [{ skill, invocations: { total } }] });
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("top skills widget, overlapping loads", () => {
  it("a slow first read cannot overwrite a newer one", async () => {
    const slow = deferred();
    const replies = [slow.promise, Promise.resolve(weekOf("fresh-skill", 5))];
    hooks.week = () => replies.shift();
    const root = document.createElement("div");
    const cleanup = skillTopWidget.render(root, {});
    hooks.changed();
    await tick();
    expect(root.textContent).toContain("fresh-skill");
    slow.resolve(weekOf("stale-skill", 9));
    await tick();
    expect(root.textContent).toContain("fresh-skill");
    expect(root.textContent).not.toContain("stale-skill");
    cleanup?.();
  });
});

describe("skill runs widget, overlapping loads", () => {
  it("a slow first load cannot overwrite a newer one", async () => {
    const slowDetail = deferred();
    const weeks = [weekOf("old-skill", 1), weekOf("new-skill", 1)];
    hooks.week = async () => weeks.shift();
    const p = (n) => String(n).padStart(2, "0");
    const d = new Date();
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    hooks.detail = (skills) =>
      skills[0] === "old-skill" ? slowDetail.promise : Promise.resolve([{ day: today, runs: 3 }]);
    const root = document.createElement("div");
    const cleanup = skillRunsWidget.render(root, {});
    await tick();
    hooks.changed();
    await tick();
    const counts = () => [...root.querySelectorAll(".skill-day-count")].map((e) => e.textContent).join(",");
    const fresh = counts();
    expect(fresh).toContain("3");
    // The first load's detail finally lands, with no events at all.
    slowDetail.resolve([]);
    await tick();
    expect(counts()).toBe(fresh);
    cleanup?.();
  });
});
