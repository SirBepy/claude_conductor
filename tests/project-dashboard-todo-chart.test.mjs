// @vitest-environment jsdom
//
// The dashboard's Todos card: which days a range shows, the end-label dodge,
// and when the card is left out entirely.

import { describe, it, expect, vi } from "vitest";
import { render } from "lit-html";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { todoDays, dodge, todoChart } = await import("../src/views/sessions/project-dashboard/dash-todo-chart.ts");

const day = (date, created, done, open) => ({ date, created, done, open });
const days = Array.from({ length: 40 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`, i, 1, 10));

function ctx(todo_stats, hidden_builtins = []) {
  return {
    snap: { target: { kind: "project", repos: [] }, hidden_builtins, todo_stats },
    act: { setTodoRange: vi.fn() },
  };
}

function mount(c) {
  const el = document.createElement("div");
  render(todoChart(c), el);
  return el;
}

describe("todoDays", () => {
  it("keeps the newest 7 or 30 days, or every day for All", () => {
    expect(todoDays(days, "7d").map((d) => d.date)).toEqual(days.slice(-7).map((d) => d.date));
    expect(todoDays(days, "30d")).toHaveLength(30);
    expect(todoDays(days, "all")).toHaveLength(40);
    expect(todoDays(days.slice(0, 3), "30d")).toHaveLength(3);
  });
});

describe("dodge", () => {
  it("pushes labels that would overlap apart and keeps each in its slot", () => {
    expect(dodge([50, 52, 100])).toEqual([50, 61, 100]);
    expect(dodge([60, 55, 56])).toEqual([77, 55, 66]);
  });
  it("leaves labels that already clear each other alone", () => {
    expect(dodge([10, 40, 90])).toEqual([10, 40, 90]);
  });
});

describe("todoChart", () => {
  it("draws three lines and names what is available now", () => {
    const el = mount(ctx({ days, open_now: 12, claimed_now: 2 }));
    expect(el.querySelectorAll("svg polyline")).toHaveLength(3);
    expect(el.querySelector(".pd-usage-total").textContent).toContain("10 available, 2 claimed");
  });

  it("is left out with no todos folder, when hidden, or for a daemon that sends no stats", () => {
    expect(mount(ctx({ days: [], open_now: 0, claimed_now: 0 })).querySelector("[data-pd-card]")).toBeNull();
    expect(mount(ctx({ days, open_now: 1, claimed_now: 0 }, ["todo_chart"])).querySelector("[data-pd-card]")).toBeNull();
    expect(mount(ctx(undefined)).querySelector("[data-pd-card]")).toBeNull();
  });

  it("a single day is a dot per series, not a line", () => {
    const el = mount(ctx({ days: [day("2026-10-26", 2, 1, 1)], open_now: 1, claimed_now: 0 }));
    expect(el.querySelectorAll("svg polyline")).toHaveLength(0);
    expect(el.querySelectorAll("svg circle:not([data-todo-dot])")).toHaveLength(3);
  });
});
