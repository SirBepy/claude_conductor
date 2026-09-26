// Where "Create <name>" puts a new project. The inference rule is what lets
// the Create row show a real path on day one without the user configuring
// anything, so it is pinned here rather than left to the picker's render.

import { describe, it, expect } from "vitest";
import {
  inferProjectsRoot,
  resolveProjectsRoot,
  joinProjectPath,
  isValidProjectName,
} from "../src/views/sessions/projects-root.ts";

const ROOT = "c:\\Users\\tecno\\Desktop\\Projects";

describe("inferProjectsRoot", () => {
  it("picks the parent that most projects share", () => {
    const paths = [
      `${ROOT}\\zng-app`,
      `${ROOT}\\countoff`,
      `${ROOT}\\fibo`,
      "C:\\Users\\tecno\\.claude",
      "C:\\Users\\tecno\\Documents\\ObsidianVault",
    ];
    expect(inferProjectsRoot(paths)).toBe(ROOT);
  });

  it("counts case-insensitively but returns the original casing", () => {
    // The real registry holds both spellings of the same folder.
    const paths = [
      "C:\\Users\\tecno\\Desktop\\Projects\\a",
      "c:\\users\\tecno\\desktop\\projects\\b",
      "C:\\Users\\tecno\\Desktop\\Projects\\c",
    ];
    const out = inferProjectsRoot(paths);
    expect(out?.toLowerCase()).toBe("c:\\users\\tecno\\desktop\\projects");
    expect(out).toBe("C:\\Users\\tecno\\Desktop\\Projects");
  });

  it("returns null when no parent is shared by at least two projects", () => {
    expect(inferProjectsRoot([`${ROOT}\\only-one`])).toBeNull();
    expect(inferProjectsRoot(["C:\\a\\x", "C:\\b\\y", "C:\\c\\z"])).toBeNull();
  });

  it("returns null for an empty registry", () => {
    expect(inferProjectsRoot([])).toBeNull();
  });

  it("ignores drive and filesystem roots as candidates", () => {
    expect(inferProjectsRoot(["C:\\a", "C:\\b", "C:\\c"])).toBeNull();
    expect(inferProjectsRoot(["/a", "/b"])).toBeNull();
  });

  it("handles posix paths", () => {
    expect(inferProjectsRoot(["/home/joe/code/a", "/home/joe/code/b"]))
      .toBe("/home/joe/code");
  });

  it("is unbothered by a trailing separator", () => {
    expect(inferProjectsRoot([`${ROOT}\\a\\`, `${ROOT}\\b`])).toBe(ROOT);
  });
});

describe("resolveProjectsRoot", () => {
  const paths = [`${ROOT}\\a`, `${ROOT}\\b`];

  it("prefers an explicitly stored root over the inference", () => {
    expect(resolveProjectsRoot("D:\\elsewhere", paths)).toBe("D:\\elsewhere");
  });

  it("falls back to the inference when nothing is stored", () => {
    expect(resolveProjectsRoot(null, paths)).toBe(ROOT);
    expect(resolveProjectsRoot("", paths)).toBe(ROOT);
    expect(resolveProjectsRoot(undefined, paths)).toBe(ROOT);
  });

  it("is null when neither is available, so Create must ask", () => {
    expect(resolveProjectsRoot(null, [])).toBeNull();
  });
});

describe("joinProjectPath", () => {
  it("uses the separator the root itself uses", () => {
    expect(joinProjectPath(ROOT, "side-quest")).toBe(`${ROOT}\\side-quest`);
    expect(joinProjectPath("/home/joe/code", "side-quest")).toBe("/home/joe/code/side-quest");
  });

  it("does not double a trailing separator", () => {
    expect(joinProjectPath(`${ROOT}\\`, "x")).toBe(`${ROOT}\\x`);
  });
});

describe("isValidProjectName", () => {
  it("accepts ordinary folder names", () => {
    expect(isValidProjectName("side-quest")).toBe(true);
    expect(isValidProjectName("my_project 2")).toBe(true);
  });

  it("rejects empty and whitespace-only", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("   ")).toBe(false);
  });

  it("rejects anything that is a path rather than a name", () => {
    expect(isValidProjectName("../evil")).toBe(false);
    expect(isValidProjectName("a/b")).toBe(false);
    expect(isValidProjectName("a\\b")).toBe(false);
    expect(isValidProjectName("C:\\Windows")).toBe(false);
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects the Windows-illegal characters", () => {
    for (const ch of ["*", "?", '"', "<", ">", "|", ":"]) {
      expect(isValidProjectName(`bad${ch}name`)).toBe(false);
    }
  });
});
