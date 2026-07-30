// Custom chip-panel views inside the chat: Read / "File Changes" aggregate one
// row per file with a count, Skills lists skills used, Questions pairs each
// AskUserQuestion question with the answer given. Plus the primary-color
// "currently working" pulse on the chip of an in-flight tool call.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

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

function toolResultEvent(id, text = "ok") {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: 0 };
}

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("go")); // open a turn so tool rows fold into its strip
  return { r, container };
}

describe("custom chip-panel views", () => {
  it("Read chip aggregates one row per file with a repeat-count badge", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r1"));
    r.handleEvent(toolResultEvent("r1"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r2"));
    r.handleEvent(toolResultEvent("r2"));
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/y.ts" }, "r3"));
    r.handleEvent(toolResultEvent("r3"));

    const chip = container.querySelector('.tool-chip[data-tool="Read"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");

    const rows = container.querySelectorAll(".tool-file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.path).toBe("/a/x.ts");
    expect(rows[0].querySelector(".tool-file-name").textContent).toBe("x.ts");
    expect(rows[0].querySelector(".tool-file-count").textContent).toBe("2×");
    // A single read shows no badge.
    expect(rows[1].querySelector(".tool-file-count")).toBeNull();
    r.detach();
  });

  it("combines Edit + Write into one 'File Changes' chip, aggregated per file", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Edit", { file_path: "/a/z.rs", old_string: "a", new_string: "b" }, "e1"));
    r.handleEvent(toolUseEvent("Write", { file_path: "/a/new.md", content: "hi" }, "w1"));
    r.handleEvent(toolUseEvent("Edit", { file_path: "/a/z.rs", old_string: "b", new_string: "c" }, "e2"));

    const chip = container.querySelector('.tool-chip[data-tool="Edit"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-label").textContent).toBe("File Changes");
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");
    // Write did NOT create its own chip.
    expect(container.querySelector('.tool-chip[data-tool="Write"]')).toBeNull();

    const rows = container.querySelectorAll(".tool-file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.path).toBe("/a/z.rs");
    expect(rows[0].querySelector(".tool-file-count").textContent).toBe("2 changes");
    expect(rows[1].querySelector(".tool-file-count").textContent).toBe("1 change");
    r.detach();
  });

  it("Skills chip lists each skill used", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Skill", { skill: "commit" }, "s1"));
    r.handleEvent(toolUseEvent("Skill", { skill: "rate-it" }, "s2"));

    const chip = container.querySelector('.tool-chip[data-tool="Skill"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-label").textContent).toBe("Skills");

    const rows = [...container.querySelectorAll(".tool-skill-row .tool-skill-name")].map((e) => e.textContent);
    expect(rows).toEqual(["commit", "rate-it"]);
    r.detach();
  });

  it("question card pairs each question with the answer given", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Option A"));

    // AskUserQuestion now renders as a standalone kind:"question" card
    // (renderQuestionCardHtml), not a generic tool-chip.
    const card = container.querySelector(".question-card");
    expect(card).not.toBeNull();

    const qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-header").textContent).toBe("Choice");
    expect(qa.querySelector(".tool-qa-q").textContent.trim()).toBe("Pick one?");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("Option A");
    r.detach();
  });

  it("shows 'awaiting answer' for an unanswered question", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Still thinking?" }] }, "q1"));
    const qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a--pending")).not.toBeNull();
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("awaiting answer");
    r.detach();
  });

  it("a <auq-answer/> user message resolves the question card in place instead of a separate answer bubble (Joe's request, 2026-07-22)", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    let qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("awaiting answer");

    r.handleEvent(userEvent("<auq-answer/>User answered the question(s):\nQ: Pick one?\nA: Option A"));

    qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("Option A");
    // No separate "answer" chip bubble - the resolved card above is the only trace.
    expect(container.querySelector(".auq-answer-chip")).toBeNull();
    r.detach();
  });

  it("an is_error fire-and-forget handshake tool_result doesn't poison the card - the real answer still folds in later (regression, 2026-07-30)", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));
    // permission.rs's ASK_FIRE_AND_FORGET_REASON: the PreToolUse deny fires this
    // handshake tool_result right after the tool_use - never the real answer.
    r.handleEvent({
      type: "tool_result",
      tool_use_id: "q1",
      output: { type: "text", text: "Your question has been shown to the user in the app and the card is now waiting for their answer." },
      is_error: true,
      timestamp: 0,
    });

    let qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("awaiting answer");

    r.handleEvent(userEvent("<auq-answer/>User answered the question(s):\nQ: Pick one?\nA: Option A"));

    qa = container.querySelector(".tool-qa");
    expect(qa.querySelector(".tool-qa-a").textContent).toContain("Option A");
    // No separate "answer" chip bubble - the resolved card above is the only trace.
    expect(container.querySelector(".auq-answer-chip")).toBeNull();
    r.detach();
  });

  it("falls back to a normal bubble+chip when a <auq-answer/> message has no pending question card to resolve", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(userEvent("<auq-answer/>User answered the question(s):\nQ: Pick one?\nA: Option A"));
    expect(container.querySelector(".auq-answer-chip")).not.toBeNull();
    r.detach();
  });

  it("updateQuestionProgress mirrors the floating card's live per-question progress (Joe's request, 2026-07-16)", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", {
      questions: [{ question: "First?" }, { question: "Second?" }],
    }, "q1"));

    // Nothing answered yet in the floating card - both still read "awaiting answer".
    r.updateQuestionProgress("q1", [false, false]);
    let rows = container.querySelectorAll(".tool-qa");
    expect(rows[0].querySelector(".tool-qa-a--live-answered")).toBeNull();
    expect(rows[0].querySelector(".tool-qa-a").textContent).toContain("awaiting answer");

    // User answers the first question and hits Next in the floating card.
    r.updateQuestionProgress("q1", [true, false]);
    rows = container.querySelectorAll(".tool-qa");
    expect(rows[0].querySelector(".tool-qa-a--live-answered")).not.toBeNull();
    expect(rows[0].querySelector(".tool-qa-a").textContent).toContain("Answered");
    // Second question is still untouched.
    expect(rows[1].querySelector(".tool-qa-a--live-answered")).toBeNull();
    expect(rows[1].querySelector(".tool-qa-a").textContent).toContain("awaiting answer");

    // An unknown prompt id (some other session's card) is a no-op.
    r.updateQuestionProgress("some-other-id", [true, true]);
    rows = container.querySelectorAll(".tool-qa");
    expect(rows[1].querySelector(".tool-qa-a--live-answered")).toBeNull();

    r.detach();
  });

  it("updateQuestionProgress is a no-op once the question has actually resolved", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?" }] }, "q1"));
    r.handleEvent(toolResultEvent("q1", "User answered the question(s):\nQ: Pick one?\nA: Real answer"));

    // A stray late progress update (e.g. the card was already torn down) must
    // never clobber the real, final answer that already landed.
    r.updateQuestionProgress("q1", [false]);
    const qa = container.querySelector(".tool-qa-a");
    expect(qa.textContent).toContain("Real answer");
    expect(qa.classList.contains("tool-qa-a--pending")).toBe(false);
    r.detach();
  });
});

describe("currently-working chip highlight", () => {
  it("pulses ONLY the current-activity chip; the highlight moves with the activity", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Read", { file_path: "/a/x.ts" }, "r1"));
    const readChip = container.querySelector('.tool-chip[data-tool="Read"]');
    expect(readChip.classList.contains("tool-chip--running")).toBe(true);

    // The result arriving does NOT drop the pulse: "Reading …" stays the pinned
    // current activity (same lifecycle as the activity line) until the next tool.
    r.handleEvent(toolResultEvent("r1"));
    expect(readChip.classList.contains("tool-chip--running")).toBe(true);

    // A new tool becomes the current activity -> the single pulse moves to it,
    // and the previous chip stops pulsing (no more lighting up the whole strip).
    r.handleEvent(toolUseEvent("Edit", { file_path: "/a/y.ts", old_string: "a", new_string: "b" }, "e1"));
    expect(container.querySelector('.tool-chip[data-tool="Read"]').classList.contains("tool-chip--running")).toBe(false);
    expect(container.querySelector('.tool-chip[data-tool="Edit"]').classList.contains("tool-chip--running")).toBe(true);
    r.detach();
  });

  it("clears the pulse when the turn closes even if no result arrived", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Bash", { command: "sleep 999" }, "b1"));
    const chip = container.querySelector('.tool-chip[data-tool="Bash"]');
    expect(chip.classList.contains("tool-chip--running")).toBe(true);

    r.handleEvent(userEvent("next")); // new turn closes the prior one
    expect(chip.classList.contains("tool-chip--running")).toBe(false);
    r.detach();
  });
});
