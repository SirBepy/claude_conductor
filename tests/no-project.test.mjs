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

describe("renderAvatar image branch", () => {
  it("escapes an avatar path that carries HTML-special characters", () => {
    // A stored avatar path is attacker-influenced data (round 2 security
    // audit, 2026-10-18): it must not be able to break out of the img src
    // attribute and inject a new attribute/element.
    const html = renderAvatar({ kind: "image", value: 'x.png"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });

  it("still renders a normal avatar path as a plain file:/// src", () => {
    const html = renderAvatar({ kind: "image", value: "C:\\Users\\tecno\\avatar.png" });
    expect(html).toContain('src="file:///C:/Users/tecno/avatar.png"');
  });
});

describe("renderAvatar machine-aware project face", () => {
  it("stamps data-proj-face-machine when a machineId is given, so hydrateProjectTechIcons knows which peer's filesystem to ask", () => {
    const html = renderAvatar(null, "/Users/joe/repo", "mac-mini-id");
    expect(html).toContain('data-proj-face-machine="mac-mini-id"');
    expect(html).toContain('data-proj-face="/Users/joe/repo"');
  });

  it("omits the attribute entirely for a local path (no machineId), unchanged from before the param existed", () => {
    const html = renderAvatar(null, "C:\\Users\\tecno\\Desktop\\Projects\\countoff");
    expect(html).not.toContain("data-proj-face-machine");
  });
});
