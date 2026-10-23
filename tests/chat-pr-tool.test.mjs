// @vitest-environment jsdom

// The /create-pr card arrives as a `pr_preview` tool call, since the model
// stopped emitting the long base64 marker lines as text. Both the scrollback
// mapper and the live handler must turn that call into the same visible PR
// card the markers produced, with the title, body and commits intact.

import { describe, it, expect } from "vitest";
import { eventToRenderedMessage } from "../src/shared/chat/chat-event-to-message.ts";
import { buildMessageEl } from "../src/shared/chat/chat-dom-renderer.ts";
import { base64ToUtf8 } from "../src/shared/chat/chat-transforms.ts";
import { turnProducedVisibleContent } from "../src/shared/chat/turn-visible-content.ts";

const input = {
  title: "Fix the flaky > test",
  body: "## Why\n- the timer leaked ✓\n",
  commits: [{ sha: "abc1234", msg: "FIX: flaky test" }],
};
const toolUse = (extra = {}) => ({
  type: "tool_use", id: "tu1", tool_name: "mcp__cc_conductor__pr_preview", input, ts: 0, ...extra,
});

describe("pr_preview tool call", () => {
  it("renders the PR card with its title, body and commits", () => {
    const m = eventToRenderedMessage(toolUse());
    expect(m.kind).toBe("assistant");
    const el = buildMessageEl(m);
    const card = el.querySelector(":scope > .pr-preview-card");
    expect(card).not.toBeNull();
    expect(el.classList.contains("chat-narration")).toBe(false);
    expect(card.dataset.prTitle).toBe("Fix the flaky › test");
    expect(card.querySelector("template.pr-modal-tpl").innerHTML).toContain("the timer leaked ✓");
    expect(JSON.parse(base64ToUtf8(card.dataset.prCommits))).toEqual(input.commits);
    expect(el.textContent).not.toContain("cc-pr-");
  });

  it("counts as visible turn content, so the turn is not folded as silent", () => {
    const m = eventToRenderedMessage(toolUse());
    expect(turnProducedVisibleContent({ activeTurnStart: 0, messages: [m], sessionId: null })).toBe(true);
  });

  it("a subagent's call stays an ordinary tool row", () => {
    expect(eventToRenderedMessage(toolUse({ parent_tool_use_id: "agent-1" })).kind).toBe("tool_use");
  });
});
