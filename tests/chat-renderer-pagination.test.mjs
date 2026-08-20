// Verifies that ChatRenderer.fetchOlder PREPENDS new DOM rather than
// rebuilding the existing transcript. We tag the existing message node and
// confirm it survives a page-load while messageEls.length grows by exactly
// the slice size.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

// Mock the ipc module before importing anything that touches it (event-store
// pulls it in at module-eval time).
const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
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
  // jsdom's getComputedStyle returns a CSSStyleDeclaration with empty values
  // by default; that's fine here, findScroller will simply return null.
});

// sidemenu.ts assigns to window at module-eval time, before any beforeEach can
// run. Provide a bare stub so the top-level import below doesn't throw; each
// test then gets a real JSDOM window via beforeEach.
if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

describe("ChatRenderer.fetchOlder prepends instead of rebuilding", () => {
  it("preserves existing nodes and grows messageEls by slice length", async () => {
    // Stub the IPC: first call (loadInitial) returns 1 message + has_more,
    // second call (loadOlder) returns 2 older messages.
    invokeRouter.queueOnce("load_history_page", {
      events: [assistantEvent("most-recent", 10)],
      oldest_seq: 10,
      newest_seq: 10,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("older-1", 1), assistantEvent("older-2", 2)],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);

    const renderer = new ChatRenderer(container);
    await renderer.attach("sess-prepend-test");
    await renderer.loadFromStore();

    // Sanity: one rendered message + tag it so we can prove identity-preserved.
    const els = renderer.messageEls;
    expect(els.length).toBe(1);
    const persistedNode = els[0];
    persistedNode.dataset.persisted = "yes";
    const persistedHtml = persistedNode.outerHTML;

    // Trigger pagination directly (the IntersectionObserver path is gated
    // behind layout, which jsdom doesn't compute).
    await renderer.fetchOlder();

    // 1. The originally-tagged node is still in the DOM and still wired into
    //    messageEls (NOT a freshly-built sibling with the same text).
    const stillThere = container.querySelector('[data-persisted="yes"]');
    expect(stillThere).not.toBeNull();
    expect(stillThere).toBe(persistedNode);
    expect(renderer.messageEls).toContain(persistedNode);
    expect(renderer.messageEls[renderer.messageEls.length - 1].outerHTML).toBe(persistedHtml);

    // 2. messageEls grew by exactly the slice size (2).
    expect(renderer.messageEls.length).toBe(3);
    expect(renderer.messages.length).toBe(3);

    // 3. New nodes are at the front; the older user message is index 0.
    expect(renderer.messages[0].kind).toBe("user");
    expect(renderer.messages[1].kind).toBe("assistant");
    expect(renderer.messages[2].kind).toBe("assistant"); // the most-recent one
  });
});
