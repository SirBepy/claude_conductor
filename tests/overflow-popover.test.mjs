// @vitest-environment jsdom

// The overflow panel absorbed six chips, so the things those chips used to say
// on their own now have to survive inside one panel: a never-called tool stays
// visible as a zero, and an unloaded count reads as unknown rather than as a
// confident 0.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { OverflowPopover } = await import("../src/views/sessions/overflow-popover.ts");
const { PANEL_TOOLS } = await import("../src/views/sessions/statusline-catalog.ts");

function anchor() {
  const a = document.createElement("span");
  document.body.appendChild(a);
  return a;
}

function panel() { return document.querySelector(".sb-overflow-popover"); }

const TALLY = {
  byType: [
    { tool: "Read", count: 12 }, { tool: "Bash", count: 9 }, { tool: "Grep", count: 6 },
    { tool: "Edit", count: 4 }, { tool: "Task", count: 2 }, { tool: "Skill", count: 1 },
  ],
};

function open(over = {}) {
  const p = new OverflowPopover();
  p.open(anchor(), {
    counts: { prompts: 12, turns: 8 },
    startedAt: new Date(Date.now() - 41 * 60 * 1000).toISOString(),
    drain: { sessionId: "s1", tokens: 34n, fiveHourPct: 50, weeklyPct: 12, messages: [] },
    toolTally: TALLY,
    ...over,
  });
  return p;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("overflow panel", () => {
  it("shows the three session counts as tiles", () => {
    const p = open();
    const tiles = Array.from(panel().querySelectorAll(".ov-tile"), (t) => [
      t.querySelector(".ov-tile-v").textContent,
      t.querySelector(".ov-tile-k").textContent,
    ]);
    expect(tiles[0]).toEqual(["12", "MESSAGES"]);
    expect(tiles[1]).toEqual(["8", "TURNS"]);
    expect(tiles[2][1]).toBe("DURATION");
    expect(tiles[2][0]).toMatch(/41m/);
    p.close();
  });

  it("reads unloaded counts as unknown, not as zero", () => {
    const p = open({ counts: null, startedAt: null });
    const vals = Array.from(panel().querySelectorAll(".ov-tile-v"), (v) => v.textContent);
    expect(vals).toEqual(["-", "-", "-"]);
    p.close();
  });

  it("renders both drain ratios as meters at their own widths", () => {
    const p = open();
    const fills = Array.from(panel().querySelectorAll(".ov-meter-fill"), (f) => f.style.width);
    expect(fills).toEqual(["50%", "12%"]);
    const labels = Array.from(panel().querySelectorAll(".ov-meter-label"), (l) => l.textContent);
    expect(labels[0]).toContain("5h Session Drained");
    expect(labels[1]).toContain("Weekly Drained");
    p.close();
  });

  it("leaves a null ratio empty rather than drawing a zero-length bar as data", () => {
    const p = open({ drain: { sessionId: "s1", tokens: 0n, fiveHourPct: null, weeklyPct: null, messages: [] } });
    expect(Array.from(panel().querySelectorAll(".ov-meter-label b"), (b) => b.textContent)).toEqual(["-", "-"]);
    expect(Array.from(panel().querySelectorAll(".ov-meter-fill"), (f) => f.style.width)).toEqual(["0%", "0%"]);
    p.close();
  });

  it("keeps every tool in the key, zeroes included, and states the headline in words", () => {
    const p = open();
    expect(panel().querySelector(".ov-head").textContent).toContain("This Session");
    expect(panel().textContent).toContain("Tools · 34 Calls");
    expect(panel().querySelector(".ov-mix-lede").textContent).toBe("Mostly Read, 35% of 34 calls");

    const names = Array.from(panel().querySelectorAll(".ov-mixrow .ov-nm"), (n) => n.textContent);
    expect(names.length).toBe(PANEL_TOOLS.length);
    expect([...names].sort()).toEqual([...PANEL_TOOLS].sort());

    // Search was never called: no strip segment, but a dimmed key row saying 0.
    expect(panel().querySelectorAll(".ov-mix span").length).toBe(6);
    const zero = panel().querySelector(".ov-mixrow div.zero");
    expect(zero.textContent).toContain("Search");
    expect(zero.querySelector("b").textContent).toBe("0");
    p.close();
  });

  it("sizes each strip segment by its share of the total", () => {
    const p = open();
    const widths = Array.from(panel().querySelectorAll(".ov-mix span"), (s) => s.style.width);
    expect(widths[0]).toBe(`${(12 / 34) * 100}%`);
    expect(widths[1]).toBe(`${(9 / 34) * 100}%`);
    p.close();
  });

  it("says so plainly when no tool has been called yet", () => {
    const p = open({ toolTally: { byType: [] } });
    expect(panel().textContent).toContain("Tools · 0 Calls");
    expect(panel().textContent).toContain("No tool calls yet");
    expect(panel().querySelector(".ov-mix")).toBeNull();
    p.close();
  });
});
