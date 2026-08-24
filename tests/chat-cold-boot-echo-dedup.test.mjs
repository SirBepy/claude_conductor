// Regression for todo 659: one `/pickup` rendered as TWO identical bubbles.
// Neither the isMeta route nor a normalization miss (both falsified against the
// real transcript). That session queued the prompt at 10:03:50.701Z and `claude`
// wrote the user record 24.9s later, well past the 10s DEDUP_WINDOW_MS.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

// Verbatim from the reported session's JSONL line 3 (the record Claude Code
// writes for the invocation itself).
const JSONL_PICKUP =
  "<command-message>pickup</command-message>\n<command-name>/pickup</command-name>";

async function mountRenderer(sid, bus) {
  globalThis.window.__TAURI__ = bus;
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sid);
  await r.loadFromStore();
  await sessionEvents.ensureWatchListener(sid);
  return r;
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-17T10:03:50.701Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cold-boot echo dedup (todo 659)", () => {
  it("a watcher replay 25s after the echo still renders exactly one bubble", async () => {
    const sid = `sess-coldboot-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, userEvent("/pickup", Date.now()));
    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(1);

    // The gap measured in the reported transcript.
    vi.setSystemTime(new Date("2026-08-17T10:04:15.569Z"));
    bus.emit(`chat-watch:${sid}`, userEvent(JSONL_PICKUP, 0));

    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("the hook-injected SKILL.md meta record adds no row of its own", async () => {
    const sid = `sess-coldboot-meta-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, userEvent("/pickup", Date.now()));
    vi.setSystemTime(new Date("2026-08-17T10:04:15.569Z"));
    bus.emit(`chat-watch:${sid}`, userEvent(JSONL_PICKUP, 0));
    bus.emit(`chat-watch:${sid}`, {
      ...userEvent("Base directory for this skill: C:\\skills\\pickup\n\n# /pickup\n\n> Pull the next planned todo.", 0),
      is_meta: true,
    });

    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(1);
    expect(r.messages.filter((m) => m.metaKind)).toHaveLength(0);
  });

  it("still renders both bubbles when the same command is genuinely sent twice", async () => {
    const sid = `sess-coldboot-twice-${Math.random()}`;
    const r = await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    sessionEvents.pushSynthetic(sid, userEvent("/pickup", Date.now()));
    vi.setSystemTime(new Date("2026-08-17T10:04:15.569Z"));
    bus.emit(`chat-watch:${sid}`, userEvent(JSONL_PICKUP, 0));

    vi.setSystemTime(new Date("2026-08-17T10:20:00.000Z"));
    sessionEvents.pushSynthetic(sid, userEvent("/pickup", Date.now()));

    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(2);
  });

  it("a rolled-back echo releases its token instead of swallowing a real turn", async () => {
    const sid = `sess-coldboot-failed-${Math.random()}`;
    await mountRenderer(sid, makeBus());
    const bus = globalThis.window.__TAURI__;

    const failed = userEvent("/pickup", Date.now());
    sessionEvents.pushSynthetic(sid, failed);
    sessionEvents.removeSynthetic(sid, failed);

    vi.setSystemTime(new Date("2026-08-17T10:04:15.569Z"));
    bus.emit(`chat-watch:${sid}`, userEvent(JSONL_PICKUP, 0));

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });
});
