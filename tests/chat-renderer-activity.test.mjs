// Tests for the thinking-bar activity feed + turn-steps pill.
//
// Feature 1: the last real tool action stays PINNED through the streaming reply
// and turn end (no clear-to-verb mid-turn); it resets only on the next
// user_message. Observed via the onActivityUpdate callback (fires on change).
//
// Feature 2: the collapsed turn-steps <details> summary counts ALL intermediate
// messages between the user message and the final answer (not just tool calls).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, streamingEvent, finalEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function toolUse(toolName, input, id) {
  return { type: "tool_use", tool_name: toolName, input, id };
}

function turnUsage() {
  return {
    type: "turn_usage",
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    has_thinking: false,
    model: "m",
    timestamp: 0,
  };
}

describe("ChatRenderer — activity pinning", () => {
  it("keeps the last tool action pinned through the streaming reply (no clear)", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a) => seen.push(a);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Read", { file_path: "/foo/bar.ts" }, "t1"), { silent: true });
    r.handleEvent(streamingEvent("here is the answer…"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    r.handleEvent(turnUsage(), { silent: true });

    // The action emitted is the last meaningful value; streaming/final/turn_usage
    // must not push a null afterwards.
    expect(seen).toContain("Reading bar.ts");
    expect(seen[seen.length - 1]).toBe("Reading bar.ts");
  });

  it("resets the pinned action to null on the next user_message", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a) => seen.push(a);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Write", { file_path: "/foo/baz.ts" }, "t1"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });
    r.handleEvent(turnUsage(), { silent: true });
    r.handleEvent(userEvent("again"), { silent: true });

    expect(seen[seen.length - 1]).toBeNull();
  });
});

describe("ChatRenderer - activity idles (not blanks) once a turn's tools all resolve", () => {
  it("keeps the label but marks it idle once the sole outstanding tool's result lands", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a, idle) => seen.push([a, !!idle]);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Read", { file_path: "/foo/bar.ts" }, "t1"), { silent: true });
    expect(seen[seen.length - 1]).toEqual(["Reading bar.ts", false]);
    r.handleEvent({ type: "tool_result", tool_use_id: "t1", output: "hi", is_error: false }, { silent: true });

    // Result lands: text is NOT blanked to null (would flash the thinking bar
    // to generic "Thinking..." for a fast tool) - it's kept and flagged idle
    // so the UI can suffix it instead.
    expect(seen[seen.length - 1]).toEqual(["Reading bar.ts", true]);
  });

  it("does not blank the label while a sibling tool is still outstanding", () => {
    const r = new ChatRenderer(document.createElement("div"));
    const seen = [];
    r.onActivityUpdate = (a, idle) => seen.push([a, !!idle]);

    r.handleEvent(userEvent("go"), { silent: true });
    r.handleEvent(toolUse("Read", { file_path: "/a.ts" }, "t1"), { silent: true });
    r.handleEvent(toolUse("Edit", { file_path: "/b.ts", old_string: "a", new_string: "b" }, "t2"), { silent: true });
    r.handleEvent({ type: "tool_result", tool_use_id: "t1", output: "hi", is_error: false }, { silent: true });

    // t2 (Edit) is still outstanding - the label must still read its activity,
    // never null, and never flip back to t1's.
    expect(seen.map((s) => s[0])).not.toContain(null);
    expect(seen[seen.length - 1]).toEqual(["Editing b.ts", false]);

    r.handleEvent({ type: "tool_result", tool_use_id: "t2", output: "hi", is_error: false }, { silent: true });
    expect(seen[seen.length - 1]).toEqual(["Editing b.ts", true]);
  });
});

describe("ChatRenderer — per-type tool chips (inline strip)", () => {
  it("folds a turn's tool call into a chip counting tool_use only", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("do it"));
    r.handleEvent(toolUse("Bash", { command: "ls" }, "t1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "t1", output: "file.txt", is_error: false });
    r.handleEvent(streamingEvent("running…"));
    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());

    const chip = container.querySelector('.tool-chip[data-tool="Bash"]');
    expect(chip).not.toBeNull();
    // tool_use counts, tool_result does not.
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x1");
    // Both the tool_use row and its result live inside the bucket.
    const bucket = container.querySelector('.tool-strip-group[data-tool="Bash"]');
    expect(bucket.querySelectorAll(".tool-row").length).toBe(2);
    // The final answer stays outside the panel.
    const panel = container.querySelector(".tool-strip-panel");
    expect(panel.contains(container.querySelector(".msg.assistant"))).toBe(false);
  });

  it("folds repeated calls of the same type into one growing count, live", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("search"));
    r.handleEvent(toolUse("Grep", { pattern: "a" }, "g1"));
    let chip = container.querySelector('.tool-chip[data-tool="Grep"]');
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x1");
    r.handleEvent(toolUse("Grep", { pattern: "b" }, "g2"));
    r.handleEvent(toolUse("Grep", { pattern: "c" }, "g3"));
    chip = container.querySelector('.tool-chip[data-tool="Grep"]');
    // One chip, count grew to 3.
    expect(container.querySelectorAll('.tool-chip[data-tool="Grep"]').length).toBe(1);
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");
  });

  it("keeps distinct tool types in separate chips on one strip", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUse("Grep", { pattern: "a" }, "g1"));
    r.handleEvent(toolUse("Read", { file_path: "/a/x.ts" }, "r1"));
    r.handleEvent(toolUse("Grep", { pattern: "b" }, "g2"));

    expect(container.querySelector('.tool-chip[data-tool="Grep"] .tool-chip-count').textContent).toBe("x2");
    expect(container.querySelector('.tool-chip[data-tool="Read"] .tool-chip-count').textContent).toBe("x1");
    // Both chips are on the same strip.
    expect(container.querySelectorAll(".tool-strip").length).toBe(1);
  });

  it("combines Edit + Write into one 'File Changes' chip with a per-file view", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("edit"));
    r.handleEvent(toolUse("Edit", { file_path: "/a/x.ts", old_string: "a", new_string: "b" }, "e1"));
    r.handleEvent(toolUse("Write", { file_path: "/a/y.ts", content: "hi" }, "w1"));
    r.handleEvent(toolUse("Edit", { file_path: "/a/z.ts", old_string: "c", new_string: "d" }, "e2"));

    // One chip (data-tool="Edit") counts Edit + Write + MultiEdit together.
    const editChip = container.querySelector('.tool-chip[data-tool="Edit"]');
    expect(editChip).not.toBeNull();
    expect(editChip.querySelector(".tool-chip-label").textContent).toBe("File Changes");
    expect(editChip.querySelector(".tool-chip-count").textContent).toBe("x3");
    // Write does NOT get its own chip anymore.
    expect(container.querySelector('.tool-chip[data-tool="Write"]')).toBeNull();

    // The custom view aggregates one row per file (no raw edit cards left).
    const editBucket = container.querySelector('.tool-strip-group[data-tool="Edit"]');
    expect(editBucket).not.toBeNull();
    expect(editBucket.querySelectorAll(".tool-file-row").length).toBe(3);
    expect(container.querySelectorAll(".tool-use--file").length).toBe(0);
  });

  it("highlights only the CURRENT-activity chip, not every in-flight tool", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    const mainStrip = () =>
      Array.from(container.querySelectorAll(".tool-strip")).find((s) => !s.closest(".tool-strip-group"));
    const running = (tool) =>
      mainStrip().querySelector(`.tool-chip[data-tool="${tool}"]`).classList.contains("tool-chip--running");

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));
    // Two tools dispatched in parallel, neither has returned. Read fired first,
    // Edit is the latest -> Edit ("Editing …") is the current activity.
    r.handleEvent(toolUse("Read", { file_path: "/a.ts" }, "r1"));
    r.handleEvent(toolUse("Edit", { file_path: "/b.ts", old_string: "a", new_string: "b" }, "e1"));

    // Only the File-Changes (Edit) chip pulses, even though Read is also still
    // in-flight. (The bug: every in-flight chip lit up.)
    expect(running("Edit")).toBe(true);
    expect(running("Read")).toBe(false);

    // Activity moves to a new Read -> the single highlight follows it.
    r.handleEvent(toolUse("Read", { file_path: "/c.ts" }, "r2"));
    expect(running("Read")).toBe(true);
    expect(running("Edit")).toBe(false);

    // Turn closes -> nothing pulses.
    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());
    r.handleEvent(userEvent("next"));
    expect(container.querySelectorAll(".tool-chip--running").length).toBe(0);
  });

  it("groups a turn whose tools span a bulk-load chunk boundary into ONE strip (reload)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    // 5 Bash calls = 10 tool events; with the user/session/final/turn_usage
    // events the turn spans more than one CHUNK (8) in bulkLoadEvents, so the
    // turn straddles a flush boundary on reload - the real-world case the
    // 6-event test never hit.
    const events = [
      { type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 },
      userEvent("do it"),
    ];
    for (let i = 1; i <= 5; i++) {
      events.push(toolUse("Bash", { command: `cmd${i}` }, `t${i}`));
      events.push({ type: "tool_result", tool_use_id: `t${i}`, output: "ok", is_error: false });
    }
    events.push(finalEvent("done"));
    events.push(turnUsage());

    await r.loadHistory(events);

    // All five calls must fold into a SINGLE strip with one Bash chip at x5,
    // and no tool row may be left ungrouped (rendered as a bare row).
    expect(container.querySelectorAll(".tool-strip").length).toBe(1);
    expect(container.querySelectorAll('.tool-chip[data-tool="Bash"]').length).toBe(1);
    expect(container.querySelector('.tool-chip[data-tool="Bash"] .tool-chip-count').textContent).toBe("x5");
    const ungrouped = Array.from(container.querySelectorAll(".tool-row"))
      .filter((el) => el.dataset.toolGrouped !== "1");
    expect(ungrouped.length).toBe(0);
  });

  it("nests child tool calls under the parent Subagent chip", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));

    // Agent dispatch (main-agent, no parent)
    r.handleEvent(toolUse("Task", { description: "x", prompt: "y" }, "agent1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "agent1", output: "done", is_error: false });

    // Child tool_use events (parentToolUseId = "agent1")
    const childGrep1 = { type: "tool_use", tool_name: "Grep", input: { pattern: "foo" }, id: "c1", parent_tool_use_id: "agent1" };
    const childGrep1Result = { type: "tool_result", tool_use_id: "c1", output: "hit", is_error: false };
    const childGrep2 = { type: "tool_use", tool_name: "Grep", input: { pattern: "bar" }, id: "c2", parent_tool_use_id: "agent1" };
    const childGrep2Result = { type: "tool_result", tool_use_id: "c2", output: "hit2", is_error: false };
    const childRead = { type: "tool_use", tool_name: "Read", input: { file_path: "/a/b.ts" }, id: "c3", parent_tool_use_id: "agent1" };
    const childReadResult = { type: "tool_result", tool_use_id: "c3", output: "content", is_error: false };

    r.handleEvent(childGrep1);
    r.handleEvent(childGrep1Result);
    r.handleEvent(childGrep2);
    r.handleEvent(childGrep2Result);
    r.handleEvent(childRead);
    r.handleEvent(childReadResult);

    // Main-agent Bash (no parent)
    r.handleEvent(toolUse("Bash", { command: "echo hi" }, "m1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "m1", output: "hi", is_error: false });

    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());

    // --- main strip assertions ---
    // Exactly one main .tool-strip (not inside a .tool-strip-group)
    const allStrips = Array.from(container.querySelectorAll(".tool-strip"));
    const mainStrips = allStrips.filter(s => !s.closest(".tool-strip-group"));
    expect(mainStrips.length).toBe(1);
    const mainStrip = mainStrips[0];

    // Main strip has Subagent chip (x1) and Bash chip (x1), NO Grep/Read chips
    const subagentChip = mainStrip.querySelector('.tool-chip[data-tool="Task"]') ||
                         mainStrip.querySelector('.tool-chip[data-tool="Agent"]');
    expect(subagentChip).not.toBeNull();
    expect(subagentChip.querySelector(".tool-chip-count").textContent).toBe("x1");

    const bashChip = mainStrip.querySelector('.tool-chip[data-tool="Bash"]');
    expect(bashChip).not.toBeNull();
    expect(bashChip.querySelector(".tool-chip-count").textContent).toBe("x1");

    expect(mainStrip.querySelector('.tool-chip[data-tool="Grep"]')).toBeNull();
    expect(mainStrip.querySelector('.tool-chip[data-tool="Read"]')).toBeNull();

    // --- nested strip assertions (3 levels: Subagent > subagent > tool-type) ---
    const mainPanel = mainStrip.nextElementSibling;
    const subagentKey = subagentChip.dataset.tool; // "Task" or "Agent"
    const agentBucket = mainPanel.querySelector(`:scope > .tool-strip-group[data-tool="${subagentKey}"]`);
    expect(agentBucket).not.toBeNull();

    // Level 1: the agent bucket holds a per-subagent strip with ONE chip,
    // labeled by the Task description ("x"), counting all its child calls (3).
    const subStrip = agentBucket.querySelector(":scope > .tool-strip");
    expect(subStrip).not.toBeNull();
    const subChip = subStrip.querySelector('.tool-chip[data-tool="agent1"]');
    expect(subChip).not.toBeNull();
    expect(subChip.querySelector(".tool-chip-label").textContent).toBe("x");
    expect(subChip.querySelector(".tool-chip-count").textContent).toBe("x3");

    // Level 2: inside the subagent's bucket, tool-type chips Grep x2 + Read x1.
    const subPanel = subStrip.nextElementSibling;
    const subBucket = subPanel.querySelector(':scope > .tool-strip-group[data-tool="agent1"]');
    expect(subBucket).not.toBeNull();
    const toolStrip = subBucket.querySelector(":scope > .tool-strip");
    expect(toolStrip).not.toBeNull();
    const nestedGrepChip = toolStrip.querySelector('.tool-chip[data-tool="Grep"]');
    expect(nestedGrepChip).not.toBeNull();
    expect(nestedGrepChip.querySelector(".tool-chip-count").textContent).toBe("x2");

    const nestedReadChip = toolStrip.querySelector('.tool-chip[data-tool="Read"]');
    expect(nestedReadChip).not.toBeNull();
    expect(nestedReadChip.querySelector(".tool-chip-count").textContent).toBe("x1");

    // The main Subagent chip must NOT contain tool-type chips directly.
    expect(agentBucket.querySelector(':scope > .tool-strip > .tool-chip[data-tool="Grep"]')).toBeNull();

    // --- no ungrouped rows ---
    const ungrouped = Array.from(container.querySelectorAll(".tool-row"))
      .filter((el) => el.dataset.toolGrouped !== "1");
    expect(ungrouped.length).toBe(0);
  });

  it("lists multiple subagents as separate chips, each with its own tool-type chips", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));

    // Two subagents dispatched (different descriptions).
    r.handleEvent(toolUse("Task", { description: "Find the bug", prompt: "p" }, "a1"));
    r.handleEvent(toolUse("Task", { description: "Write the fix", prompt: "p" }, "a2"));

    // a1's children: 2 Reads.
    r.handleEvent({ type: "tool_use", tool_name: "Read", input: { file_path: "/a.ts" }, id: "a1c1", parent_tool_use_id: "a1" });
    r.handleEvent({ type: "tool_use", tool_name: "Read", input: { file_path: "/b.ts" }, id: "a1c2", parent_tool_use_id: "a1" });
    // a2's children: 1 Bash.
    r.handleEvent({ type: "tool_use", tool_name: "Bash", input: { command: "ls" }, id: "a2c1", parent_tool_use_id: "a2" });

    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());

    const mainStrips = Array.from(container.querySelectorAll(".tool-strip")).filter(s => !s.closest(".tool-strip-group"));
    expect(mainStrips.length).toBe(1);
    const mainStrip = mainStrips[0];

    // Main Subagent chip counts both dispatches.
    const subagentChip = mainStrip.querySelector('.tool-chip[data-tool="Task"]');
    expect(subagentChip.querySelector(".tool-chip-count").textContent).toBe("x2");

    // Level-1 strip has two subagent chips with the right labels + counts.
    const agentBucket = mainStrip.nextElementSibling.querySelector(':scope > .tool-strip-group[data-tool="Task"]');
    const subStrip = agentBucket.querySelector(":scope > .tool-strip");
    const chip1 = subStrip.querySelector('.tool-chip[data-tool="a1"]');
    const chip2 = subStrip.querySelector('.tool-chip[data-tool="a2"]');
    expect(chip1.querySelector(".tool-chip-label").textContent).toBe("Find the bug");
    expect(chip1.querySelector(".tool-chip-count").textContent).toBe("x2");
    expect(chip2.querySelector(".tool-chip-label").textContent).toBe("Write the fix");
    expect(chip2.querySelector(".tool-chip-count").textContent).toBe("x1");

    // Each subagent's tools are isolated to its own bucket.
    const subPanel = subStrip.nextElementSibling;
    const bucket1 = subPanel.querySelector(':scope > .tool-strip-group[data-tool="a1"]');
    const bucket2 = subPanel.querySelector(':scope > .tool-strip-group[data-tool="a2"]');
    expect(bucket1.querySelector(':scope > .tool-strip > .tool-chip[data-tool="Read"] .tool-chip-count').textContent).toBe("x2");
    expect(bucket1.querySelector(':scope > .tool-strip > .tool-chip[data-tool="Bash"]')).toBeNull();
    expect(bucket2.querySelector(':scope > .tool-strip > .tool-chip[data-tool="Bash"] .tool-chip-count').textContent).toBe("x1");
    expect(bucket2.querySelector(':scope > .tool-strip > .tool-chip[data-tool="Read"]')).toBeNull();

    const ungrouped = Array.from(container.querySelectorAll(".tool-row")).filter((el) => el.dataset.toolGrouped !== "1");
    expect(ungrouped.length).toBe(0);
  });

  it("turn without subagent still produces exactly one main strip (no regression)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    r.handleEvent({ type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 });
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUse("Read", { file_path: "/a/b.ts" }, "r1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "r1", output: "content", is_error: false });
    r.handleEvent(toolUse("Bash", { command: "ls" }, "b1"));
    r.handleEvent({ type: "tool_result", tool_use_id: "b1", output: "ok", is_error: false });
    r.handleEvent(finalEvent("done"));
    r.handleEvent(turnUsage());

    const allStrips = Array.from(container.querySelectorAll(".tool-strip"));
    const mainStrips = allStrips.filter(s => !s.closest(".tool-strip-group"));
    expect(mainStrips.length).toBe(1);
    expect(mainStrips[0].querySelector('.tool-chip[data-tool="Read"]')).not.toBeNull();
    expect(mainStrips[0].querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();
  });

  it("persists chips after a second bulkLoadEvents call (reload)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    const events = [
      { type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 },
      userEvent("do it"),
      toolUse("Bash", { command: "ls" }, "t1"),
      { type: "tool_result", tool_use_id: "t1", output: "file.txt", is_error: false },
      finalEvent("done"),
      turnUsage(),
    ];

    // First load (initial open)
    await r.loadHistory(events);
    expect(container.querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();

    // Second load (simulate switching away and back)
    await r.loadHistory(events);
    expect(container.querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();
    expect(container.querySelector('.tool-chip[data-tool="Bash"] .tool-chip-count').textContent).toBe("x1");
  });

  it("groups ALL tools of a turn into one strip on reload despite per-assistant-line usage", async () => {
    // History (reload) replays a turn as the parser emits it: ONE turn_usage per
    // assistant line, with tool calls between them. The first usage used to close
    // the turn and orphan every later tool row (chips vanished on reopen). Now a
    // turn is bounded by the next USER message, so the whole turn folds into one
    // strip.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    const events = [
      { type: "session_started", session_id: "x", model: "m", cwd: "/", timestamp: 0 },
      userEvent("go"),
      toolUse("Bash", { command: "ls" }, "b1"),
      { type: "tool_result", tool_use_id: "b1", output: "ok", is_error: false },
      finalEvent("step one"),
      turnUsage(), // assistant-line 1 usage — previously closed the turn here
      toolUse("Read", { file_path: "/a.ts" }, "r1"),
      { type: "tool_result", tool_use_id: "r1", output: "...", is_error: false },
      toolUse("Read", { file_path: "/b.ts" }, "r2"),
      { type: "tool_result", tool_use_id: "r2", output: "...", is_error: false },
      finalEvent("done"),
      turnUsage(), // assistant-line 2 usage
    ];

    await r.loadHistory(events);

    const mainStrips = Array.from(container.querySelectorAll(".tool-strip")).filter((s) => !s.closest(".tool-strip-group"));
    expect(mainStrips.length).toBe(1);
    expect(container.querySelector('.tool-chip[data-tool="Bash"] .tool-chip-count').textContent).toBe("x1");
    expect(container.querySelector('.tool-chip[data-tool="Read"] .tool-chip-count').textContent).toBe("x2");
    const ungrouped = Array.from(container.querySelectorAll(".tool-row")).filter((el) => el.dataset.toolGrouped !== "1");
    expect(ungrouped.length).toBe(0);
  });
});
