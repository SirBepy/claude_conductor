// @vitest-environment jsdom
//
// The home dashboard's session/weekly chart builds its SVG from a string on every
// usage event, and a new node restarts the CSS draw-in, so the lines drew in
// again on every repaint (pc-1748). A window draws in once; paging to another
// window draws in once more.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { buildChart } = await import("../src/views/dashboard/widgets/usage-chart-view.ts");

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 14, 8);
const history = Array.from({ length: 4 }, (_, i) => ({
  hour: new Date(START + i * HOUR).toISOString().slice(0, 13),
  session_pct: 10 * (i + 1),
  weekly_pct: 5 * (i + 1),
}));
const drawn = (svg) => (svg.match(/class="chart-line-draw"/g) ?? []).length;

describe("home usage chart draw-in", () => {
  afterEach(() => vi.useRealTimers());

  it("draws in the first time a window is built, not when the same window is built again later", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    expect(drawn(buildChart(history, START, START + 5 * HOUR, "s", "chart-once-a"))).toBe(1);
    vi.setSystemTime(new Date("2026-11-14T10:00:30Z"));
    expect(drawn(buildChart(history, START, START + 5 * HOUR, "s", "chart-once-a"))).toBe(0);
  });

  it("a different window is its own first sighting", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    buildChart(history, START, START + 5 * HOUR, "s", "chart-once-b");
    vi.setSystemTime(new Date("2026-11-14T10:00:30Z"));
    expect(drawn(buildChart(history, START - 5 * HOUR, START, "s", "chart-once-b"))).toBe(1);
  });
});
