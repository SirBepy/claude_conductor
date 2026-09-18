// @vitest-environment jsdom
// Light static-analysis + DOM rendering test for the Projects view.
// jsdom (not the file's default node env) because projects.ts pulls in
// shared/sidemenu.ts, which touches `window` at module load.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sortProjectGroups, filterProjectGroups } from "../src/views/projects/projects.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");
const html = readFileSync(join(distDir, "index.html"), "utf8");
const projectsTs = readFileSync(
  join(distDir, "views", "projects", "projects.ts"),
  "utf8",
);
const projectDetailTs = readFileSync(
  join(distDir, "views", "project-detail", "project-detail.ts"),
  "utf8",
);
const characterPickTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "character-pick", "character-pick.ts"),
  "utf8",
);
const automationTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "automation", "automation.ts"),
  "utf8",
);
const folderMappingTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "folder-mapping", "folder-mapping.ts"),
  "utf8",
);
const sessionsListTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "sessions-list", "sessions-list.ts"),
  "utf8",
);
const sessionDetailTs = readFileSync(
  join(distDir, "views", "session-detail", "session-detail.ts"),
  "utf8",
);
const subviewHeaderTs = readFileSync(
  join(distDir, "views", "project-detail", "subview-header.ts"),
  "utf8",
);

describe("Projects view DOM", () => {
  it("has a projects-list container in the migrated view", () => {
    expect(projectsTs).toMatch(/id="projects-list"/);
  });

  it("includes a sort-by dropdown with all four backend modes", () => {
    expect(projectsTs).toMatch(/id="projectsSortSelect"/);
    expect(projectsTs).toMatch(/value="recent"/);
    expect(projectsTs).toMatch(/value="name"/);
    expect(projectsTs).toMatch(/value="live"/);
    expect(projectsTs).toMatch(/value="tokens"/);
  });

  it("has distinct empty, error, and no-match states", () => {
    expect(projectsTs).toMatch(/ph-folder-open/);
    expect(projectsTs).toMatch(/No projects yet/);
    expect(projectsTs).toMatch(/ph-warning/);
    expect(projectsTs).toMatch(/Couldn't load projects/);
    expect(projectsTs).toMatch(/No matches for/);
  });

  it("has a search input and a kebab menu with Refresh + Rebuild history", () => {
    expect(projectsTs).toMatch(/id="projectsSearchInput"/);
    expect(projectsTs).toMatch(/type="search"/);
    expect(projectsTs).toMatch(/id="projects-menu"/);
    expect(projectsTs).toMatch(/id="projects-refresh"/);
    expect(projectsTs).toMatch(/id="projects-rebuild"/);
    expect(projectsTs).toMatch(/Rebuild history/);
  });

  it("cards are keyboard-reachable, not raw innerHTML, and carry no emoji glyphs", () => {
    expect(projectsTs).toMatch(/role="button"/);
    expect(projectsTs).toMatch(/tabindex="0"/);
    expect(projectsTs).not.toMatch(/innerHTML/);
    expect(projectsTs).not.toMatch(/📱|⚙|↺/);
    expect(projectsTs).not.toMatch(/var\(--text-dim\)/);
  });

  it("keeps the renderProjectsList/refreshProjectsUI exports other views import", () => {
    expect(projectsTs).toMatch(/export async function renderProjectsList/);
    expect(projectsTs).toMatch(/export function refreshProjectsUI/);
  });
});

describe("Projects view sort + filter logic", () => {
  function group(over = {}) {
    return {
      id: over.id ?? null,
      path: over.path ?? "/p",
      name: over.name ?? "proj",
      parent_segment: over.parent_segment ?? null,
      avatar: { kind: "none" },
      automation_enabled: false,
      tokens_7d: over.tokens_7d ?? 0,
      live: over.live ?? 0,
      any_remote: over.any_remote ?? false,
      any_automated: over.any_automated ?? false,
      last_active_at: over.last_active_at ?? null,
    };
  }

  it("sorts by name alphabetically", () => {
    const rows = [group({ name: "Zeta" }), group({ name: "Alpha" }), group({ name: "mid" })];
    const sorted = sortProjectGroups(rows, "name");
    expect(sorted.map((g) => g.name)).toEqual(["Alpha", "mid", "Zeta"]);
  });

  it("sorts by live count, ties broken by last-active", () => {
    const rows = [
      group({ name: "a", live: 0, last_active_at: "2026-01-02T00:00:00Z" }),
      group({ name: "b", live: 2, last_active_at: "2026-01-01T00:00:00Z" }),
      group({ name: "c", live: 2, last_active_at: "2026-01-03T00:00:00Z" }),
    ];
    const sorted = sortProjectGroups(rows, "live");
    expect(sorted.map((g) => g.name)).toEqual(["c", "b", "a"]);
  });

  it("sorts by tokens_7d descending", () => {
    const rows = [group({ name: "a", tokens_7d: 10 }), group({ name: "b", tokens_7d: 500 })];
    const sorted = sortProjectGroups(rows, "tokens");
    expect(sorted.map((g) => g.name)).toEqual(["b", "a"]);
  });

  it("sorts by recency, most-recent first", () => {
    const rows = [
      group({ name: "old", last_active_at: "2020-01-01T00:00:00Z" }),
      group({ name: "new", last_active_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortProjectGroups(rows, "recent");
    expect(sorted.map((g) => g.name)).toEqual(["new", "old"]);
  });

  it("filters by name, case-insensitive", () => {
    const rows = [group({ name: "Alpha Repo" }), group({ name: "Beta" })];
    expect(filterProjectGroups(rows, "alpha").map((g) => g.name)).toEqual(["Alpha Repo"]);
  });

  it("filters by parent_segment as well as name", () => {
    const rows = [group({ name: "app", parent_segment: "monorepo" }), group({ name: "app2", parent_segment: "other" })];
    expect(filterProjectGroups(rows, "monorepo").map((g) => g.name)).toEqual(["app"]);
  });

  it("an empty query returns every group untouched", () => {
    const rows = [group({ name: "a" }), group({ name: "b" })];
    expect(filterProjectGroups(rows, "")).toEqual(rows);
  });

  it("a query matching nothing returns an empty list (the no-match state)", () => {
    const rows = [group({ name: "a" })];
    expect(filterProjectGroups(rows, "zzz")).toEqual([]);
  });
});

describe("Project-detail DOM (unrelated views, unchanged by the projects revamp)", () => {
  it("has project-detail menu button + popover container", () => {
    expect(projectDetailTs).toMatch(/id="projectDetailMenuBtn"/);
    expect(projectDetailTs).toMatch(/id="projectDetailMenu"[^>]*class="menu-popover/);
    expect(projectDetailTs).toMatch(/data-menu-item="character-pick"/);
    expect(projectDetailTs).toMatch(/data-menu-item="automation"/);
    expect(projectDetailTs).toMatch(/data-menu-item="folder-mapping"/);
  });

  it("has subviews for character-pick / automation / folder-mapping / sessions / session-detail", () => {
    expect(characterPickTs).toMatch(/view-project-character-pick/);
    expect(automationTs).toMatch(/view-project-automation/);
    expect(folderMappingTs).toMatch(/view-project-folder-mapping/);
    expect(sessionsListTs).toMatch(/view-project-sessions/);
    expect(sessionDetailTs).toMatch(/view-session-detail/);
  });

  it("each project subview has a back button", () => {
    // character-pick still owns its own back button
    expect(characterPickTs).toMatch(/id="characterPickBackBtn"/);
    // remaining subviews delegate to the shared subview-header component
    expect(subviewHeaderTs).toMatch(/ph-arrow-left/);
    expect(subviewHeaderTs).toMatch(/icon-btn/);
    expect(automationTs).toMatch(/subview-header/);
    expect(folderMappingTs).toMatch(/subview-header/);
    expect(sessionsListTs).toMatch(/subview-header/);
    expect(sessionDetailTs).toMatch(/subview-header/);
  });

  it("automation + character-pick + path-editor DOM moved out of project-detail view", () => {
    expect(projectDetailTs).not.toMatch(/id="automationSection"/);
    expect(projectDetailTs).not.toMatch(/id="projectNotifOverridesSection"/);
    expect(projectDetailTs).not.toMatch(/id="projectDetailPath"[^A-Za-z]/);
    expect(projectDetailTs).not.toMatch(/id="projectDetailPathInput"/);
    expect(projectDetailTs).not.toMatch(/id="project-merged-paths"/);
    expect(projectDetailTs).not.toMatch(/id="hideProjectBtn"/);
  });

  it("automation subview contains the form fields", () => {
    expect(automationTs).toMatch(/id="automationEnabled"/);
    expect(automationTs).toMatch(/id="automateChannelBtn"/);
  });

  it("folder-mapping subview contains path editor + merged + hide", () => {
    expect(folderMappingTs).toMatch(/id="projectDetailPath"/);
    expect(folderMappingTs).toMatch(/id="project-merged-paths"/);
    expect(folderMappingTs).toMatch(/id="hideProjectBtn"/);
  });

  it("character-pick subview hosts the whitelist editor", () => {
    expect(characterPickTs).toMatch(/id="whitelist-editor-host"/);
    expect(characterPickTs).toMatch(/renderWhitelistEditor/);
  });
});
