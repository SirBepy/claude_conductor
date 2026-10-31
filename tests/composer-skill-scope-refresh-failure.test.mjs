// @vitest-environment jsdom
// asserts: src/shared/chat/composer-skill-scope.ts

// enable_skill_here saves the scope; the slash-list re-read afterwards is only
// cosmetic. A failed re-read must not be reported as "Couldn't enable" (the
// skill IS enabled) and must not make enable() return false, which would block
// the send the user asked for.

import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn(async () => true);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { SkillScopeWarning } = await import("../src/shared/chat/composer-skill-scope.ts");

const entry = {
  name: "figma-tiles",
  args: null,
  description: "d",
  source: { kind: "user-skill" },
  path: null,
  menu_hidden: false,
  scope_key: "figma-tiles",
  off_here: true,
};

function setup(refreshEntries) {
  const notices = [];
  const warn = new SkillScopeWarning({
    getProjectDir: () => "/repo",
    getSessionId: () => "sess-1",
    getEntries: () => [entry],
    refreshEntries,
    sendAnyway: () => {},
    sendWithEnable: () => {},
    notice: (t) => notices.push(t),
  });
  warn.bind(document.createElement("div"));
  return { warn, notices };
}

describe("SkillScopeWarning.enable when the refresh fails", () => {
  it("still reports success after the scope write succeeded", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockClear();
    const { warn, notices } = setup(async () => { throw new Error("slash list read failed"); });
    expect(await warn.enable(entry)).toBe(true);
    expect(notices).toEqual(["/figma-tiles is now enabled in this project."]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("still reports failure when the scope write itself fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce("not_a_project");
    const refresh = vi.fn(async () => {});
    const { warn, notices } = setup(refresh);
    expect(await warn.enable(entry)).toBe(false);
    expect(notices[0]).toContain("Couldn't enable /figma-tiles");
    expect(refresh).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
