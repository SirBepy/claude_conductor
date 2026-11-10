// @vitest-environment jsdom

// The question card's icon is a chat bubble with a question mark stacked inside
// it (Joe, 2026-11-10); the dotted bubble now belongs to the Answers card. Every
// place a question card draws its icon goes through questionIconHtml.

import { describe, it, expect } from "vitest";
import { questionIconHtml } from "../src/shared/question-icon.ts";
import { renderQuestionCardHtml } from "../src/shared/chat/tool-views.ts";

function host(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("question card icon", () => {
  it("stacks ph-question-mark inside ph-chat-circle and has no dots", () => {
    const el = host(questionIconHtml());
    const wrap = el.querySelector(".q-icon");
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector(".ph-chat-circle")).not.toBeNull();
    expect(wrap.querySelector(".ph-question-mark")).not.toBeNull();
    expect(el.querySelector(".ph-chat-circle-dots")).toBeNull();
  });

  it("the transcript question card's summary draws it", () => {
    const m = {
      kind: "tool",
      input: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "a" }] }] },
    };
    const el = host(renderQuestionCardHtml(m));
    const summary = el.querySelector(".question-card-summary");
    expect(summary).not.toBeNull();
    expect(summary.querySelector(".q-icon .ph-chat-circle")).not.toBeNull();
    expect(summary.querySelector(".q-icon .ph-question-mark")).not.toBeNull();
    expect(summary.querySelector(".ph-chat-circle-dots")).toBeNull();
  });
});
