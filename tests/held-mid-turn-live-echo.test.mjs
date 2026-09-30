// @vitest-environment jsdom
// Regression test for todo 926: a message typed mid-turn (held, then
// delivered into the running turn by nudge.rs's PostToolBatch hook) never
// showed up live in the chat pane - only a later resync/reload painted it,
// via the history parser's `parse_mid_turn_frame` recovery (commit
// `1c8d2797`). Root cause: the only signal reaching the frontend rode the
// global daemon notifier (`held_messages_delivered`), which silently drops
// frames under backpressure (`daemon/methods/lifecycle/notifier.rs`'s
// `Err(Lagged(_)) => continue`) - exactly the conditions of a busy mid-turn
// session. Fix: `nudge.rs` also broadcasts a `remote_echo: true`
// `ChatEvent::UserMessage` on the session's OWN chat-stream broadcast (the
// reliable, self-healing channel a live turn already streams
// assistant_delta/tool_use on - a lagged receiver there gets an explicit
// `events_lagged` signal instead of a silent drop).
//
// `remote_echo: true` is required, not incidental: event-store.ts's
// `ensureListener` drops every OTHER live `user_message` arriving on the
// runner channel (`chat -p --resume` replays history user lines there too,
// unmarked) - see the sibling case in remote-echo-user-message.test.mjs.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, assistantEvent, streamingEvent, makeBus } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;
if (!globalThis.window) globalThis.window = {};

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
  globalThis.window.__TAURI__ = undefined;
});

describe("mid-turn held-message delivery: held -> injected -> assistant reply", () => {
  it("renders the injected message as a user bubble exactly once, live, mid-turn", async () => {
    const sid = `sess-held-live-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("first", 1)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);

    // Turn is still running when the held message gets injected.
    bus.emit(`chat:${sid}`, streamingEvent("thinking…", 2));

    // What nudge.rs's on_tool_batch now broadcasts on the session's own
    // chat-stream, per the fix: a marked (remote_echo: true) UserMessage
    // carrying the delivered held item(s) as content blocks.
    bus.emit(`chat:${sid}`, { ...userEvent("BETA", 3), remote_echo: true });

    bus.emit(`chat:${sid}`, assistantEvent("done", 4));

    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    const betaRows = users.filter((e) => e.content?.[0]?.text === "BETA");
    expect(betaRows).toHaveLength(1);
    // Arrived between the streaming turn and its final reply, not appended after.
    const all = sessionEvents.events(sid);
    const betaIdx = all.findIndex((e) => e.type === "user_message" && e.content?.[0]?.text === "BETA");
    const doneIdx = all.findIndex((e) => e.type === "assistant_message" && e.content?.[0]?.text === "done");
    expect(betaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeLessThan(doneIdx);
  });

  it("stays exactly one row after a resync recovers the same message from the transcript (parse_mid_turn_frame's shape)", async () => {
    const sid = `sess-held-resync-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();

    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("first", 1)],
      oldest_seq: 0,
      newest_seq: 1,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);

    bus.emit(`chat:${sid}`, { ...userEvent("BETA", 3), remote_echo: true });
    bus.emit(`chat:${sid}`, assistantEvent("done", 4));

    // A resync (chat-resync heartbeat / reload) re-reads the authoritative
    // JSONL transcript. The history parser's "attachment" arm
    // (chat/parser/mod.rs) recovered BETA as an ordinary (unmarked)
    // user_message from the hook_additional_context attachment line - same
    // text, no remote_echo flag, since it's page/JSONL sourced, not a live
    // daemon echo.
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("first", 1), userEvent("BETA", 3), assistantEvent("done", 4)],
      oldest_seq: 0,
      newest_seq: 3,
      has_more: false,
    });
    const seen = [];
    const unsub = sessionEvents.subscribe(sid, (ev) => seen.push(ev));
    await sessionEvents.reconcileLatest(sid);
    unsub();

    const betaRows = sessionEvents.events(sid).filter(
      (e) => e.type === "user_message" && e.content?.[0]?.text === "BETA",
    );
    expect(betaRows).toHaveLength(1);
    // Nothing new was pushed through the subscriber path for BETA - the
    // cache already had it (sig-based diff in reconcileLatest), so no re-render.
    expect(seen.filter((e) => e.content?.[0]?.text === "BETA")).toHaveLength(0);
  });
});
