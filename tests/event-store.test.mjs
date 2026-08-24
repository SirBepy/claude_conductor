import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, assistantEvent, streamingEvent, finalEvent, toolUseEvent, deltaEvent, eventsLaggedEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

describe("SessionEventStore pagination", () => {
  it("loadInitial caches and is idempotent", async () => {
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 1), assistantEvent("a1", 2)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const sid = "sess-cache-1";
    const first = await sessionEvents.loadInitial(sid);
    expect(first).toHaveLength(2);
    const second = await sessionEvents.loadInitial(sid);
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("loadOlder prepends and updates oldestSeq", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [userEvent("u3", 3), assistantEvent("a3", 4)],
        oldest_seq: 4,
        newest_seq: 5,
        has_more: true,
      })
      .mockResolvedValueOnce({
        events: [userEvent("u1", 1), assistantEvent("a1", 2)],
        oldest_seq: 0,
        newest_seq: 3,
        has_more: false,
      });
    const sid = "sess-prepend-1";
    await sessionEvents.loadInitial(sid);
    const older = await sessionEvents.loadOlder(sid);
    expect(older).not.toBeNull();
    expect(older).toHaveLength(2);
    const all = sessionEvents.events(sid);
    expect(all).toHaveLength(4);
    expect(all[0].content[0].text).toBe("u1");
    expect(all[3].content[0].text).toBe("a3");
  });

  it("loadOlder is single-flight under concurrent calls", async () => {
    let resolveInitial = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      })
    );
    const sid = "sess-single-1";
    const initialPromise = sessionEvents.loadInitial(sid);
    resolveInitial({
      events: [userEvent("u3", 3)],
      oldest_seq: 3,
      newest_seq: 3,
      has_more: true,
    });
    await initialPromise;

    let resolveOlder = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve;
      })
    );
    const a = sessionEvents.loadOlder(sid);
    const b = sessionEvents.loadOlder(sid);
    resolveOlder({
      events: [userEvent("u1", 1)],
      oldest_seq: 0,
      newest_seq: 2,
      has_more: false,
    });
    const [aRes, bRes] = await Promise.all([a, b]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(aRes).not.toBeNull();
    expect(bRes).toBeNull();
  });

  it("loadInitial drops pre-fetch synthetic/live events the JSONL page covers (ai_todo 65 reload dup)", async () => {
    const sid = "sess-reload-dup";
    // Optimistic echoes shown during the live turn carry real Date.now() ms;
    // the old timestamp filter let them survive on top of the JSONL copy.
    sessionEvents.pushSynthetic(sid, userEvent("hello", Date.now()));
    sessionEvents.pushSynthetic(sid, assistantEvent("hi there", Date.now()));
    // Authoritative JSONL page contains the same turn (ISO->0 timestamps).
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("hello", 0), assistantEvent("hi there", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const events = await sessionEvents.loadInitial(sid);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("loadInitial keeps live events that stream in during the fetch", async () => {
    const sid = "sess-reload-during";
    sessionEvents.pushSynthetic(sid, userEvent("u1", Date.now())); // covered by page
    // The mock body runs after loadInitial snapshots the pre-fetch buffer, so a
    // push here simulates an event streaming in DURING the fetch (not yet in
    // the page) - it must survive the merge.
    invokeMock.mockImplementationOnce(async () => {
      sessionEvents.pushSynthetic(sid, assistantEvent("live-during", Date.now()));
      return { events: [userEvent("u1", 0)], oldest_seq: 0, newest_seq: 0, has_more: false };
    });
    const events = await sessionEvents.loadInitial(sid);
    expect(events.map((e) => e.content[0].text)).toEqual(["u1", "live-during"]);
  });

  it("dedups an attachment message whose synthetic push carries <file:> tokens (doubled-bubble fix)", () => {
    const sid = "sess-attach-dedup";
    // Synthetic optimistic push: composer appends each attachment as its own
    // text block, so the joined text carries the <file:...> tokens.
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [
        { type: "text", text: "look at this" },
        { type: "text", text: "<file:C:\\\\imgs\\\\a.png::image.png>" },
      ],
      timestamp: Date.now(),
    });
    // File-watcher delivery of the JSONL transcript: the attachment is stored as
    // a separate image block, so the text-only content is just the typed text.
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [{ type: "text", text: "look at this" }],
      timestamp: Date.now(),
    });
    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });

  it("reconcileLatest recovers a turn the lossy live channel dropped", async () => {
    const sid = "sess-reconcile";
    // First load: one completed turn (u1 -> a1).
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("a1", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    // A later turn (u2 -> a2) completed while the chat was backgrounded, but the
    // assistant frame was dropped by the lossy daemon->app notifier and never
    // reached the store. The authoritative transcript HAS it.
    invokeMock.mockResolvedValueOnce({
      events: [
        userEvent("u1", 0),
        assistantEvent("a1", 0),
        userEvent("u2", 0),
        assistantEvent("a2 recovered", 0),
      ],
      oldest_seq: 0,
      newest_seq: 3,
      has_more: false,
    });
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev));
    await sessionEvents.reconcileLatest(sid);
    unsub();
    const assistants = sessionEvents.events(sid).filter((e) => e.type === "assistant_message");
    expect(assistants.map((e) => e.content[0].text)).toEqual(["a1", "a2 recovered"]);
    // Only the genuinely-missing events were re-delivered (no double-render of a1/u1).
    expect(seen.map((e) => e.content[0].text)).toEqual(["u2", "a2 recovered"]);
  });

  it("reconcileLatest is a no-op when the cache already has the latest turn", async () => {
    const sid = "sess-reconcile-noop";
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("a1", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    // Transcript matches the cache exactly: nothing to recover.
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("a1", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev));
    await sessionEvents.reconcileLatest(sid);
    unsub();
    expect(seen).toHaveLength(0);
    expect(sessionEvents.events(sid).filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("reconcileLatest does not double-recover a final that matches a cached streaming partial", async () => {
    const sid = "sess-reconcile-stream";
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    // The live channel delivered the streaming partials (full text accrued) but
    // the finalized line; the transcript stores it as a finalized assistant with
    // the same text. It must NOT be recovered as a fresh message.
    sessionEvents.pushSynthetic(sid, streamingEvent("the full answer", 0));
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("the full answer", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev));
    await sessionEvents.reconcileLatest(sid);
    unsub();
    expect(seen).toHaveLength(0);
  });

  it("reconcileLatest without force is a no-op on an uncached session", async () => {
    const sid = "sess-reconcile-uncached";
    await sessionEvents.reconcileLatest(sid);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(sessionEvents.isLoaded(sid)).toBe(false);
  });

  it("reconcileLatest with force loads an uncached session via loadInitial", async () => {
    const sid = "sess-reconcile-force-uncached";
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    await sessionEvents.reconcileLatest(sid, undefined, { force: true });
    expect(sessionEvents.isLoaded(sid)).toBe(true);
    expect(sessionEvents.events(sid)).toHaveLength(1);
  });

  it("loadInitial with force bypasses the cache-hit early return and re-fetches", async () => {
    const sid = "sess-loadinitial-force";
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("a1", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const events = await sessionEvents.loadInitial(sid, undefined, { force: true });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
  });

  it("an events_lagged live event forces a reconcile instead of rendering as a message", async () => {
    const sid = "sess-events-lagged";
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 0), assistantEvent("a1 recovered", 0)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev));
    sessionEvents.pushSynthetic(sid, eventsLaggedEvent(0));
    // deliver() fires the reconcile fire-and-forget; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    unsub();
    expect(seen.every((ev) => ev.type !== "events_lagged")).toBe(true);
    expect(sessionEvents.events(sid).some((e) => e.type === "events_lagged")).toBe(false);
    expect(sessionEvents.events(sid).filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("loadOlder returns null when hasMore is false", async () => {
    invokeMock.mockResolvedValueOnce({
      events: [userEvent("u1", 1)],
      oldest_seq: 0,
      newest_seq: 0,
      has_more: false,
    });
    const sid = "sess-no-more-1";
    await sessionEvents.loadInitial(sid);
    const older = await sessionEvents.loadOlder(sid);
    expect(older).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("assistant_delta accumulation (ai_todo 186)", () => {
  const turnUsage = () => ({
    type: "turn_usage",
    input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, total_cost_usd: 0, duration_ms: 1,
    has_thinking: false, model: null, awaiting: null, autopilot_changed: null,
  });

  it("accumulates chunks into one synthesized streaming assistant_message", () => {
    const sid = "sess-delta-accum";
    sessionEvents.pushSynthetic(sid, deltaEvent("Hel", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent("lo wor", 1, 2));
    sessionEvents.pushSynthetic(sid, deltaEvent("ld", 1, 3));
    const evs = sessionEvents.events(sid);
    // Successive deltas REPLACE the synthesized entry, not append one each.
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("assistant_message");
    expect(evs[0].streaming).toBe(true);
    expect(evs[0].content[0].text).toBe("Hello world");
  });

  it("subscribers see the growing accumulated text per delta", () => {
    const sid = "sess-delta-subs";
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev.content?.[0]?.text));
    sessionEvents.pushSynthetic(sid, deltaEvent("A", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent("B", 1, 2));
    unsub();
    expect(seen).toEqual(["A", "AB"]);
  });

  it("a new block restarts the accumulator", () => {
    const sid = "sess-delta-block";
    sessionEvents.pushSynthetic(sid, deltaEvent("first block", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent("second", 2, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent(" block", 2, 2));
    const evs = sessionEvents.events(sid);
    expect(evs[evs.length - 1].content[0].text).toBe("second block");
  });

  it("snapshot resync applies, then already-covered deltas are dropped", () => {
    const sid = "sess-delta-snap";
    // Mid-turn attach: snapshot carries everything streamed so far (seq 4)...
    sessionEvents.pushSynthetic(sid, deltaEvent("Hello wor", 1, 4, true));
    // ...then deltas queued behind it re-deliver covered chunks (seq <= 4).
    sessionEvents.pushSynthetic(sid, deltaEvent("wor", 1, 4));
    sessionEvents.pushSynthetic(sid, deltaEvent("ld", 1, 5));
    const evs = sessionEvents.events(sid);
    expect(evs).toHaveLength(1);
    expect(evs[0].content[0].text).toBe("Hello world");
  });

  it("a stale snapshot never regresses the accumulator", () => {
    const sid = "sess-delta-stale-snap";
    sessionEvents.pushSynthetic(sid, deltaEvent("Hello", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent(" world", 1, 2));
    sessionEvents.pushSynthetic(sid, deltaEvent("Hel", 1, 1, true)); // late/stale resync
    const evs = sessionEvents.events(sid);
    expect(evs[evs.length - 1].content[0].text).toBe("Hello world");
  });

  it("turn end resets numbering: next turn's seq-1 delta starts fresh", () => {
    const sid = "sess-delta-turn-reset";
    sessionEvents.pushSynthetic(sid, deltaEvent("turn one text", 1, 1));
    sessionEvents.pushSynthetic(sid, deltaEvent(" more", 1, 2));
    sessionEvents.pushSynthetic(sid, finalEvent("turn one text more"));
    sessionEvents.pushSynthetic(sid, turnUsage());
    // Fresh `claude -p` per turn restarts (block, seq) at (1, 1). Must not be
    // eaten as "already covered".
    sessionEvents.pushSynthetic(sid, deltaEvent("turn two", 1, 1));
    const evs = sessionEvents.events(sid);
    expect(evs[evs.length - 1].content[0].text).toBe("turn two");
    expect(evs[evs.length - 1].streaming).toBe(true);
  });

  it("suppresses the synthesized partial when a finalized assistant already covers it", () => {
    const sid = "sess-delta-final-first";
    // Watcher won the race: finalized full text landed first.
    sessionEvents.pushSynthetic(sid, finalEvent("complete answer"));
    sessionEvents.pushSynthetic(sid, deltaEvent("complete", 1, 1));
    const evs = sessionEvents.events(sid);
    expect(evs).toHaveLength(1);
    expect(evs[0].streaming).toBe(false);
  });

  it("interrupt: watcher's late delivery of the real streamed text does not double-render (ai_todo doubled-bubble-on-interrupt)", async () => {
    const sid = "sess-delta-interrupt";
    // Dedup is cross-source only (todo 693), so this drives the real runner and
    // watcher channels - pushSynthetic would tag every event "synthetic".
    globalThis.window.__TAURI__ = makeBus();
    const bus = globalThis.window.__TAURI__;
    // getTransport() caches for the process lifetime, and earlier tests in this
    // file resolved it to HttpTransport while __TAURI__ was undefined.
    resetTransportForTests();
    invokeMock.mockResolvedValue({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
    await sessionEvents.loadInitial(sid);
    await sessionEvents.ensureWatchListener(sid);
    // Runner streams partial text, then the user interrupts: the CLI finalizes
    // with its "[Request interrupted by user]" notice, not the accumulated text.
    bus.emit(`chat:${sid}`, deltaEvent("I'll look into", 1, 1));
    bus.emit(`chat:${sid}`, deltaEvent(" that now", 1, 2));
    bus.emit(`chat:${sid}`, finalEvent("[Request interrupted by user]"));
    // The file watcher later tails the JSONL transcript and delivers a genuine
    // finalized assistant_message with the SAME text that was streamed - this
    // must be deduped, not rendered as a second bubble.
    bus.emit(`chat-watch:${sid}`, finalEvent("I'll look into that now"));
    const assistants = sessionEvents.events(sid).filter((e) => e.type === "assistant_message");
    expect(assistants.map((e) => e.content[0].text)).toEqual([
      "I'll look into that now",
      "[Request interrupted by user]",
    ]);
  });

  it("does not clobber a non-delta event that landed between deltas", () => {
    const sid = "sess-delta-interleave";
    sessionEvents.pushSynthetic(sid, deltaEvent("part one", 1, 1));
    sessionEvents.pushSynthetic(sid, toolUseEvent("Read", { file_path: "/x" }, "toolu_x"));
    sessionEvents.pushSynthetic(sid, deltaEvent(" part two", 1, 2));
    const evs = sessionEvents.events(sid);
    expect(evs.map((e) => e.type)).toEqual([
      "assistant_message", "tool_use", "assistant_message",
    ]);
    expect(evs[2].content[0].text).toBe("part one part two");
  });
});
