/**
 * Tests for the per-turn footer (meta chips + tool strip bundle).
 *
 * Covers:
 *  - formatTurnDuration / formatTokenCount / estimateTokensFromText helpers
 *  - one footer per turn; meta row is the footer's FIRST row, tool strip below
 *  - live token estimate with ~ prefix / real combined count after settle
 *  - live elapsed time ticks from wall clock (regression: the "494806h" bug
 *    where elapsed was derived from the sequence key)
 *  - tokens COMBINED across history's per-line usage events (regression:
 *    "tokens aren't combining, they're just showing one event")
 *  - duration falls back to the turn's timestamp span when duration_ms is 0
 *  - footer pinned between the turn's last message and the next user message
 *
 * Drives the real ChatRenderer via JSDOM so DOM assertions match the actual
 * rendering path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { formatTurnDuration, formatTokenCount, estimateTokensFromText } from "../src/shared/chat/turn-chips.ts";

// ---------------------------------------------------------------------------
// Pure helper unit tests (no DOM needed)
// ---------------------------------------------------------------------------

describe("formatTurnDuration", () => {
  it("formats seconds only", () => {
    expect(formatTurnDuration(0)).toBe("0s");
    expect(formatTurnDuration(5000)).toBe("5s");
    expect(formatTurnDuration(14000)).toBe("14s");
    expect(formatTurnDuration(59999)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatTurnDuration(60000)).toBe("1m 0s");
    expect(formatTurnDuration(80000)).toBe("1m 20s");
    expect(formatTurnDuration(125000)).toBe("2m 5s");
  });

  it("formats hours and minutes (no seconds)", () => {
    expect(formatTurnDuration(3600000)).toBe("1h 0m");
    expect(formatTurnDuration(3900000)).toBe("1h 5m");
    expect(formatTurnDuration(7200000)).toBe("2h 0m");
  });

  it("clamps negative ms to 0s", () => {
    expect(formatTurnDuration(-500)).toBe("0s");
  });
});

describe("formatTokenCount", () => {
  it("formats small counts as plain integers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(980)).toBe("980");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(2100)).toBe("2.1k");
    expect(formatTokenCount(12400)).toBe("12.4k");
  });
});

describe("estimateTokensFromText", () => {
  it("estimates chars/4 rounded", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("abcd")).toBe(1); // 4 chars = 1 token
    expect(estimateTokensFromText("a".repeat(100))).toBe(25);
    expect(estimateTokensFromText("a".repeat(8400))).toBe(2100);
  });
});

// ---------------------------------------------------------------------------
// DOM / ChatRenderer harness
// ---------------------------------------------------------------------------

function setupDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
  });
  const { window } = dom;
  const { document } = window;

  window.__TAURI__ = {
    core: {
      invoke: async () => null,
      convertFileSrc: (s) => s,
    },
    event: {
      listen: async () => () => {},
      emit: async () => {},
    },
  };

  return { dom, window, document };
}

function makeUserMessage(content = "Hello", tsMs = 0) {
  return {
    type: "user_message",
    content: [{ type: "text", text: content }],
    timestamp: BigInt(tsMs),
  };
}

function makeAssistantMessage(text, streaming = false, tsMs = 0) {
  return {
    type: "assistant_message",
    content: [{ type: "text", text }],
    streaming,
    timestamp: BigInt(tsMs),
  };
}

// d10bd68e: raw assistant narration is hidden by default and no longer
// counts as "visible" for the merge gate - only send_message (or a real
// user/question row) does. Mirrors chat-message-chips.view.spec.ts.
function makeSendMessage(text, id = "tu1", tsMs = 0) {
  return {
    type: "tool_use",
    tool_name: "mcp__cc_conductor__send_message",
    input: { text },
    id,
    timestamp: BigInt(tsMs),
    parent_tool_use_id: null,
  };
}

function makeToolUse(id = "tool1", tsMs = 0) {
  return {
    type: "tool_use",
    tool_name: "Bash",
    input: { command: "ls" },
    id,
    timestamp: BigInt(tsMs),
    parent_tool_use_id: null,
  };
}

function makeToolResult(id = "tool1", tsMs = 0) {
  return {
    type: "tool_result",
    tool_use_id: id,
    output: { type: "text", text: "file.ts" },
    is_error: false,
    timestamp: BigInt(tsMs),
  };
}

function makeTurnUsage({
  durationMs = 14000,
  outputTokens = 2100,
  inputTokens = 5000,
  cacheCreate = 0,
  cacheRead = 0,
  costUsd = 0.001,
} = {}) {
  return {
    type: "turn_usage",
    input_tokens: BigInt(inputTokens),
    output_tokens: BigInt(outputTokens),
    cache_creation_input_tokens: BigInt(cacheCreate),
    cache_read_input_tokens: BigInt(cacheRead),
    total_cost_usd: costUsd,
    duration_ms: BigInt(durationMs),
    has_thinking: false,
    model: "claude-sonnet-4-6",
    awaiting: null,
  };
}

function makeMetaUserMessage(text = "Your previous response had no visible output.", tsMs = 0) {
  return {
    type: "user_message",
    content: [{ type: "text", text }],
    timestamp: BigInt(tsMs),
    is_meta: true,
  };
}

describe("Turn footer DOM integration", () => {
  let dom;
  let document;

  beforeEach(() => {
    const setup = setupDom();
    dom = setup.dom;
    document = setup.document;
    global.document = document;
    global.window = setup.window;
    // The renderer uses `instanceof HTMLElement` / `Node` (e.g. the active-chip
    // pulse), so expose them as globals like the other DOM test harnesses do.
    global.HTMLElement = setup.window.HTMLElement;
    global.Node = setup.window.Node;
    global.MutationObserver = setup.window.MutationObserver || class {
      observe() {}
      disconnect() {}
    };
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    dom.window.close();
  });

  async function createRenderer() {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const container = document.createElement("div");
    document.body.appendChild(container);
    return { renderer: new ChatRenderer(container), container };
  }

  it("creates one footer with one meta row per turn", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Turn 1"));
    renderer.handleEvent(makeAssistantMessage("Response 1"));
    renderer.handleEvent(makeTurnUsage());

    expect(container.querySelectorAll(".turn-footer").length).toBe(1);
    expect(container.querySelectorAll(".turn-meta-chips").length).toBe(1);
  });

  it("bundles the tool strip INTO the footer, below the meta row", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Do something"));
    renderer.handleEvent(makeAssistantMessage("Working", true));
    renderer.handleEvent(makeToolUse());
    renderer.handleEvent(makeToolResult());
    renderer.handleEvent(makeTurnUsage());

    const footer = container.querySelector(".turn-footer");
    expect(footer).not.toBeNull();
    // Meta row is the footer's FIRST row, the strip follows it.
    expect(footer.firstElementChild.classList.contains("turn-meta-chips")).toBe(true);
    const strip = footer.querySelector(":scope > .tool-strip");
    expect(strip).not.toBeNull();
    expect(strip.previousElementSibling.classList.contains("turn-meta-chips")).toBe(true);
    // No strips outside footers.
    expect(container.querySelectorAll(".tool-strip").length).toBe(
      container.querySelectorAll(".turn-footer .tool-strip").length,
    );
  });

  it("shows ~ prefix on live token estimate before usage lands", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("a".repeat(400), true));

    const tokenChip = container.querySelector(".turn-chip--tokens");
    expect(tokenChip).not.toBeNull();
    expect(tokenChip.textContent).toMatch(/^~\d/);
  });

  it("drops ~ prefix and shows real token count after settle", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("Some response", true));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 2100, durationMs: 14000 }));

    const tokenChip = container.querySelector(".turn-chip--tokens");
    expect(tokenChip.textContent).not.toMatch(/^~/);
    expect(tokenChip.textContent).toContain("2.1k");
  });

  it("live elapsed ticks from wall clock, never from the turn key", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("streaming", true));

    vi.advanceTimersByTime(5000);

    const timeChip = container.querySelector(".turn-chip--time");
    expect(timeChip).not.toBeNull();
    // The "494806h 31m" bug: elapsed derived from the sequence key.
    expect(timeChip.textContent).not.toContain("h");
    expect(timeChip.textContent).toContain("5s");
  });

  it("shows real duration on the settled time chip", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("Response"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 14000 }));

    const timeChip = container.querySelector(".turn-chip--time");
    expect(timeChip.textContent).toContain("14s");
    expect(timeChip.classList.contains("turn-chip--hidden")).toBe(false);
  });

  it("hides the time chip when no duration and no timestamp span exist", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("Response"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 0 }));

    const timeChip = container.querySelector(".turn-chip--time");
    expect(timeChip.classList.contains("turn-chip--hidden")).toBe(true);
  });

  it("COMBINES per-line usage events of one turn (history replay)", async () => {
    const { renderer, container } = await createRenderer();

    await renderer.loadHistory([
      makeUserMessage("Past question", 1_000_000),
      makeAssistantMessage("Line one", false, 1_010_000),
      makeTurnUsage({ durationMs: 0, outputTokens: 1000 }),
      makeAssistantMessage("Line two", false, 1_022_000),
      makeTurnUsage({ durationMs: 0, outputTokens: 1500 }),
    ]);

    const tokenChip = container.querySelector(".turn-chip--tokens");
    expect(tokenChip).not.toBeNull();
    // 1000 + 1500 = 2500 combined, NOT either single event.
    expect(tokenChip.textContent).toContain("2.5k");
  });

  it("combines per-line usage on the LIVE path too (watched external session)", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("watched"));
    renderer.handleEvent(makeAssistantMessage("Line one"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 0, outputTokens: 1000 }));
    renderer.handleEvent(makeAssistantMessage("Line two"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 0, outputTokens: 1500 }));

    const tokenChip = container.querySelector(".turn-chip--tokens");
    expect(tokenChip.textContent).toContain("2.5k");
  });

  it("resumes live ticking after a reload finds a still-open turn, instead of freezing forever", async () => {
    const { renderer, container } = await createRenderer();
    const now = 1_000_000_000_000;
    vi.setSystemTime(now);

    // Reload replays a turn that started 10s ago and never got a closing
    // user_message - it's still genuinely in progress on the daemon side.
    await renderer.loadHistory(
      [
        makeUserMessage("Do a big task", now - 10_000),
        makeAssistantMessage("Line one", false, now - 5_000),
        makeTurnUsage({ durationMs: 0, outputTokens: 1000 }),
      ],
      { resumeLiveTicking: true },
    );
    expect(container.querySelector(".turn-chip--time").textContent).toContain("10s");

    // More work streams in live after the reload - the elapsed time must keep
    // advancing, not stay pinned at the reload snapshot (the actual bug: a
    // reload settled the row for good, silently dropping every later tick).
    vi.advanceTimersByTime(5000);
    renderer.handleEvent(makeAssistantMessage("more", true));
    expect(container.querySelector(".turn-chip--time").textContent).toContain("15s");
  });

  it("does NOT resume live ticking for a read-only history reload (default)", async () => {
    const { renderer, container } = await createRenderer();
    const now = 1_000_000_000_000;
    vi.setSystemTime(now);

    await renderer.loadHistory([
      makeUserMessage("Do a big task", now - 10_000),
      makeAssistantMessage("Line one", false, now - 5_000),
      makeTurnUsage({ durationMs: 0, outputTokens: 1000 }),
    ]);
    // Settled from the ts span (first to last message, 5s here) - correct for
    // a dead/closed transcript, unlike the live case's wall-clock elapsed.
    expect(container.querySelector(".turn-chip--time").textContent).toContain("5s");

    vi.advanceTimersByTime(5000);
    renderer.handleEvent(makeAssistantMessage("more", true));
    // Still 5s - settled/frozen, as intended for a read-only view.
    expect(container.querySelector(".turn-chip--time").textContent).toContain("5s");
  });

  it("derives duration from the turn's timestamp span when duration_ms is absent", async () => {
    const { renderer, container } = await createRenderer();

    await renderer.loadHistory([
      makeUserMessage("Past question", 1_000_000),
      makeAssistantMessage("Past answer", false, 1_022_000),
      makeTurnUsage({ durationMs: 0, outputTokens: 3500 }),
    ]);

    const timeChip = container.querySelector(".turn-chip--time");
    expect(timeChip).not.toBeNull();
    expect(timeChip.classList.contains("turn-chip--hidden")).toBe(false);
    expect(timeChip.textContent).toContain("22s");
  });

  it("one footer per turn; two consecutive turns get two footers", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Turn 1"));
    renderer.handleEvent(makeAssistantMessage("Answer 1"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 5000, outputTokens: 100 }));

    renderer.handleEvent(makeUserMessage("Turn 2"));
    renderer.handleEvent(makeAssistantMessage("Answer 2"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 8000, outputTokens: 200 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(2);
    expect(container.querySelectorAll(".turn-meta-chips").length).toBe(2);
  });

  it("pins the closed turn's footer before the next user message", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Turn 1"));
    renderer.handleEvent(makeAssistantMessage("Answer 1"));
    renderer.handleEvent(makeTurnUsage());
    renderer.handleEvent(makeUserMessage("Turn 2"));
    renderer.handleEvent(makeAssistantMessage("Answer 2"));

    const children = [...container.children];
    const footer1Idx = children.findIndex((el) => el.classList.contains("turn-footer"));
    const user2Idx = children.findIndex(
      (el, i) => i > footer1Idx && el.classList.contains("user"),
    );
    // Turn 1's footer sits between turn 1's content and turn 2's user message.
    expect(footer1Idx).toBeGreaterThan(0);
    expect(user2Idx).toBe(footer1Idx + 1);
  });

  it("only one footer for a multi-message / multi-tool turn", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Do something"));
    renderer.handleEvent(makeAssistantMessage("Step 1", true));
    renderer.handleEvent(makeAssistantMessage("Step 1 final", false));
    renderer.handleEvent(makeToolUse());
    renderer.handleEvent(makeToolResult());
    renderer.handleEvent(makeAssistantMessage("Done"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 500 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(1);
    expect(container.querySelectorAll(".turn-meta-chips").length).toBe(1);
  });

  it("historical turn renders settled chips with a full breakdown tooltip", async () => {
    const { renderer, container } = await createRenderer();

    await renderer.loadHistory([
      makeUserMessage("Past question", 1_000_000),
      makeAssistantMessage("Past answer", false, 1_010_000),
      makeTurnUsage({ durationMs: 22000, outputTokens: 3500, inputTokens: 8000, costUsd: 0.0012 }),
    ]);

    const tokenChip = container.querySelector(".turn-chip--tokens");
    const timeChip = container.querySelector(".turn-chip--time");
    expect(tokenChip.textContent).not.toMatch(/~/);
    expect(tokenChip.textContent).toContain("3.5k");
    expect(timeChip.textContent).toContain("22s");

    const row = container.querySelector(".turn-meta-chips");
    expect(row.title).toContain("Input:");
    expect(row.title).toContain("Output:");
  });

  it("meta row tooltip contains cost when costUsd > 0", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Hello"));
    renderer.handleEvent(makeAssistantMessage("Response"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 500, costUsd: 0.0025 }));

    const row = container.querySelector(".turn-meta-chips");
    expect(row.title).toContain("Cost:");
    expect(row.title).toContain("$0.0025");
  });

  it("does NOT split the footer on invisible user lines (tool results)", async () => {
    // In real streams every tool result comes back as a user-role line whose
    // blocks the parser drops (content: []). Those are NOT turn boundaries:
    // everything between two REAL user messages is ONE footer with ONE
    // combined meta row - this was the "tokens split up per answer" bug.
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("go"));
    renderer.handleEvent(makeAssistantMessage("step 1"));
    renderer.handleEvent(makeToolUse("t1"));
    renderer.handleEvent({ type: "user_message", content: [], timestamp: BigInt(0) });
    renderer.handleEvent(makeToolResult("t1"));
    renderer.handleEvent(makeAssistantMessage("step 2"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 0, outputTokens: 1000 }));
    renderer.handleEvent({ type: "user_message", content: [], timestamp: BigInt(0) });
    renderer.handleEvent(makeAssistantMessage("step 3"));
    renderer.handleEvent(makeTurnUsage({ durationMs: 0, outputTokens: 1500 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(1);
    expect(container.querySelectorAll(".turn-meta-chips").length).toBe(1);
    // Tokens combined across the whole msg-to-msg span.
    expect(container.querySelector(".turn-chip--tokens").textContent).toContain("2.5k");
    // One strip, not one per tool cycle.
    expect(container.querySelectorAll(".tool-strip").length).toBe(1);
  });

  it("interrupted turn freezes at its last estimate instead of ticking forever", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Turn 1"));
    renderer.handleEvent(makeAssistantMessage("partial answer", true));
    vi.advanceTimersByTime(3000);
    // Next user message closes the turn with NO usage (cancelled/interrupted).
    renderer.handleEvent(makeUserMessage("Turn 2"));

    const firstRow = container.querySelector(".turn-meta-chips");
    const timeText = firstRow.querySelector(".turn-chip--time").textContent;
    expect(timeText).toContain("3s");
    // Time must not keep growing after the freeze.
    vi.advanceTimersByTime(10000);
    expect(firstRow.querySelector(".turn-chip--time").textContent).toBe(timeText);
  });

  // Regression (todo 621): a gen-mismatch race can discard the reported
  // status, sending TurnUsage with awaiting=null. That must still resolve
  // the turn, never leave turnStatus stuck on a prior in-progress value.
  it("resolves turnStatus to done when the terminal TurnUsage carries no awaiting", async () => {
    const { renderer } = await createRenderer();

    renderer.handleEvent(makeUserMessage("Turn 1"));
    renderer.handleEvent(makeAssistantMessage("Working", true));
    expect(renderer.turnStatus).toBe(null);

    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 })); // awaiting: null
    expect(renderer.turnStatus).toBe("done");
  });
});

describe("Silent auto-continue streak merge", () => {
  let dom;
  let document;

  beforeEach(() => {
    const setup = setupDom();
    dom = setup.dom;
    document = setup.document;
    global.document = document;
    global.window = setup.window;
    global.HTMLElement = setup.window.HTMLElement;
    global.Node = setup.window.Node;
    global.MutationObserver = setup.window.MutationObserver || class {
      observe() {}
      disconnect() {}
    };
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    dom.window.close();
  });

  async function createRenderer() {
    const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
    const container = document.createElement("div");
    document.body.appendChild(container);
    return { renderer: new ChatRenderer(container), container };
  }

  it("folds a silent turn immediately followed by more silent auto-continues into ONE footer, no visible note", async () => {
    const { renderer, container } = await createRenderer();

    // Turn 1: real user message, but the reply is pure tool activity - no
    // assistant text at all.
    renderer.handleEvent(makeUserMessage("do X"));
    renderer.handleEvent(makeToolUse("t1"));
    renderer.handleEvent(makeToolResult("t1"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 }));
    // Two harness-injected retries, still silent.
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeTurnUsage({ outputTokens: 50 }));
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeAssistantMessage("Finally done."));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 200 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(1);
    // Turn 1 wasn't itself opened by a meta-turn chip, so there's
    // nowhere to hang a counter - the retries stay fully invisible.
    expect(container.textContent).not.toContain("Scheduled wake");
  });

  it("tags a rendered meta-turn chip with ×N when further silent retries follow", async () => {
    const { renderer, container } = await createRenderer();

    // Turn 1 closes normally with real content.
    renderer.handleEvent(makeUserMessage("do X"));
    renderer.handleEvent(makeSendMessage("Working on it.", "tu1"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 }));
    // First auto-continue: turn 1 wasn't silent, so this renders normally.
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeTurnUsage({ outputTokens: 50 })); // silent
    // Two more retries - each merges into the first note's footer.
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeTurnUsage({ outputTokens: 50 })); // silent
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeSendMessage("Fixed it.", "tu2"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 200 }));

    // Turn 1's own footer + ONE merged footer for the whole retry chain.
    expect(container.querySelectorAll(".turn-footer").length).toBe(2);
    const notes = [...container.querySelectorAll(".msg.system")].filter((el) =>
      el.textContent.includes("Scheduled wake"),
    );
    expect(notes.length).toBe(1);
    expect(notes[0].textContent).toContain("×3");

    // Merged footer's tokens are the SUM across all 3 retry turns, not just
    // the last one.
    const tokenChips = container.querySelectorAll(".turn-chip--tokens");
    expect(tokenChips[1].textContent).toContain("300");
  });

  it("does not merge an Auto-continue that follows a turn with real content", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("do X"));
    renderer.handleEvent(makeSendMessage("Answer 1", "tu1"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 }));
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeSendMessage("Answer 2", "tu2"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(2);
  });

  it("does not merge a genuine new user message into an ongoing silent streak", async () => {
    const { renderer, container } = await createRenderer();

    renderer.handleEvent(makeUserMessage("do X"));
    renderer.handleEvent(makeToolUse("t1"));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 100 })); // silent
    renderer.handleEvent(makeMetaUserMessage());
    renderer.handleEvent(makeTurnUsage({ outputTokens: 50 })); // silent, merges
    // A real user message arrives mid-streak - must close it out, not merge.
    renderer.handleEvent(makeUserMessage("actually, do Y"));
    renderer.handleEvent(makeAssistantMessage("On it."));
    renderer.handleEvent(makeTurnUsage({ outputTokens: 200 }));

    expect(container.querySelectorAll(".turn-footer").length).toBe(2);
  });
});
