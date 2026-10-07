// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { isNoProjectPath, NO_PROJECT_LABEL, NO_PROJECT_ICON_HTML } from "../src/shared/no-project.ts";
import { setSettings } from "../src/shared/state.ts";
import { cwdToProjectName, projectName } from "../src/views/sessions/sessions-helpers.ts";
import { renderAvatar } from "../src/shared/projects.ts";

afterEach(() => setSettings({}));

describe("isNoProjectPath", () => {
  it("defaults to the Obsidian vault in Documents", () => {
    expect(isNoProjectPath("C:\\Users\\tecno\\Documents\\ObsidianVault")).toBe(true);
    expect(isNoProjectPath("C:/Users/tecno/Documents/ObsidianVault/")).toBe(true);
  });

  it("does not match a project folder", () => {
    expect(isNoProjectPath("C:\\Users\\tecno\\Desktop\\Projects\\countoff")).toBe(false);
    expect(isNoProjectPath("C:\\Users\\tecno\\Documents\\ObsidianVault\\notes")).toBe(false);
    expect(isNoProjectPath("")).toBe(false);
    expect(isNoProjectPath(null)).toBe(false);
  });

  it("ignores a hand-edited noProjectDir setting, the vault is the only folder", () => {
    setSettings({ noProjectDir: "D:\\scratch\\home" });
    expect(isNoProjectPath("d:/scratch/home")).toBe(false);
    expect(isNoProjectPath("C:\\Users\\tecno\\Documents\\ObsidianVault")).toBe(true);
  });
});

describe("no-project labels", () => {
  it("names a no-project chat 'No project' instead of the folder", () => {
    expect(cwdToProjectName("C:\\Users\\tecno\\Documents\\ObsidianVault")).toBe(NO_PROJECT_LABEL);
    expect(projectName({ cwd: "C:\\Users\\tecno\\Documents\\ObsidianVault" })).toBe(NO_PROJECT_LABEL);
  });

  it("leaves every other project's name alone", () => {
    expect(cwdToProjectName("C:\\Users\\tecno\\Desktop\\Projects\\countoff")).toBe("countoff");
  });

  it("renders the no-project icon even over a user-set avatar", () => {
    const html = renderAvatar({ kind: "emoji", value: "x" }, "C:\\Users\\tecno\\Documents\\ObsidianVault");
    expect(html).toBe(NO_PROJECT_ICON_HTML);
  });
});
