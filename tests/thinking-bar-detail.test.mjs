// @vitest-environment jsdom

// The working bar's line opens a block with the full command (the label used to
// be cut at 60 characters inside the string itself, so nothing could show the
// rest), and Stop lives in that block because a phone has no hover.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { activityDetail } = await import("../src/shared/chat/tool-meta.ts");
const { describeActivity, describeActivityFull } = await import("../src/shared/chat/chat-dom-renderer.ts");
const {
  initThinkingBar, syncThinkingBar, thinkingBarHtml, wireThinkingBar, updateThinkingBar,
} = await import("../src/views/sessions/session-thinking-bar.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { formatElapsed } = await import("../src/shared/time.ts");

const COMMAND = 'cat permission-modal-track.css; sed -n 295,325p permission-modal-track.css; rg -n "prompt-card" src/views/sessions -g "*.css" | head -40';

describe("activity label and detail", () => {
  it("prints a shell command whole in the bar's label, where the agent-dot label cuts it", () => {
    const input = { command: COMMAND };
    expect(describeActivityFull("PowerShell", input)).toBe(`Running: ${COMMAND}`);
    // toolSummary stops a command at 48 characters, with no ellipsis of its own.
    expect(describeActivity("PowerShell", input)).toBe(`Running: ${COMMAND.slice(0, 48)}`);
  });

  it("prefers a shell call's description over its command in the label, and keeps the command for the opened block", () => {
    const input = { command: COMMAND, description: "Read the permission modal CSS" };
    expect(describeActivityFull("Bash", input)).toBe("Running: Read the permission modal CSS");
    expect(activityDetail("Bash", input)).toEqual({ tool: "Bash", text: COMMAND });
  });

  it("collapses a multi-line command to one line in the label only", () => {
    const input = { command: "git status\n  git diff" };
    expect(describeActivityFull("Bash", input)).toBe("Running: git status git diff");
    expect(activityDetail("Bash", input).text).toBe("git status\n  git diff");
  });

  it("gives each file and search tool its real argument, and none to a tool without one", () => {
    expect(activityDetail("Read", { file_path: "C:/a/b/composer.css" }).text).toBe("C:/a/b/composer.css");
    expect(activityDetail("Grep", { pattern: "foo", path: "src" }).text).toBe("foo  in src");
    expect(activityDetail("Task", { description: "x" }).text).toBeNull();
  });

  it("caps an enormous command so the opened block stays a block", () => {
    const text = activityDetail("Bash", { command: "x".repeat(5000) }).text;
    expect(text.length).toBeLessThan(2100);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("reads m:ss, then h:mm:ss past the hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("the opened block", () => {
  let pane;
  let onStop;
  const source = (over = {}) => ({
    lastActivity: `Running: ${COMMAND}`,
    activityIdle: false,
    lastProgress: null,
    lastTodoActivity: null,
    lastActivityDetail: { tool: "PowerShell", text: COMMAND },
    activeTurnStartedAtMs: Date.now() - 42_000,
    ...over,
  });

  beforeEach(() => {
    state.pendingNewSession = null;
    state.heldMessages = null;
    state.selectedId = "chat-a";
    state.sessions = [{ session_id: "chat-a", busy: true }];
    pane = document.createElement("div");
    pane.innerHTML = thinkingBarHtml();
    initThinkingBar(pane);
    onStop = vi.fn();
    wireThinkingBar(pane, onStop);
  });

  it("opens on a click of the line, showing the full command, the tool and the elapsed time", () => {
    syncThinkingBar(source());
    const bar = pane.querySelector(".session-thinking");
    expect(pane.querySelector(".thinking-detail").hidden).toBe(true);

    pane.querySelector(".thinking-main").click();

    expect(bar.classList.contains("is-open")).toBe(true);
    expect(pane.querySelector(".thinking-detail").hidden).toBe(false);
    expect(pane.querySelector(".thinking-cmd code").textContent).toBe(COMMAND);
    expect(pane.querySelector(".thinking-meta").textContent).toContain("PowerShell");
    expect(pane.querySelector(".thinking-detail .thinking-elapsed").textContent).toBe("0:42");
    expect(pane.querySelector(".thinking-main").getAttribute("aria-expanded")).toBe("true");

    pane.querySelector(".thinking-main").click();
    expect(pane.querySelector(".thinking-detail").hidden).toBe(true);
  });

  it("puts Stop in the opened block, and both Stop buttons end the turn", () => {
    syncThinkingBar(source());
    pane.querySelector(".thinking-main").click();

    pane.querySelector(".thinking-stop-turn").click();
    pane.querySelector(".thinking-pause-btn").click();

    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("offers Stop while a turn is busy even when the tool has no command to show", () => {
    syncThinkingBar(source({ lastActivity: null, lastActivityDetail: null }));
    pane.querySelector(".thinking-main").click();

    expect(pane.querySelector(".thinking-cmd")).toBeNull();
    expect(pane.querySelector(".thinking-stop-turn")).not.toBeNull();
  });

  it("shows no Stop anywhere while messages are held, since Send now is the interrupt", () => {
    state.heldMessages = { hasItemsForActive: () => true, renderChip: () => {}, attach: () => {} };
    syncThinkingBar(source());
    pane.querySelector(".thinking-main").click();

    expect(pane.querySelector(".thinking-pause-btn").hidden).toBe(true);
    expect(pane.querySelector(".thinking-stop-turn")).toBeNull();
  });

  it("closes and cannot be opened once the turn is over", () => {
    syncThinkingBar(source());
    pane.querySelector(".thinking-main").click();
    expect(pane.querySelector(".session-thinking").classList.contains("is-open")).toBe(true);

    state.sessions = [{ session_id: "chat-a", busy: false }];
    updateThinkingBar();

    expect(pane.querySelector(".session-thinking").classList.contains("is-open")).toBe(false);
    expect(pane.querySelector(".thinking-main").disabled).toBe(true);
    expect(pane.querySelector(".thinking-detail").hidden).toBe(true);
  });

  it("keeps a selection alive: an unchanged detail is not redrawn on the next event", () => {
    syncThinkingBar(source());
    pane.querySelector(".thinking-main").click();
    const code = pane.querySelector(".thinking-cmd code");

    updateThinkingBar();
    updateThinkingBar();

    expect(pane.querySelector(".thinking-cmd code")).toBe(code);
  });
});
