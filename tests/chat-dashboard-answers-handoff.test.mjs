// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/answers-model.ts

// Send thread to chat (Joe, 2026-11-11): from an Answers-card thread he hands
// the whole thread to the chat that wrote the answer, as his own message. The
// chat never saw the thread (it ran in the read-only Ask sidecar), so the
// message carries it verbatim under a quote line naming the answer.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { buildAnswerItems, canHandOff, threadHandoffText, emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const SEND = "mcp__cc_conductor__send_message";
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });
const thread = (id, msgs) => ({
  id, created_at: 0, updated_at: 0, sidecar_session_id: null,
  messages: msgs.map(([role, text, ts]) => ({ role, text, ts })),
});

function answerItems(side) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("does the trello token need write access?"));
  r.handleEvent(toolUseEvent(SEND, { kind: "answer", verdict: "Yes, it needs write access", question: "Does the Trello token need write access?", text: "Creating cards needs the write scope." }, "a1", 0));
  r.handleEvent(ok("a1"));
  return buildAnswerItems(r.messages, side);
}

describe("Send thread to chat", () => {
  it("has nothing to hand over until the thread holds a follow-up the chat never saw", () => {
    const [bare] = answerItems({ store: emptyStore(), threads: [] });
    expect(canHandOff(bare)).toBe(false);

    const store = emptyStore();
    store.threads.a1 = "th";
    const [threaded] = answerItems({ store, threads: [thread("th", [["user", "can we only comment instead?", 1], ["assistant", "Yes: comments need no write scope.", 2]])] });
    expect(canHandOff(threaded)).toBe(true);
  });

  it("sends the thread verbatim under a quote of the answer, with the box's text as the ask", () => {
    const store = emptyStore();
    store.threads.a1 = "th";
    const [item] = answerItems({ store, threads: [thread("th", [
      ["user", "can we only comment instead?", 1],
      ["assistant", "Yes: comments need no write scope.\nSUGGESTED: switch to comments", 2],
    ])] });
    expect(threadHandoffText(item, "  do that  ")).toBe([
      "> Re: Yes, it needs write access",
      "",
      "do that",
      "",
      "The thread, from my Answers card (a read-only side chat):",
      "",
      "**Me:** does the trello token need write access?",
      "",
      "**Your answer:** Yes, it needs write access\n\nCreating cards needs the write scope.",
      "",
      "**Me:** can we only comment instead?",
      "",
      "**Thread:** Yes: comments need no write scope.",
    ].join("\n"));
    // No ask typed: the chat is told to pick the thread up.
    expect(threadHandoffText(item, "")).toContain("Pick it up from where it ended.");
  });

  it("labels a + question's reply as the thread's, and a sub's answer by its name when it lands elsewhere", () => {
    const store = emptyStore();
    store.questions.push({ thread_id: "nq", asked_at: 10 });
    const items = answerItems({ store, threads: [thread("nq", [
      ["user", "does trello need a paid plan?", 10],
      ["assistant", "QUESTION: Does Trello need a paid plan?\nVERDICT: No, the free plan works\n\nThe key works on any plan.", 30],
    ])] });
    const asked = items.find((i) => i.asked);
    expect(canHandOff(asked)).toBe(true);
    const text = threadHandoffText(asked, "");
    expect(text).toContain("**Me:** does trello need a paid plan?");
    expect(text).toContain("**Thread:** No, the free plan works\n\nThe key works on any plan.");
    expect(text).toContain("I asked this in a side thread");

    const sub = { ...items.find((i) => !i.asked), author: { name: "phone-ime", model: "opus", effort: "high", subId: "sub-1" }, thread: thread("t", [["user", "why?", 1], ["assistant", "Because.", 2]]) };
    expect(threadHandoffText(sub, "", true)).toContain("**Your answer:**");
    expect(threadHandoffText(sub, "", false)).toContain("**phone-ime's answer:**");
  });
});
