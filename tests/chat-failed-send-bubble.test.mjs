// The failure path nobody exercised: when send_message rejects, the optimistic
// bubble is the only surviving copy of what the user typed (the composer has
// already cleared itself). It must stay on screen, marked, with a Retry that
// re-sends those exact blocks and clears the marker once it lands.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

async function mountRenderer(sid) {
  globalThis.window.__TAURI__ = makeBus();
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sid);
  await r.loadFromStore();
  return { r, container };
}

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
});

afterEach(() => {
  delete globalThis.window.__TAURI__;
});

describe("failed-send bubble", () => {
  it("keeps the text on screen and marks the bubble", async () => {
    const { r, container } = await mountRenderer(`sess-failed-${Math.random()}`);
    sessionEvents.pushSynthetic(r.currentSessionId(), userEvent("do not lose this", Date.now()));

    r.markLastUserSendFailed("daemon client not connected", async () => {});

    const bubble = [...container.querySelectorAll(".msg.user")].at(-1);
    expect(bubble.classList.contains("send-failed")).toBe(true);
    expect(bubble.textContent).toContain("do not lose this");
    expect(bubble.querySelector(".failed-chip").title).toBe("daemon client not connected");
    expect(bubble.querySelector(".api-retry-btn")).not.toBeNull();
  });

  it("clears the marker when Retry succeeds", async () => {
    const { r, container } = await mountRenderer(`sess-retry-ok-${Math.random()}`);
    sessionEvents.pushSynthetic(r.currentSessionId(), userEvent("retry me", Date.now()));

    const retry = vi.fn(async () => {});
    r.markLastUserSendFailed("boom", retry);

    const bubble = [...container.querySelectorAll(".msg.user")].at(-1);
    bubble.querySelector(".api-retry-btn").click();

    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(bubble.classList.contains("send-failed")).toBe(false));
    expect(bubble.querySelector(".send-failed-strip")).toBeNull();
    expect(bubble.textContent).toContain("retry me");
  });

  it("re-arms the button when Retry fails again", async () => {
    const { r, container } = await mountRenderer(`sess-retry-fail-${Math.random()}`);
    sessionEvents.pushSynthetic(r.currentSessionId(), userEvent("still broken", Date.now()));

    const retry = vi.fn(async () => { throw new Error("still gone"); });
    r.markLastUserSendFailed("boom", retry);

    const bubble = [...container.querySelectorAll(".msg.user")].at(-1);
    const btn = bubble.querySelector(".api-retry-btn");
    btn.click();

    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(bubble.classList.contains("send-failed")).toBe(true);
    expect(bubble.querySelector(".failed-chip").title).toContain("still gone");
  });

  it("does not stack a second strip on a repeat failure", async () => {
    const { r, container } = await mountRenderer(`sess-no-stack-${Math.random()}`);
    sessionEvents.pushSynthetic(r.currentSessionId(), userEvent("once", Date.now()));

    r.markLastUserSendFailed("a", async () => {});
    r.markLastUserSendFailed("b", async () => {});

    const bubble = [...container.querySelectorAll(".msg.user")].at(-1);
    expect(bubble.querySelectorAll(".send-failed-strip")).toHaveLength(1);
  });
});
