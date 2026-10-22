// @vitest-environment jsdom
//
// The Projects list's second-line wording and the small pure helpers the
// dashboard rows lean on.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  agoLabel, fetchedLabel, fileIcon, fileName, listDotClass, listSubline, plainPreview, sameCwd, scopeOf, shortAgo, whenLabel,
} from "../src/views/sessions/projects-tab/format.ts";

describe("plainPreview", () => {
  it("drops markdown markers and link targets from an outcome message", () => {
    expect(plainPreview("**Verdict:** done in `d9183a7`.\n- see [the story](https://x.y/z)\n## Next"))
      .toBe("Verdict: done in d9183a7. see the story Next");
  });
});
import { groupRow, projectRow } from "./helpers/projects-tab-fixtures.mjs";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();

// The app's formatTimeAgo reads Date.now() itself, so the clock is pinned too.
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

describe("listSubline", () => {
  it("says 'now' for a fresh project and counts running chats in words", () => {
    const row = projectRow({ last_active_ms: NOW - 5_000, live_count: 2, question_count: 0 });
    expect(listSubline(row, NOW)).toBe("now \u00B7 2 running");
  });

  it("leads a group with its repo count and names the waiting chats", () => {
    const row = groupRow({ last_active_ms: NOW - 4 * 60_000, live_count: 0, question_count: 1 });
    expect(listSubline(row, NOW)).toBe("4 repos \u00B7 4m ago \u00B7 1 waiting on you");
  });

  it("shows only the age for an idle project, and a plain line for one never used", () => {
    expect(listSubline(projectRow({ last_active_ms: NOW - 3_600_000, live_count: 0, question_count: 0 }), NOW)).toBe("1h ago");
    expect(listSubline(projectRow({ last_active_ms: 0, live_count: 0, question_count: 0 }), NOW)).toBe("no chats yet");
  });
});

describe("listDotClass", () => {
  it("prefers a waiting question over working, and is empty when idle", () => {
    expect(listDotClass(projectRow({ question_count: 1, working_count: 1 }))).toBe("st-question");
    expect(listDotClass(projectRow({ question_count: 0, working_count: 1 }))).toBe("st-working");
    expect(listDotClass(projectRow({ question_count: 0, working_count: 0 }))).toBe("");
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
