// @vitest-environment jsdom
// Regression for todo 945: Joe's verdict (2026-10-06) is that a held message
// nudge.rs delivers mid-turn must render ABOVE the assistant text that keeps
// streaming after the injection point, not appended below it.
//
// Before the fix, sessions-wiring.ts's "held-messages-delivered" handler
// pushed the delivered bubble via sessionEvents.pushSynthetic with no marker.
// chat-event-handler-messages.ts's handleUserMessageEvent treated ANY
// unmarked user_message as a brand-new turn boundary (enqueueTurnClose),
// which finalized the open streaming bubble in place and reset
// streamingIndex to null - but the held bubble itself was still only ever
// appended at the CURRENT end of r.messages. The next streaming delta then
// opened a fresh bubble at r.messages.length, i.e. AFTER the held message,
// so the bubble landed below whatever streamed next, not above it.
//
// Fix: sessions-wiring.ts now tags the synthetic event `heldDelivered: true`.
// chat-event-handler-messages.ts finalizes the open streaming bubble (so its
// pre-injection text freezes where it is) without closing the turn, then
// pushes the held bubble. event-store-delivery.ts's deliver() cuts the
// streamAcc accumulator at the same marker so the NEXT delta starts a fresh
// bubble instead of re-emitting the pre-injection text underneath it.

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, streamingEvent, finalEvent, deltaEvent } from "./helpers/chat-events.mjs";

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

beforeEach(() => {
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
  resetTransportForTests();
});

/** Marked exactly as sessions-wiring.ts's held-messages-delivered handler now does. */
function heldDeliveredEvent(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts, heldDelivered: true };
}

describe("held mid-turn delivery renders above the still-streaming text (todo 945)", () => {
  it("finalizes the pre-injection bubble, then opens a fresh one after the held bubble", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(userEvent("start"), { silent: true });
    const chipKeyAfterOpen = r.activeTurnChipKey;
    r.handleEvent(streamingEvent("Hello"), { silent: true });
    r.handleEvent(streamingEvent("Hello world"), { silent: true });

    // The nudge lands mid-turn, while "Hello world" is still the open
    // streaming bubble.
    r.handleEvent(heldDeliveredEvent("BETA"), { silent: true });

    // The held delivery is not a new turn: the tool/text that streamed
    // before it and whatever streams after it both belong to the SAME turn
    // chip/footer, so activeTurnChipKey must not have rotated.
    expect(r.activeTurnChipKey).toBe(chipKeyAfterOpen);

    // The turn keeps streaming after the injection.
    r.handleEvent(streamingEvent("continuing"), { silent: true });
    r.handleEvent(finalEvent("continuing, done"), { silent: true });

    const kinds = r.messages.map((m) => m.kind);
    expect(kinds).toEqual(["user", "assistant", "user", "assistant"]);

    const [, preInjection, held, postInjection] = r.messages;
    // Pre-injection text is frozen exactly where it was, above the held bubble.
    expect(preInjection.content[0].text).toBe("Hello world");
    expect(preInjection.streaming).toBe(false);
    expect(held.content[0].text).toBe("BETA");
    // The held bubble renders as a normal user bubble, not an authored/peer one.
    expect(held.authorSessionId).toBeFalsy();
    // Post-injection text is a NEW bubble (not a re-render of the old one)
    // and never re-includes the pre-injection text underneath the held bubble.
    expect(postInjection.content[0].text).toBe("continuing, done");
    expect(postInjection.streaming).toBe(false);
  });

  it("a held message with nothing streaming yet still renders as a normal bubble inside the open turn", () => {
    const r = new ChatRenderer(document.createElement("div"));
    r.handleEvent(userEvent("start"), { silent: true });
    r.handleEvent(heldDeliveredEvent("BETA"), { silent: true });
    r.handleEvent(finalEvent("done"), { silent: true });

    expect(r.messages.map((m) => m.kind)).toEqual(["user", "user", "assistant"]);
    expect(r.messages[1].content[0].text).toBe("BETA");
    expect(r.messages[2].content[0].text).toBe("done");
  });
});

describe("event-store: streamAcc does not re-accumulate pre-injection text across a held delivery (todo 945)", () => {
  it("the delta after a held delivery starts a fresh accumulator instead of appending onto the old text", () => {
    const sid = `sess-held-${Math.random()}`;
    const seen = [];
    sessionEvents.subscribe(sid, (ev) => seen.push(ev));

    sessionEvents.pushSynthetic(sid, deltaEvent("Hello", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent(" world", 1, 2));
    sessionEvents.pushSynthetic(sid, heldDeliveredEvent("BETA"));
    sessionEvents.pushSynthetic(sid, deltaEvent("continuing", 1, 3));

    const assistantTexts = seen
      .filter((e) => e.type === "assistant_message")
      .map((e) => e.content[0].text);
    // The post-injection delta's synthesized bubble carries ONLY its own new
    // text - never "Hello worldcontinuing" (the pre-injection text duplicated
    // underneath the held message).
    expect(assistantTexts).not.toContain("Hello worldcontinuing");
    expect(assistantTexts.at(-1)).toBe("continuing");
  });
});
