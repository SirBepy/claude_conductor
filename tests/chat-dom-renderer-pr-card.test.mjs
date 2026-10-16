// @vitest-environment jsdom

// Regression: the /create-pr preview card stopped rendering. renderMessage
// (chat-transforms.ts, pinned by tests/chat-transforms.test.mjs) always built
// the right HTML string - the card lives inside the SAME element as the
// finalized assistant turn's text. Quiet mode (shipped after the card)
// unconditionally tags every "assistant" row chat-narration, which
// chat-messages.css hides by default (display:none) until the user opts into
// "Show raw activity" - so the card was present in the DOM but invisible.
// This pins buildMessageEl (chat-dom-renderer.ts), the layer that actually
// drops the card, not just the string-render layer chat-transforms.test.mjs
// already covers.

import { describe, it, expect, beforeEach } from "vitest";
import { buildMessageEl } from "../src/shared/chat/chat-dom-renderer.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

const title = "Fix flaky test";
const bodyB64 = Buffer.from("## Summary\n- fixed a flaky test\n", "utf8").toString("base64");
const commitsB64 = Buffer.from(JSON.stringify([{ sha: "abc1234", msg: "fix: flaky test" }]), "utf8").toString("base64");
const markerText = `Here is the PR.\n<cc-pr-title:${title}>\n<cc-pr-body:${bodyB64}>\n<cc-pr-commits:${commitsB64}>`;

describe("buildMessageEl - PR preview card survives narration hiding", () => {
  it("does not tag a finalized assistant turn carrying the PR markers chat-narration", () => {
    const el = buildMessageEl({ kind: "assistant", content: [{ type: "text", text: markerText }], streaming: false, ts: 0 });
    expect(el.querySelector(".pr-preview-card")).not.toBeNull();
    expect(el.classList.contains("chat-narration")).toBe(false);
  });

  it("keeps the turn's prose hidden as narration while the card stays outside it", () => {
    const el = buildMessageEl({ kind: "assistant", content: [{ type: "text", text: markerText }], streaming: false, ts: 0 });
    const prose = el.querySelector(":scope > .chat-narration");
    expect(prose).not.toBeNull();
    expect(prose.textContent).toContain("Here is the PR.");
    expect(prose.querySelector(".pr-preview-card")).toBeNull();
    expect(el.querySelector(":scope > .pr-preview-card")).not.toBeNull();
  });

  it("still tags ordinary assistant narration (no PR markers) chat-narration", () => {
    const el = buildMessageEl({ kind: "assistant", content: [{ type: "text", text: "just some prose" }], streaming: false, ts: 0 });
    expect(el.classList.contains("chat-narration")).toBe(true);
  });

  it("still tags a streaming assistant row chat-narration even if it already carries full marker text", () => {
    // Markers only resolve once the turn is finalized (chat-transforms.test.mjs
    // "renders no card yet while... streaming") - a still-streaming row must
    // keep the default narration hide, since no card exists yet to protect.
    const el = buildMessageEl({ kind: "assistant", content: [{ type: "text", text: markerText }], streaming: true, ts: 0 });
    expect(el.classList.contains("chat-narration")).toBe(true);
  });
});
