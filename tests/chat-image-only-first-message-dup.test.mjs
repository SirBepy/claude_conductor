// A new chat started from a draft by sending ONLY an image showed that image
// twice. Image-only text is `<file:...>` tokens, which the dedup sig strips, so
// the message's sig degenerated to "u:" - the same sig as a tool-result-only
// user line - and pushSynthetic refuses to tokenize that. With no echo token,
// the only dedup left was the 10s cross-source window, and a cold `claude`
// writes the JSONL record well past it (24.9s measured, see chat-cold-boot-echo-dedup.test.mjs).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

const FILE_TOKEN = "<file:C:\\data\\attachments\\pending-1\\shot.png::shot.png>";
const imageOnly = (ts = 0) => userEvent(FILE_TOKEN, ts);
// The record `claude` may write instead: the image as a content block.
const imageBlockEvent = () => ({
  type: "user_message",
  content: [{ type: "image", mime: "image/png", data: "iVBORw0KGgo=" }],
  timestamp: 0,
});

async function mountRenderer(sid, bus, { watch = true } = {}) {
  globalThis.window.__TAURI__ = bus;
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sid);
  await r.loadFromStore();
  if (watch) await sessionEvents.ensureWatchListener(sid);
  return r;
}

const userRows = (r) => r.messages.filter((m) => m.kind === "user");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("image-only message echo dedup", () => {
  it("a watcher copy 25s after the echo (same file token) still renders one row", async () => {
    const sid = `sess-img-token-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    expect(userRows(r)).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-29T10:00:25.000Z"));
    bus.emit(`chat-watch:${sid}`, imageOnly(0));

    expect(userRows(r)).toHaveLength(1);
  });

  it("a watcher copy 25s after the echo (image content block) still renders one row", async () => {
    const sid = `sess-img-block-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    vi.setSystemTime(new Date("2026-10-29T10:00:25.000Z"));
    bus.emit(`chat-watch:${sid}`, imageBlockEvent());

    expect(userRows(r)).toHaveLength(1);
  });

  it("the draft's placeholder entry swapped to the real id keeps deduping a late copy", async () => {
    const placeholder = `pending-${Math.random()}`;
    const real = `sess-img-swap-${Math.random()}`;
    // A draft has no JSONL to tail yet, so no watcher is bound to the
    // placeholder channel; the real id's watcher is attached after the swap.
    const r = await mountRenderer(placeholder, makeBus(), { watch: false });
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(placeholder, imageOnly(Date.now()));
    await r.swapSubscription(real);
    await sessionEvents.ensureWatchListener(real);

    vi.setSystemTime(new Date("2026-10-29T10:00:25.000Z"));
    bus.emit(`chat-watch:${real}`, imageOnly(0));

    expect(sessionEvents.events(real).filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(userRows(r)).toHaveLength(1);
  });

  it("sending the same image twice still shows two rows", async () => {
    const sid = `sess-img-twice-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    vi.setSystemTime(new Date("2026-10-29T10:00:25.000Z"));
    bus.emit(`chat-watch:${sid}`, imageOnly(0));

    vi.setSystemTime(new Date("2026-10-29T10:20:00.000Z"));
    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));

    expect(userRows(r)).toHaveLength(2);
  });

  it("a second image sent after the first one's quick transcript copy still shows", async () => {
    const sid = `sess-img-quick-copy-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    // Inside DEDUP_WINDOW_MS: folds in via the recent-sig match, not the token.
    vi.setSystemTime(new Date("2026-10-29T10:00:03.000Z"));
    bus.emit(`chat-watch:${sid}`, imageOnly(0));

    vi.setSystemTime(new Date("2026-10-29T10:01:00.000Z"));
    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));

    expect(userRows(r)).toHaveLength(2);
  });

  it("an image from another device is not swallowed by the leftover token of an already-copied echo", async () => {
    const sid = `sess-img-leftover-token-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    // Inside DEDUP_WINDOW_MS: folds into the echo through `recent`, which must
    // also settle the echo's token.
    vi.setSystemTime(new Date("2026-10-29T10:00:03.000Z"));
    bus.emit(`chat-watch:${sid}`, imageBlockEvent());
    expect(userRows(r)).toHaveLength(1);

    // A different image sent from elsewhere, past the 10s window, inside the 5 min token window.
    vi.setSystemTime(new Date("2026-10-29T10:00:30.000Z"));
    bus.emit(`chat-watch:${sid}`, imageBlockEvent());

    expect(userRows(r)).toHaveLength(2);
  });

  it("a second image sent 3s after a transcript copy of the first still shows", async () => {
    const sid = `sess-img-after-watcher-copy-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    // The first image arrives only as a transcript copy (sent from another device).
    bus.emit(`chat-watch:${sid}`, imageBlockEvent());
    vi.setSystemTime(new Date("2026-10-29T10:00:03.000Z"));
    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));

    expect(userRows(r)).toHaveLength(2);
  });

  it("a transcript page with two image-only messages recovers the one the cache lacks", async () => {
    const sid = `sess-img-page-diff-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    expect(userRows(r)).toHaveLength(1);

    invokeMock.mockResolvedValue({
      events: [imageBlockEvent(), imageBlockEvent()],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.reconcileLatest(sid);

    expect(userRows(r)).toHaveLength(2);
  });

  it("a transcript page whose only image-only message the cache already holds adds nothing", async () => {
    const sid = `sess-img-page-same-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    invokeMock.mockResolvedValue({ events: [imageBlockEvent()], oldest_seq: 0, newest_seq: 0, has_more: false });
    await sessionEvents.reconcileLatest(sid);

    expect(userRows(r)).toHaveLength(1);
  });

  it("a tool-result-only user line is never swallowed by an image echo token", async () => {
    const sid = `sess-img-toolresult-${Math.random()}`;
    await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, imageOnly(Date.now()));
    vi.setSystemTime(new Date("2026-10-29T10:00:25.000Z"));
    bus.emit(`chat-watch:${sid}`, { type: "user_message", content: [], timestamp: 0 });

    expect(sessionEvents.events(sid).filter((e) => e.type === "user_message")).toHaveLength(2);
  });
});
