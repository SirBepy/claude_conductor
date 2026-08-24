// Tests for the remote-echo user_message fix.
//
// Root cause: `claude -p --resume` replays the full transcript including past
// user messages (remote_echo: false). The event-store drops those to prevent
// duplicate bubbles. Phone/remote sends have no desktop pushSynthetic, so
// their user bubble was never rendered. Fix: the daemon `send_message` path
// broadcasts a ChatEvent::UserMessage with `remote_echo: true`; the event-
// store delivers those and relies on the existing sigOf/isLiveDuplicate dedup
// gate to suppress them when a matching pushSynthetic was already recorded.
//
// Four cases, each isolated to their own bus+session so state never crosses:
//
// 1. Phone send (no prior synthetic): marked echo arrives -> renders once.
// 2. Desktop own send (prior synthetic exists): marked echo deduplicated -> once.
// 3. Resume replay (remote_echo absent/false): NOT delivered -> zero bubbles.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, remoteEchoUserEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

// Each test gets a fresh store via a unique import by resetting the module.
// We share one import here because the store is module-level singleton and
// each test uses a unique session id with its own bus.

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
  resetTransportForTests();
});

describe("remote-echo user_message delivery", () => {
  it("phone-send case: marked echo renders exactly one user bubble when no prior synthetic", async () => {
    const sid = `sess-phone-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    // Ensure listener is attached for this session.
    await sessionEvents.loadInitial(sid);

    // Phone sends a message -> daemon broadcasts a marked echo on chat:<id>.
    bus.emit(`chat:${sid}`, remoteEchoUserEvent("hello from phone"));

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0].content[0].text).toBe("hello from phone");
  });

  it("desktop own-send case: marked echo is deduped when a matching pushSynthetic was already recorded", async () => {
    const sid = `sess-desktop-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    await sessionEvents.loadInitial(sid);

    // Desktop composer optimistic echo (pushSynthetic records sig u:hello).
    sessionEvents.pushSynthetic(sid, userEvent("hello", Date.now()));

    // Daemon's marked echo arrives on the channel; dedup gate should drop it.
    bus.emit(`chat:${sid}`, remoteEchoUserEvent("hello"));

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });

  it("resume-replay case: unmarked user_message on chat:<id> is dropped (renders zero)", async () => {
    const sid = `sess-resume-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    await sessionEvents.loadInitial(sid);

    // History replay event: remote_echo absent (defaults to false).
    bus.emit(`chat:${sid}`, userEvent("old history line"));

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(0);
  });

  it("resume-replay case: explicit remote_echo:false is also dropped", async () => {
    const sid = `sess-resume-explicit-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    await sessionEvents.loadInitial(sid);

    // Explicit remote_echo: false (matches the Rust parser output for --resume lines).
    bus.emit(`chat:${sid}`, { ...userEvent("old history line"), remote_echo: false });

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(0);
  });
});
