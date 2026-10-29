// @vitest-environment jsdom
//
// The dashboard's Todos card and the line chart it shares with Usage: which
// days a range shows, the two kinds of gridline, the smoothed line path, and
// when the card is left out entirely.

import { describe, it, expect, vi } from "vitest";
import { render } from "lit-html";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { todoDays, todoChart } = await import("../src/views/sessions/project-dashboard/dash-todo-chart.ts");
const { smoothPath, tierScale } = await import("../src/views/sessions/project-dashboard/dash-line-chart.ts");

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

describe("tierScale", () => {
  const M = 1_000_000;
  it("puts a solid line on every power of ten under the peak, rounding the top up to the next one", () => {
    expect(tierScale(483 * M, 126)).toEqual({ top: 500 * M, major: 100 * M, minor: null });
    expect(tierScale(75, 126, { integer: true })).toEqual({ top: 80, major: 10, minor: null });
  });
  it("adds faint lines at a tenth of that when they sit far enough apart, and tops out on the next faint one", () => {
    expect(tierScale(150 * M, 126)).toEqual({ top: 150 * M, major: 100 * M, minor: 10 * M });
    expect(tierScale(1_130 * M, 126)).toEqual({ top: 1_200 * M, major: 1_000 * M, minor: 100 * M });
    expect(tierScale(14, 126, { integer: true })).toEqual({ top: 14, major: 10, minor: 1 });
  });
  it("counts of whole things never get a line between two whole numbers, and the floor keeps a few lines", () => {
    expect(tierScale(1, 126, { integer: true, floor: 4 })).toEqual({ top: 4, major: 1, minor: null });
    expect(tierScale(0, 126, { integer: true })).toEqual({ top: 1, major: 1, minor: null });
  });
});

describe("smoothPath", () => {
  // Every number in the path is an x,y pair, so the y values are the odd ones.
  const ys = (d) => d.match(/-?[\d.]+/g).map(Number).filter((_, i) => i % 2 === 1);
  it("curves through every point, starting and ending on the data", () => {
    const d = smoothPath([[0, 10], [10, 20], [20, 5]]);
    expect(d.startsWith("M0.0,10.0")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d.endsWith("20.0,5.0")).toBe(true);
  });
  it("never overshoots: a peak gets a flat tangent, so no control point rises past it", () => {
    const d = smoothPath([[0, 50], [10, 10], [20, 50]]);
    expect(Math.min(...ys(d))).toBe(10);
    expect(Math.max(...ys(d))).toBe(50);
  });
  it("a single point is a bare move", () => {
    expect(smoothPath([[3, 4]])).toBe("M3.0,4.0");
  });
});

describe("todoChart", () => {
  it("draws three lines, only open in color and thick, done dashed, and names what is available now", () => {
    const el = mount(ctx({ days, open_now: 12, claimed_now: 2 }));
    const line = (k) => el.querySelector(`[data-line-chart] [data-line="${k}"]`);
    expect(el.querySelectorAll("[data-line-chart] [data-line]")).toHaveLength(3);
    expect(line("open").getAttribute("stroke")).toBe("var(--color-primary)");
    expect(line("created").getAttribute("stroke")).toBe("var(--color-text-muted)");
    expect(Number(line("open").getAttribute("stroke-width"))).toBeGreaterThan(Number(line("created").getAttribute("stroke-width")));
    expect(line("created").hasAttribute("stroke-dasharray")).toBe(false);
    expect(line("done").getAttribute("stroke-dasharray")).toBeTruthy();
    expect(el.querySelector(".pd-usage-total").textContent).toContain("10 available, 2 claimed");
  });

  it("names what one solid and one faint gridline are worth, and draws each kind", () => {
    // Open peaks at 14: solid every 10, faint every 1.
    const el = mount(ctx({ days: [day("2026-10-25", 3, 1, 9), day("2026-10-26", 2, 0, 14)], open_now: 14, claimed_now: 0 }));
    expect(el.querySelector('[data-line-key="major"]').textContent.trim()).toBe("10");
    expect(el.querySelector('[data-line-key="minor"]').textContent.trim()).toBe("1");
    expect(el.querySelectorAll('[data-line-grid="major"]')).toHaveLength(2);
    // 0..14 by one, less the two solid ones at 0 and 10.
    expect(el.querySelectorAll('[data-line-grid="minor"]')).toHaveLength(13);
  });

  it("is left out with no todos folder, when hidden, or for a daemon that sends no stats", () => {
    expect(mount(ctx({ days: [], open_now: 0, claimed_now: 0 })).querySelector("[data-pd-card]")).toBeNull();
    expect(mount(ctx({ days, open_now: 1, claimed_now: 0 }, ["todo_chart"])).querySelector("[data-pd-card]")).toBeNull();
    expect(mount(ctx(undefined)).querySelector("[data-pd-card]")).toBeNull();
  });

  it("a single day is a dot per series, not a line", () => {
    const el = mount(ctx({ days: [day("2026-10-26", 2, 1, 1)], open_now: 1, claimed_now: 0 }));
    expect(el.querySelectorAll("[data-line-chart] path[data-line]")).toHaveLength(0);
    expect(el.querySelectorAll("[data-line-chart] circle[data-line]")).toHaveLength(3);
  });
});
