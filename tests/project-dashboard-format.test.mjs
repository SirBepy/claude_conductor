// @vitest-environment jsdom
//
// Which dashboard a repo resolves to, and the small pure helpers the
// dashboard rows lean on.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  agoLabel, fetchedLabel, fileIcon, fileName, plainPreview, sameCwd, scopeOf, shortAgo, staleCardIds, targetForRepo, whenLabel,
} from "../src/views/sessions/project-dashboard/format.ts";

describe("plainPreview", () => {
  it("drops markdown markers and link targets from an outcome message", () => {
    expect(plainPreview("**Verdict:** done in `d9183a7`.\n- see [the story](https://x.y/z)\n## Next"))
      .toBe("Verdict: done in d9183a7. see the story Next");
  });
});
import { groupRow, projectRow, ZIRTUE_REPOS } from "./helpers/project-dashboard-fixtures.mjs";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();

// The app's formatTimeAgo reads Date.now() itself, so the clock is pinned too.
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

describe("targetForRepo", () => {
  const rows = () => [groupRow(), projectRow()];

  it("sends every repo of a group to the same group dashboard", () => {
    for (const r of ZIRTUE_REPOS) expect(targetForRepo(rows(), r.cwd)).toEqual({ kind: "group", id: "g1" });
  });

  it("matches a repo whatever its path's slashes or casing", () => {
    expect(targetForRepo(rows(), "c:\\projects\\ZNG-ADMIN\\")).toEqual({ kind: "group", id: "g1" });
  });

  it("matches by project id when the chat runs in a worktree folder", () => {
    expect(targetForRepo(rows(), "C:/wt/zng-api-feature", "z3")).toEqual({ kind: "group", id: "g1" });
  });

  it("gives an ungrouped repo its own project dashboard", () => {
    const p = projectRow();
    expect(targetForRepo(rows(), p.target.repos[0].cwd)).toEqual({ kind: "project", id: "p1" });
  });

  it("falls back to the folder itself for a repo the list does not know", () => {
    expect(targetForRepo(rows(), "D:/elsewhere")).toEqual({ kind: "project", id: "D:/elsewhere" });
  });
});

describe("time labels", () => {
  it("agoLabel / shortAgo drop to 'now' inside a minute", () => {
    expect(agoLabel(NOW - 20_000, NOW)).toBe("now");
    expect(shortAgo(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(fetchedLabel(NOW - 6 * 60_000, NOW)).toBe("fetched 6m ago");
    expect(fetchedLabel(NOW - 1_000, NOW)).toBe("fetched just now");
  });

  it("whenLabel names today and tomorrow", () => {
    expect(whenLabel(new Date(2026, 9, 22, 14, 30).getTime(), NOW)).toBe("today 14:30");
    expect(whenLabel(new Date(2026, 9, 23, 10, 0).getTime(), NOW)).toBe("tomorrow 10:00");
  });
});

describe("paths", () => {
  it("sameCwd ignores separators, case and a trailing slash", () => {
    expect(sameCwd("C:\\Projects\\App\\", "c:/projects/app")).toBe(true);
    expect(sameCwd("C:/a", "C:/b")).toBe(false);
  });

  it("scopeOf maps a project to its repo cwd and a group to its id", () => {
    expect(scopeOf(projectRow().target)).toEqual({ kind: "project", cwd: "C:/Projects/conductor" });
    expect(scopeOf(groupRow().target)).toEqual({ kind: "group", id: "g1" });
  });

  it("fileIcon and fileName read the extension and leaf", () => {
    expect(fileIcon("a/b/deck.pptx")).toBe("presentation-chart");
    expect(fileIcon("a/b/noext")).toBe("file");
    expect(fileName("C:\\x\\y\\report.pdf")).toBe("report.pdf");
  });
});

describe("staleCardIds", () => {
  const view = (id, refresh_secs, agoSecs) => ({
    config: { id, enabled: true, refresh_secs },
    result: { fetched_at_ms: 1_000_000 - agoSecs * 1000 },
  });

  it("never treats a card as stale sooner than a minute, whatever interval it asks for", () => {
    const cards = [view("zero", 0, 30), view("ten", 10, 30), view("zero-old", 0, 61)];
    expect(staleCardIds(cards, 1_000_000)).toEqual(["zero-old"]);
  });
});
