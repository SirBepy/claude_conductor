// @vitest-environment jsdom
// asserts: src/shared/chat/composer-skill-scope.ts

// The phone can enable an off-here skill too: the warning offers "Enable here"
// next to "Send anyway", a send needs the enable step, and enabling goes through
// the same `enable_skill_here` command the desktop uses (http-transport.ts turns
// it into two narrow daemon RPCs).

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => true }));
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

function setup(sessionId = "sess-1") {
  const el = document.createElement("div");
  const notices = [];
  const warn = new SkillScopeWarning({
    getProjectDir: () => "/repo",
    getSessionId: () => sessionId,
    getEntries: () => [entry],
    refreshEntries: async () => {},
    sendAnyway: () => {},
    sendWithEnable: () => {},
    notice: (t) => notices.push(t),
  });
  warn.bind(el);
  return { el, warn, notices };
}

describe("composer skill scope on the phone", () => {
  it("offers Enable here beside Send anyway", () => {
    const { el, warn } = setup();
    warn.update("/figma-tiles go");
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Enable here", "Send anyway"]);
  });

  it("makes a send of an off-here skill enable it first", () => {
    const { warn } = setup();
    expect(warn.needsEnable("/figma-tiles go")?.name).toBe("figma-tiles");
    expect(warn.needsEnable("/other go")).toBeNull();
  });

  it("enables through enable_skill_here with the project dir, key and live session", async () => {
    const { warn, notices } = setup();
    invokeMock.mockClear();
    expect(await warn.enable(entry)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("enable_skill_here", { projectDir: "/repo", key: "figma-tiles", sessionId: "sess-1" });
    expect(notices.at(-1)).toContain("is now enabled in this project");
  });
});
