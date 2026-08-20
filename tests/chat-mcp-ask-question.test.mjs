// @vitest-environment jsdom

// Regression: the real ask channel is the MCP tool mcp__cc_conductor__ask_user_question
// (CLAUDE.md "One ask channel"), but the transcript only recognised the builtin name -
// no card, live or in history. See isAskQuestionTool in tool-meta.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

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

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function mcpAskEvent(questions, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__ask_user_question", { questions }, id, ts);
}

function mcpAskEventDegraded(questions, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__ask_user_question", { questions, degraded_builtin: true }, id, ts);
}

function toolResultEvent(id, text, { isError = false } = {}, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: isError, timestamp: ts };
}

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  return { r, container };
}

// Counted per prefix so each describe keeps its own session-id sequence.
const _seqByPrefix = new Map();

async function makeAttachedRenderer(prefix) {
  const seq = (_seqByPrefix.get(prefix) ?? 0) + 1;
  _seqByPrefix.set(prefix, seq);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`${prefix}${seq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("live: MCP ask_user_question renders a question card", () => {
  it("creates a kind:question card for the MCP tool name, same as the builtin", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Tabs or spaces?" }], "q1"));

    expect(r.messages.some((m) => m.kind === "question")).toBe(true);
    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Tabs or spaces?");
    r.detach();
  });

  it("absorbs the MCP tool's own tool_result into the card instead of a raw tool_result row", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Pick one?" }], "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Real answer"));

    // Resolved into the SAME question message, not a separate row.
    const q = r.messages.find((m) => m.kind === "question");
    expect(q.text).toContain("Real answer");
    expect(r.messages.filter((m) => m.kind === "tool_result").length).toBe(0);
    expect(container.querySelector(".msg.question-card").textContent).toContain("Real answer");
    r.detach();
  });
});

describe("scrollback (eventToRenderedMessage): MCP ask_user_question", () => {
  it("produces the same kind:question message the live path does", async () => {
    const { eventToRenderedMessage } = await import("../src/shared/chat/chat-transforms.ts");
    const msg = eventToRenderedMessage(mcpAskEvent([{ question: "Tabs or spaces?" }], "q1"));
    expect(msg?.kind).toBe("question");
  });
});

describe("pagination (older-page load): MCP ask_user_question", () => {
  it("renders a resolved question card (not a raw tool_result row) after scrolling into history", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("later question", 2_000_000)],
        oldest_seq: 10,
        newest_seq: 10,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [
          userEvent("old question", 1_000_000),
          mcpAskEvent([{ question: "Pick one?" }], "q1", 1_001_000),
          toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Real answer", {}, 1_001_500),
        ],
        oldest_seq: 0,
        newest_seq: 9,
        has_more: false,
      });

    const { renderer, container } = await makeAttachedRenderer("sess-mcp-auq-");
    await renderer.fetchOlder();

    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Real answer");
    // The raw tool_result must not leak through as its own visible/narration row.
    expect(container.querySelector(".msg.tool-result")).toBeNull();
    renderer.detach();
  });
});

describe("live: Skip flips the open card to Skipped", () => {
  it("resolves the last still-open card on a question_skipped notification", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Pick one?" }], "q1"));
    r.handleEvent({ type: "notification", kind: "question_skipped", body: "" });

    const q = r.messages.find((m) => m.kind === "question");
    expect(q.text).toContain("dismissed");
    const details = container.querySelector(".question-card-collapsible");
    expect(details.querySelector(".question-card-summary").textContent).toContain("Skipped");
    r.detach();
  });

  it("an unrelated notification still renders as a normal notification row", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent({ type: "notification", kind: "info", body: "heads up" });

    expect(container.textContent).toContain("heads up");
    r.detach();
  });
});

describe("pagination (older-page load): fire-and-forget answer via <auq-answer/> follow-up", () => {
  it("resolves the card from the later sentinel-tagged message, not just a direct tool_result", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("later question", 2_000_000)],
        oldest_seq: 10,
        newest_seq: 10,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [
          userEvent("old question", 1_000_000),
          mcpAskEvent([{ question: "Pick one?" }], "q1", 1_001_000),
          // Fire-and-forget deny handshake: is_error, no real answer text.
          toolResultEvent("q1", "", { isError: true }, 1_001_200),
          userEvent("<auq-answer/>User answered the question(s):\nQ: Pick one?\nA: Real answer", 1_001_500),
        ],
        oldest_seq: 0,
        newest_seq: 9,
        has_more: false,
      });

    const { renderer, container } = await makeAttachedRenderer("sess-mcp-auq-sentinel-");
    await renderer.fetchOlder();

    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Real answer");
    // The sentinel-tagged follow-up must not ALSO render as its own user bubble.
    expect(container.textContent).not.toContain("User answered the question(s)");
    renderer.detach();
  });
});

// Todo #661: a Skip writes nothing to the transcript JSONL, so scrollback used
// to show "awaiting answer" forever. The daemon's durable skipped_questions
// marks are folded in client-side instead (non-paginated lookup, option (b)).
describe("pagination (older-page load): durable skip marks", () => {
  async function paginateWithMarks(prefix, marks, olderEvents) {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("later question", 2_000_000)],
        oldest_seq: 10,
        newest_seq: 10,
        has_more: true,
      })
      .mockResolvedValueOnce({ events: olderEvents, oldest_seq: 0, newest_seq: 9, has_more: false });
    const { renderer, container } = await makeAttachedRenderer(prefix);
    renderer.paginator.skipMarks = marks;
    await renderer.fetchOlder();
    return { renderer, container };
  }

  it("renders a card as Skipped when a mark follows it, with no transcript evidence at all", async () => {
    const { renderer, container } = await paginateWithMarks("sess-skip-mark-", [1_001_400], [
      userEvent("old question", 1_000_000),
      mcpAskEvent([{ question: "Pick one?" }], "q1", 1_001_000),
    ]);

    const card = container.querySelector(".msg.question-card");
    expect(card).not.toBeNull();
    const details = card.querySelector(".question-card-collapsible");
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector(".question-card-summary").textContent).toContain("Skipped");
    renderer.detach();
  });

  it("a question with no skip record still renders as pending", async () => {
    const { renderer, container } = await paginateWithMarks("sess-skip-none-", [], [
      userEvent("old question", 1_000_000),
      mcpAskEvent([{ question: "Pick one?" }], "q1", 1_001_000),
    ]);

    const details = container.querySelector(".msg.question-card .question-card-collapsible");
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.querySelector(".question-card-summary").textContent).not.toContain("Skipped");
    renderer.detach();
  });

  it("a real answer wins over a stray mark, and an out-of-page mark is a no-op", async () => {
    const { renderer, container } = await paginateWithMarks("sess-skip-answered-", [1_001_400, 9_999_999], [
      userEvent("old question", 1_000_000),
      mcpAskEvent([{ question: "Pick one?" }], "q1", 1_001_000),
      toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Real answer", {}, 1_001_200),
    ]);

    const card = container.querySelector(".msg.question-card");
    expect(card.textContent).toContain("Real answer");
    expect(card.textContent).not.toContain("Skipped");
    renderer.detach();
  });

  it("matchSkipMarks ignores marks that precede every card and never reuses one card", async () => {
    const { matchSkipMarks } = await import("../src/shared/chat/chat-pagination.ts");
    const cards = [{ id: "q1", ts: 1000 }, { id: "q2", ts: 3000 }];
    expect([...matchSkipMarks(cards, [500], new Set())]).toEqual([]);
    expect([...matchSkipMarks(cards, [1500, 1600], new Set())]).toEqual(["q1"]);
    expect([...matchSkipMarks(cards, [1500, 3500], new Set())]).toEqual(["q1", "q2"]);
    expect([...matchSkipMarks(cards, [3500], new Set(["q2"]))]).toEqual([]);
    expect([...matchSkipMarks([], [1500], new Set())]).toEqual([]);
  });
});

describe("degraded_builtin badge is live-card-only, never in the transcript", () => {
  // The daemon stamps `degraded_builtin` on the prompt payload, whose id is
  // unrelated to the model's tool_use id this transcript renders from, so the
  // flag can never reach here. The badge lives on the live card instead, see
  // tests/auq-degraded-badge-render.test.mjs.
  it("does not render the marker even if a tool_use input carries the field", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEventDegraded([{ question: "Pick one?" }], "q1"));

    expect(container.querySelector(".question-card-degraded-badge")).toBeNull();
    r.detach();
  });
});

describe("answered-card collapsed/expanded presentation", () => {
  it("an answered question defaults to COLLAPSED with the answer visible as a chip", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Pick one?" }], "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Option A"));

    const details = container.querySelector(".question-card-collapsible");
    expect(details.hasAttribute("open")).toBe(false);
    // The answer must be readable WITHOUT expanding - it lives in the summary.
    const summary = details.querySelector(".question-card-summary");
    expect(summary.textContent).toContain("Option A");
    r.detach();
  });

  it("a still-pending question stays EXPANDED (actionable, not summarized)", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Pick one?" }], "q1"));

    const details = container.querySelector(".question-card-collapsible");
    expect(details.hasAttribute("open")).toBe(true);
    r.detach();
  });

  it("a skipped question is collapsed but visually distinct from an answered one", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Pick one?" }], "q1"));
    r.handleEvent(toolResultEvent("q1", "User dismissed the question(s)."));

    const details = container.querySelector(".question-card-collapsible");
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector(".question-card-summary").textContent).toContain("Skipped");
    r.detach();
  });
});

// Backlog todo #305: (a) no raw "User answered..." dump, (b) select+typed
// combine. Same MCP-name gap as Task 1 - resolving into the SAME card fixes (a).
describe("todo #305: answer never dumps raw text, select+typed still combines", () => {
  it("the common (delivered in-band) path never renders the raw 'User answered...' framing anywhere", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    r.handleEvent(mcpAskEvent([{ question: "Tabs or spaces?" }], "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Tabs or spaces?\nA: Tabs"));

    expect(container.textContent).not.toContain("User answered the question(s)");
    expect(container.querySelector(".question-card-answer-chip").textContent).toBe("Tabs");
    r.detach();
  });

  it("the not-delivered fallback (separate <auq-answer/> message, no matching card) still hides the raw framing behind a click-to-reveal chip", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("go"));
    // No prior AskUserQuestion tool_use in this session - resolvePendingQuestionCard
    // finds nothing, so this falls through to a normal user bubble whose sentinel
    // block must still be chip-converted, never rendered as raw text.
    r.handleEvent(userEvent("<auq-answer/>User answered the question(s):\nQ: Pick one?\nA: Custom pick"));

    expect(container.textContent).not.toContain("User answered the question(s)");
    expect(container.querySelector(".auq-answer-chip")).not.toBeNull();
    r.detach();
  });

  it("single-select pick + typed text combine into both parts (question-state.ts computeAnswer)", async () => {
    const { computeAnswer } = await import("../src/views/sessions/permission-modal/question-state.ts");
    const single = { question: "Pick", options: [{ label: "A" }, { label: "B" }] };
    expect(computeAnswer(single, "why though", "A")).toEqual(["A", "why though"]);
  });
});
