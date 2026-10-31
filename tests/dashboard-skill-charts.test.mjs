import { describe, it, expect } from "vitest";
import {
  topSkills,
  skillsToFetch,
  runsPerDay,
  MAX_DETAIL_FETCHES,
} from "../src/views/dashboard/widgets/skill-charts-logic.ts";

const entry = (skill, total) => ({
  skill,
  invocations: { total, manual: total, skill: 0, auto: 0 },
  chats: 1,
  tokens: {},
});

describe("topSkills", () => {
  it("ranks by runs, breaks ties by name, drops zero-run skills, caps at 5", () => {
    const bars = topSkills([
      entry("b", 3),
      entry("a", 3),
      entry("zero", 0),
      entry("big", 9),
      entry("c", 1),
      entry("d", 2),
      entry("e", 4),
    ]);
    expect(bars.map((b) => b.skill)).toEqual(["big", "e", "a", "b", "d"]);
    expect(bars[0].runs).toBe(9);
  });
});

describe("skillsToFetch", () => {
  it("flags when the cap cut skills off", () => {
    const many = Array.from({ length: MAX_DETAIL_FETCHES + 3 }, (_, i) => entry(`s${i}`, i + 1));
    const r = skillsToFetch(many);
    expect(r.skills).toHaveLength(MAX_DETAIL_FETCHES);
    expect(r.truncated).toBe(true);
    expect(r.skills[0]).toBe(`s${MAX_DETAIL_FETCHES + 2}`);
  });
  it("is not truncated under the cap", () => {
    expect(skillsToFetch([entry("a", 1)]).truncated).toBe(false);
  });
});

describe("runsPerDay", () => {
  const now = new Date(2030, 0, 10, 12, 0);
  const at = (d, h) => ({ ts: new Date(2030, 0, d, h, 0).toISOString() });

  it("returns 7 local-day buckets ending today, oldest first", () => {
    const b = runsPerDay([], now);
    expect(b).toHaveLength(7);
    expect(b[6].key).toBe("2030-01-10");
    expect(b[0].key).toBe("2030-01-04");
  });

  it("counts each event on its local day and ignores events outside the window or unparseable", () => {
    const b = runsPerDay(
      [at(10, 1), at(10, 23), at(9, 12), at(4, 0), at(3, 23), { ts: "garbage" }],
      now,
    );
    const byKey = Object.fromEntries(b.map((x) => [x.key, x.runs]));
    expect(byKey["2030-01-10"]).toBe(2);
    expect(byKey["2030-01-09"]).toBe(1);
    expect(byKey["2030-01-04"]).toBe(1);
    expect(b.reduce((s, x) => s + x.runs, 0)).toBe(4);
  });
});
