// The Autopilot picks card's pure side (pc-1750): the daemon's `picks_state`
// shape read leniently, the derive that decides when the card draws, and the
// message an overrule sends to the main chat.

import { describe, it, expect } from "vitest";

const { normalisePicks, derivePicks, overruleMessage } = await import("../src/shared/chat/dashboard/picks-model.ts");
const { deriveDashboard, ZONES, SECTION_DEFAULTS } = await import("../src/shared/chat/dashboard/dashboard-model.ts");

const raw = (over = {}) => ({
  id: "P1", date: "2026-11-15T03:00:00+01:00", who: "Footer", sub: "s1", question: "Which header colour?",
  options: ["Teal", "Navy"], pick: "Teal", reason: "matches the logo", landed: "src/header.css",
  status: "unreviewed", instead: null, corrected_note: null, ...over,
});

describe("normalisePicks", () => {
  it("reads the daemon's shape and drops rows that are not picks", () => {
    const side = normalisePicks({ owner: "main", picks: [raw(), { id: 3 }, null, "x", raw({ id: "P2", question: "Footer?" })] });
    expect(side.owner).toBe("main");
    expect(side.picks.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(side.picks[0].options).toEqual(["Teal", "Navy"]);
  });

  it("anything missing reads as empty, and an unknown status is never hidden", () => {
    expect(normalisePicks(undefined)).toEqual({ owner: "", picks: [] });
    expect(normalisePicks({ picks: "no" }).picks).toEqual([]);
    const [p] = normalisePicks({ picks: [{ id: "P1", question: "q", status: "from-the-future" }] }).picks;
    expect(p.status).toBe("unreviewed");
    expect(p.options).toEqual([]);
    expect(p.who).toBe("a chat");
  });
});

describe("derivePicks", () => {
  it("draws nothing without a pick, so an attended chat gains no card", () => {
    expect(derivePicks(undefined)).toBeNull();
    expect(derivePicks({ owner: "m", picks: [] })).toBeNull();
  });

  it("splits by status, newest first, with agreed and corrected folded together", () => {
    const side = normalisePicks({
      owner: "m",
      picks: [
        raw({ id: "P1", date: "2026-11-15T01:00:00Z" }),
        raw({ id: "P2", date: "2026-11-15T02:00:00Z" }),
        raw({ id: "P3", status: "overruled", instead: "Navy" }),
        raw({ id: "P4", status: "agreed" }),
        raw({ id: "P5", status: "corrected" }),
      ],
    });
    const s = derivePicks(side);
    expect(s.unreviewed.map((p) => p.id)).toEqual(["P2", "P1"]);
    expect(s.overruled.map((p) => p.id)).toEqual(["P3"]);
    expect(s.done.map((p) => p.id).sort()).toEqual(["P4", "P5"]);
  });

  it("is off when Joe switched the section off", () => {
    expect(derivePicks(normalisePicks({ picks: [raw()] }), false)).toBeNull();
  });
});

describe("the picks zone", () => {
  const input = (extra = {}) => ({ messages: [], plans: [], ...extra });

  it("sits on the left under Waiting on you and is on by default", () => {
    expect(ZONES.picks.column).toBe("left");
    expect(ZONES.picks.order).toBeGreaterThan(ZONES.waiting.order);
    expect(ZONES.picks.order).toBeLessThan(ZONES.waitingElsewhere.order);
    expect(SECTION_DEFAULTS.picks).toBe(true);
  });

  it("appears once a pick exists and not before", () => {
    expect(deriveDashboard(input()).left.map((z) => z.id)).not.toContain("picks");
    const side = normalisePicks({ owner: "m", picks: [raw()] });
    expect(deriveDashboard(input({ picks: side })).left.map((z) => z.id)).toContain("picks");
    expect(deriveDashboard(input({ picks: side, sections: { picks: false } })).left.map((z) => z.id)).not.toContain("picks");
  });
});

describe("overruleMessage", () => {
  it("names the pick, what Joe wants and how the chat closes it out", () => {
    const msg = overruleMessage(normalisePicks({ picks: [raw()] }).picks[0], "  Navy, the brand changed ");
    expect(msg).toContain("autopilot pick P1");
    expect(msg).toContain("(it landed in src/header.css)");
    expect(msg).toContain("You picked: Teal");
    expect(msg).toContain("I want: Navy, the brand changed");
    expect(msg).toContain('action "corrected", id "P1"');
  });
});
