// @vitest-environment jsdom

// The Skills views' side of per-project skill scope: reading
// `skillScopes` out of settings, the list's one-line summary, and the editor's
// segmented control and project chips.

import { describe, it, expect, vi } from "vitest";
import { render } from "lit-html";

vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings: vi.fn() }));
const { readScopes, scopeSummary, scopeEditor } = await import("../src/views/skill-detail/scope-editor.ts");

const projects = [
  { id: "p1", name: "zng-app", path: "C:/w/zng" },
  { id: "p2", name: "cueline", path: "C:/w/cue" },
  { id: "p3", name: "dashboard-a", path: "C:/w/dash" },
];

describe("readScopes", () => {
  it("reads valid entries, defaults elsewhere to off, skips junk", () => {
    expect(
      readScopes({ skillScopes: { a: { projects: ["p1", 3] }, b: { projects: [], elsewhere: "name-only" }, c: 5 } }),
    ).toEqual({ a: { projects: ["p1"], elsewhere: "off" }, b: { projects: [], elsewhere: "name-only" } });
    expect(readScopes(null)).toEqual({});
  });
});

describe("scopeSummary", () => {
  it("names one project, counts several, and notes name-only", () => {
    expect(scopeSummary(undefined, projects)).toBeNull();
    expect(scopeSummary({ projects: ["p1"], elsewhere: "off" }, projects)).toBe("zng-app");
    expect(scopeSummary({ projects: ["p1", "p2"], elsewhere: "name-only" }, projects)).toBe("2 projects, name only elsewhere");
    expect(scopeSummary({ projects: [], elsewhere: "off" }, projects)).toBe("no projects");
  });

  it("falls back to the folder name of an unnamed project, Windows separators included", () => {
    const unnamed = [{ id: "w", path: "C:\\Users\\joe\\proj\\" }];
    expect(scopeSummary({ projects: ["w"], elsewhere: "off" }, unnamed)).toBe("proj");
  });
});

describe("scopeEditor", () => {
  const skill = { skill: "figma-tiles", description: "", plugin: null, project: null, scope_key: "figma-tiles" };

  function mount(props) {
    const el = document.createElement("div");
    const onChange = vi.fn();
    render(scopeEditor({ skill, scope: null, projects, addOpen: false, onToggleAdd: () => {}, onChange, ...props }), el);
    return { el, onChange };
  }

  it("an unscoped skill shows Every project, and Only some projects starts an empty scope", () => {
    const { el, onChange } = mount({});
    const [every, only] = el.querySelectorAll(".skill-scope-seg button");
    expect(every.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector(".skill-scope-chips")).toBeNull();
    only.click();
    expect(onChange).toHaveBeenCalledWith({ projects: [], elsewhere: "off" });
  });

  it("removes a chip, adds a project from the menu, and switches to name only", () => {
    const scope = { projects: ["p1", "p2"], elsewhere: "off" };
    const { el, onChange } = mount({ scope, addOpen: true });
    expect([...el.querySelectorAll(".skill-scope-chip")].map((c) => c.textContent.trim())).toEqual(["zng-app", "cueline"]);
    el.querySelector(".skill-scope-chip button").click();
    expect(onChange).toHaveBeenLastCalledWith({ projects: ["p2"], elsewhere: "off" });
    const menu = [...el.querySelectorAll(".skill-scope-menu div")];
    expect(menu.map((d) => d.textContent)).toEqual(["dashboard-a"]);
    menu[0].click();
    expect(onChange).toHaveBeenLastCalledWith({ projects: ["p1", "p2", "p3"], elsewhere: "off" });
    const nameOnly = [...el.querySelectorAll(".skill-scope-seg button")].find((b) => b.textContent === "Name only");
    nameOnly.click();
    expect(onChange).toHaveBeenLastCalledWith({ projects: ["p1", "p2"], elsewhere: "name-only" });
  });

  it("a plugin skill scopes the whole plugin and has no name-only choice", () => {
    const plugin = { skill: "figma:figma-use", description: "", plugin: "figma", project: null, scope_key: "figma@claude-plugins-official" };
    const { el } = mount({ skill: plugin, scope: { projects: ["p1"], elsewhere: "off" } });
    expect(el.textContent).toContain("Applies to the whole figma plugin");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Name only")).toBe(false);
  });

  it("a project skill has no scope box", () => {
    const { el } = mount({ skill: { ...skill, scope_key: null, project: "app" } });
    expect(el.querySelector(".skill-scope")).toBeNull();
  });
});
