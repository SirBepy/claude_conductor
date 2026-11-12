// @vitest-environment jsdom
// asserts: src/shared/chat/shown-badly.ts, src/shared/chat/chat-message-card.ts

// "Shown badly": a right-click (a long-press on the phone) on any send_message
// card, a sub's card included, offers one menu item that logs the card's input
// and Joe's optional note through `flag_shown_badly`.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async () => ({ ok: true }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { renderMessage } = await import("../src/shared/chat/chat-transforms.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");
const { subCardRow, SUBCARD_TOOL } = await import("../src/shared/chat/subchat-cards.ts");
const { cardInputOf, cardAt, createShownBadlyContextMenu } = await import("../src/shared/chat/shown-badly.ts");

const TOOL = "mcp__cc_conductor__send_message";

function sent(id, input) {
  return eventToRenderedMessage({ type: "tool_use", id, tool_name: TOOL, input, ts: 1 });
}

const BLOCKER = { kind: "blocker", verdict: "Waiting on Gate 2", text: "Gate 2 holds the slot", points: ["p1"] };

function subBlocker() {
  return subCardRow({
    tool_name: SUBCARD_TOOL,
    input: { id: "c-7", ts: 2, parent_id: "main", kind: "blocker", sub_id: "sub-1", sub_name: "Gate 2", verdict: "Blocked", text: "No slot" },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function rightClick(el) {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  invoke.mockClear();
  document.body.innerHTML = "";
  // The desktop webview: isRemote() is false there.
  window.__TAURI__ = {};
});

describe("card key and input", () => {
  it("a card's root carries its tool_use id, a sub's card its card-log id", () => {
    const m = sent("toolu_1", BLOCKER);
    expect(renderMessage(m)).toContain('data-msg-id="toolu_1"');
    const sub = subBlocker();
    expect(sub).not.toBeNull();
    expect(renderMessage(sub)).toContain('data-msg-id="sub:c-7"');
  });

  it("rebuilds the send_message input with the tool's own field names", () => {
    const m = sent("toolu_1", { kind: "report", verdict: "Built", text: "Done.", done: ["a"], your_move: ["b"] });
    expect(cardInputOf(m)).toEqual({ kind: "report", verdict: "Built", text: "Done.", done: ["a"], your_move: ["b"] });
  });

  it("names the sub and its card for a sub's card", () => {
    const input = cardInputOf(subBlocker());
    expect(input.sub_card).toEqual({ id: "c-7", kind: "blocker", sub_id: "sub-1", sub_name: "Gate 2" });
  });

  it("a plain bubble with no kind is no card", () => {
    expect(cardInputOf(sent("toolu_2", { text: "old transcript" }))).toBeNull();
  });
});

describe("the right-click menu", () => {
  function mount(messages) {
    const host = document.createElement("div");
    host.innerHTML = messages.map((m) => renderMessage(m)).join("") + `<p class="plain">not a card</p>`;
    document.body.appendChild(host);
    host.addEventListener("contextmenu", createShownBadlyContextMenu(() => ({ sessionId: "sess-1", messages })));
    return host;
  }

  it("logs the card and Joe's note through flag_shown_badly", async () => {
    const m = sent("toolu_1", BLOCKER);
    const host = mount([m]);
    const e = rightClick(host.querySelector(".mc-verdict"));
    expect(e.defaultPrevented).toBe(true);
    const item = document.querySelector(".smore-item");
    expect(item?.textContent).toBe("Shown badly");
    item.click();
    const note = document.querySelector(".sbad-note");
    expect(note).not.toBeNull();
    note.value = "  not waiting on me  ";
    document.querySelector(".app-confirm-ok").click();
    await tick();
    expect(invoke).toHaveBeenCalledWith("flag_shown_badly", {
      chatId: "sess-1",
      messageId: "toolu_1",
      message: BLOCKER,
      note: "not waiting on me",
    });
  });

  it("a sub's card is flaggable and sends no tool_use id", async () => {
    const sub = subBlocker();
    const host = mount([sub]);
    rightClick(host.querySelector(".mc-root"));
    document.querySelector(".smore-item").click();
    document.querySelector(".app-confirm-ok").click();
    await tick();
    const [, args] = invoke.mock.calls[0];
    expect(args.messageId).toBeNull();
    expect(args.note).toBeNull();
    expect(args.message.sub_card.id).toBe("c-7");
  });

  it("cancelling the note logs nothing, and a right-click off a card keeps the webview menu", async () => {
    const host = mount([sent("toolu_1", BLOCKER)]);
    rightClick(host.querySelector(".mc-root"));
    document.querySelector(".smore-item").click();
    document.querySelector(".app-confirm-cancel").click();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(rightClick(host.querySelector(".plain")).defaultPrevented).toBe(false);
  });

  it("a right-click on selected text in a card keeps the webview's Copy menu", () => {
    const host = mount([sent("toolu_1", BLOCKER)]);
    const verdict = host.querySelector(".mc-verdict");
    const range = document.createRange();
    range.selectNodeContents(verdict);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const e = rightClick(verdict.firstElementChild ?? verdict);
    window.getSelection().removeAllRanges();
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector(".smore-item")).toBeNull();
  });

  it("a mouse right-click on an image in a card keeps the image's own menu", () => {
    const host = mount([sent("toolu_1", BLOCKER)]);
    const img = document.createElement("img");
    host.querySelector(".mc-verdict").appendChild(img);
    expect(rightClick(img).defaultPrevented).toBe(false);
    expect(document.querySelector(".smore-item")).toBeNull();
  });

  it("a long-press that selected a word still opens the menu", () => {
    const host = mount([sent("toolu_1", BLOCKER)]);
    const verdict = host.querySelector(".mc-verdict");
    const range = document.createRange();
    range.selectNodeContents(verdict);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(e, "pointerType", { value: "touch" });
    (verdict.firstElementChild ?? verdict).dispatchEvent(e);
    window.getSelection().removeAllRanges();
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector(".smore-item")?.textContent).toBe("Shown badly");
  });

  it("resolves a click to the card's own row", () => {
    const a = sent("toolu_a", BLOCKER);
    const b = sent("toolu_b", { ...BLOCKER, verdict: "Other" });
    const host = mount([a, b]);
    expect(cardAt(host.querySelectorAll(".mc-root")[1], [a, b])).toBe(b);
  });
});
