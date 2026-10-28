import { describe, it, expect } from "vitest";
import {
  applyMove, buildListGroups, canAct, isNoopMove, metaLine, moveForDrop, readerSections, readerWhy, reorderedGroups, worthDots,
} from "../src/views/sessions/backlog-panel/backlog-model.ts";

function todo(id, over = {}) {
  return {
    name: `${id}-x.md`, path: `C:\\p\\.claude\\todos\\${id}-x.md`, id, title: `Todo ${id}`, summary: null, origin: "ai",
    todo_type: "task", worth: null, complexity: null, claimed: false, group: null, plan_index: null, mtime_ms: 0, ...over,
  };
}

const backlog = () => ({
  groups: ["Release", "Later", "Empty"],
  todos: [
    todo("pc-0003", { group: "Release", plan_index: 1 }),
    todo("pc-0001", { group: "Release", plan_index: 0 }),
    todo("pc-0002", { group: "Later", plan_index: 2 }),
    todo("pc-0010", { mtime_ms: 100 }),
    todo("pc-0011", { mtime_ms: 900 }),
    todo("pc-0012", { mtime_ms: 500 }),
  ],
});

const ids = (g) => g.items.map((t) => t.id);

describe("buildListGroups", () => {
  it("lists plan groups in PLAN.md order, empty ones too, then unplanned newest first", () => {
    const g = buildListGroups(backlog());
    expect(g.map((x) => x.name)).toEqual(["Release", "Later", "Empty", null]);
    expect(ids(g[0])).toEqual(["pc-0001", "pc-0003"]);
    expect(ids(g[1])).toEqual(["pc-0002"]);
    expect(ids(g[2])).toEqual([]);
    expect(ids(g[3])).toEqual(["pc-0011", "pc-0012", "pc-0010"]);
  });

  it("still shows a todo whose group is missing from the heading list", () => {
    const g = buildListGroups({ groups: [], todos: [todo("pc-0001", { group: "Ghost", plan_index: 0 })] });
    expect(g.map((x) => x.name)).toEqual(["Ghost", null]);
    expect(ids(g[0])).toEqual(["pc-0001"]);
  });

  it("keeps an unplanned group when nothing is planned", () => {
    const g = buildListGroups({ groups: [], todos: [todo("pc-0001")] });
    expect(g).toHaveLength(1);
    expect(g[0].name).toBeNull();
  });
});

describe("moveForDrop (drop -> group, index for ai_todo_plan_move)", () => {
  const groups = buildListGroups(backlog());

  it("counts only the target group's other rows, in front of the row it dropped on", () => {
    expect(moveForDrop(groups, "pc-0002", { group: "Release", beforeId: "pc-0003" })).toEqual({ id: "pc-0002", group: "Release", index: 1 });
    expect(moveForDrop(groups, "pc-0002", { group: "Release", beforeId: "pc-0001" })).toEqual({ id: "pc-0002", group: "Release", index: 0 });
  });

  it("drops at the end of a group, and into an empty one at 0", () => {
    expect(moveForDrop(groups, "pc-0002", { group: "Release", beforeId: null }).index).toBe(2);
    expect(moveForDrop(groups, "pc-0002", { group: "Empty", beforeId: null })).toEqual({ id: "pc-0002", group: "Empty", index: 0 });
  });

  it("never counts the dragged row itself, so a downward move inside a group lands one slot over", () => {
    // Release is [0001, 0003]. 0001 dropped in front of nothing = the end; the
    // backend removes it first, so the index is 1, not 2.
    expect(moveForDrop(groups, "pc-0001", { group: "Release", beforeId: null }).index).toBe(1);
    expect(moveForDrop(groups, "pc-0001", { group: "Release", beforeId: "pc-0003" }).index).toBe(0);
  });

  it("unplans on a drop into the Backlog group (group null)", () => {
    expect(moveForDrop(groups, "pc-0001", { group: null, beforeId: null })).toEqual({ id: "pc-0001", group: null, index: 3 });
  });

  it("treats a vanished anchor row as the end", () => {
    expect(moveForDrop(groups, "pc-0002", { group: "Release", beforeId: "pc-9999" }).index).toBe(2);
  });
});

describe("isNoopMove", () => {
  const groups = buildListGroups(backlog());
  it("is true when the row would land where it already is", () => {
    expect(isNoopMove(groups, { id: "pc-0001", group: "Release", index: 0 })).toBe(true);
    expect(isNoopMove(groups, { id: "pc-0003", group: "Release", index: 1 })).toBe(true);
  });
  it("is false for a real reorder or a group change", () => {
    expect(isNoopMove(groups, { id: "pc-0001", group: "Release", index: 1 })).toBe(false);
    expect(isNoopMove(groups, { id: "pc-0001", group: "Later", index: 0 })).toBe(false);
  });
  it("treats any drop inside the unplanned group as nothing, since it is ordered by age", () => {
    expect(isNoopMove(groups, { id: "pc-0010", group: null, index: 0 })).toBe(true);
  });
});

describe("applyMove (optimistic repaint)", () => {
  it("moves between groups and renumbers the plan", () => {
    const next = applyMove(backlog(), { id: "pc-0002", group: "Release", index: 1 });
    const g = buildListGroups(next);
    expect(ids(g[0])).toEqual(["pc-0001", "pc-0002", "pc-0003"]);
    expect(ids(g[1])).toEqual([]);
    expect(next.todos.find((t) => t.id === "pc-0002").group).toBe("Release");
  });

  it("unplans: group and plan_index go null and the row joins Backlog", () => {
    const next = applyMove(backlog(), { id: "pc-0001", group: null, index: 0 });
    const t = next.todos.find((x) => x.id === "pc-0001");
    expect([t.group, t.plan_index]).toEqual([null, null]);
    expect(ids(buildListGroups(next)[0])).toEqual(["pc-0003"]);
  });

  it("returns the input untouched for an unknown id", () => {
    const b = backlog();
    expect(applyMove(b, { id: "pc-9999", group: "Release", index: 0 })).toBe(b);
  });

  it("does not mutate the original backlog", () => {
    const b = backlog();
    applyMove(b, { id: "pc-0001", group: "Later", index: 0 });
    expect(b.todos.find((t) => t.id === "pc-0001").group).toBe("Release");
  });
});

describe("reorderedGroups", () => {
  it("moves a heading in front of another, or to the end", () => {
    expect(reorderedGroups(["A", "B", "C"], "C", "A")).toEqual(["C", "A", "B"]);
    expect(reorderedGroups(["A", "B", "C"], "A", null)).toEqual(["B", "C", "A"]);
    expect(reorderedGroups(["A", "B", "C"], "B", "C")).toEqual(["A", "B", "C"]);
  });
});

describe("reader", () => {
  const sections = [
    { heading: "Goal", markdown: "Do it." },
    { heading: "Context", markdown: "Because." },
    { heading: "Approach", markdown: "- step" },
    { heading: "Acceptance", markdown: "- [ ] done" },
    { heading: "Verify", markdown: "run it" },
    { heading: "Notes", markdown: "   " },
  ];

  it("keeps file order, opens Context, Approach and Goal, and drops blank sections", () => {
    const s = readerSections(sections);
    expect(s.map((x) => x.heading)).toEqual(["Goal", "Context", "Approach", "Acceptance", "Verify"]);
    expect(s.map((x) => x.open)).toEqual([true, true, true, false, false]);
  });

  it("labels Acceptance as Done when", () => {
    expect(readerSections(sections).find((x) => x.heading === "Acceptance").label).toBe("Done when");
  });

  it("omits the Why block when the doc has none or only whitespace", () => {
    expect(readerWhy({ why: null })).toBeNull();
    expect(readerWhy({ why: "  \n " })).toBeNull();
    expect(readerWhy({ why: " Joe, 2026-10-28 " })).toBe("Joe, 2026-10-28");
  });

  it("shows worth as dots out of five", () => {
    expect(worthDots(null)).toBeNull();
    expect(worthDots(7)).toEqual({ on: 4, total: 5 });
    expect(worthDots(10)).toEqual({ on: 5, total: 5 });
    expect(worthDots(0)).toEqual({ on: 0, total: 5 });
  });

  it("writes meta as id and lowercase complexity", () => {
    expect(metaLine(todo("pc-1407", { complexity: "HARD" }))).toBe("pc-1407 \u00b7 hard");
    expect(metaLine(todo("pc-1407"))).toBe("pc-1407");
  });
});

describe("canAct", () => {
  it("allows actions only on the desktop pipe for a chat this machine hosts", () => {
    expect(canAct({ remote: false, mirrored: false })).toBe(true);
    expect(canAct({ remote: true, mirrored: false })).toBe(false);
    expect(canAct({ remote: false, mirrored: true })).toBe(false);
    expect(canAct({ remote: true, mirrored: true })).toBe(false);
  });
});
