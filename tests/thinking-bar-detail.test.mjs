// @vitest-environment jsdom

// The working bar's line opens a block with the full command (the label used to
// be cut at 60 characters inside the string itself, so nothing could show the
// rest), and Stop lives in that block because a phone has no hover.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { activityDetail, capActivityText } = await import("../src/shared/chat/tool-meta.ts");
const { describeActivity, describeActivityFull } = await import("../src/shared/chat/chat-dom-renderer.ts");
const {
  initThinkingBar, syncThinkingBar, thinkingBarHtml, wireThinkingBar, updateThinkingBar, setThinkingActivity,
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

  it("keeps an enormous command whole in the detail and cuts only its display form", () => {
    const text = activityDetail("Bash", { command: "x".repeat(5000) }).text;
    expect(text.length).toBe(5000);
    const shown = capActivityText(text);
    expect(shown.length).toBeLessThan(2100);
    expect(shown.endsWith("…")).toBe(true);
    expect(capActivityText("short")).toBe("short");
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

// A chat busy only through background tasks, or whose user message sits outside
// the loaded history page, has no renderer turn start (0), so the bar's own
// busy-since is the only clock it has.
describe("the elapsed clock of a busy chat with no turn start", () => {
  let pane;
  const noStart = () => ({
    lastActivity: null, activityIdle: false, lastProgress: null, lastTodoActivity: null,
    activeTurnStartedAtMs: 0,
  });
  const clock = () => pane.querySelector(".thinking-row .thinking-elapsed").textContent;
  // Mirrors a chat switch: the pane is torn down and re-initialised, then the
  // incoming chat's renderer is synced in.
  const mount = (id, src = noStart()) => {
    state.selectedId = id;
    initThinkingBar(pane);
    syncThinkingBar(src);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
    state.pendingNewSession = null;
    state.heldMessages = null;
    state.sessions = [
      { session_id: "chat-a", busy: true },
      { session_id: "chat-b", busy: false },
    ];
    pane = document.createElement("div");
    pane.innerHTML = thinkingBarHtml();
  });

  afterEach(() => {
    // The busy-since map is module state: settle each chat idle so a stamp from
    // this test cannot leak into the next.
    state.sessions = [];
    for (const id of ["chat-a", "chat-b"]) {
      state.selectedId = id;
      updateThinkingBar();
    }
    initThinkingBar(null);
    vi.useRealTimers();
  });

  it("keeps counting from the real start when the chat is left and returned to", () => {
    mount("chat-a");
    expect(clock()).toBe("0:00");

    vi.advanceTimersByTime(30_000);
    mount("chat-b");
    vi.advanceTimersByTime(10_000);
    mount("chat-a");

    expect(clock()).toBe("0:40");
  });

  it("keeps the start across a second sync of the same chat", () => {
    mount("chat-a");
    vi.advanceTimersByTime(20_000);
    syncThinkingBar(noStart());

    expect(clock()).toBe("0:20");
  });

  it("starts a new clock once the chat has gone idle and then busy again", () => {
    mount("chat-a");
    vi.advanceTimersByTime(30_000);
    state.sessions = [{ session_id: "chat-a", busy: false }, { session_id: "chat-b", busy: false }];
    updateThinkingBar();
    vi.advanceTimersByTime(5_000);
    state.sessions = [{ session_id: "chat-a", busy: true }, { session_id: "chat-b", busy: false }];
    updateThinkingBar();

    expect(clock()).toBe("0:00");
  });

  it("keeps each chat's clock apart", () => {
    mount("chat-a");
    vi.advanceTimersByTime(30_000);
    state.sessions = [{ session_id: "chat-a", busy: true }, { session_id: "chat-b", busy: true }];
    mount("chat-b");
    vi.advanceTimersByTime(5_000);

    expect(clock()).toBe("0:05");
    mount("chat-a");
    expect(clock()).toBe("0:35");
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

  it("shows no Stop anywhere while messages are held, since Interrupt & send is the interrupt", () => {
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

  it("copies a 5000-character command whole while the block shows it cut", async () => {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const renderer = new ChatRenderer(document.createElement("div"));
    renderer.onActivityUpdate = (activity, idle) => setThinkingActivity(activity, idle);
    syncThinkingBar(renderer);
    pane.querySelector(".thinking-main").click();
    const command = "echo " + "x".repeat(4995);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    try {
      renderer.setActivity("Running: big", { detail: activityDetail("Bash", { command }) });
      expect(pane.querySelector(".thinking-cmd code").textContent.length).toBeLessThan(2100);

      pane.querySelector(".thinking-copy").click();

      expect(writeText).toHaveBeenCalledWith(command);
      expect(command.length).toBe(5000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the second command when two tool calls share one label", async () => {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const renderer = new ChatRenderer(document.createElement("div"));
    renderer.onActivityUpdate = (activity, idle) => setThinkingActivity(activity, idle);
    syncThinkingBar(renderer);
    pane.querySelector(".thinking-main").click();

    const label = "Running: Read the CSS";
    renderer.setActivity(label, { detail: { tool: "Bash", text: "cat a.css" } });
    expect(pane.querySelector(".thinking-cmd code").textContent).toBe("cat a.css");

    renderer.setActivity(label, { detail: { tool: "Bash", text: "cat b.css" } });
    expect(pane.querySelector(".thinking-cmd code").textContent).toBe("cat b.css");
  });

  it("does not notify when the same label and an equal detail arrive again", async () => {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const renderer = new ChatRenderer(document.createElement("div"));
    const seen = vi.fn();
    renderer.onActivityUpdate = seen;

    renderer.setActivity("Running: x", { detail: { tool: "Bash", text: "cat a.css" } });
    renderer.setActivity("Running: x", { detail: { tool: "Bash", text: "cat a.css" } });

    expect(seen).toHaveBeenCalledTimes(1);
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
