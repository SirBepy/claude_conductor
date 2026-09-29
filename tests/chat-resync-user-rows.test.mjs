// @vitest-environment jsdom
// Probe for todo 1018: the first billed chat-flow.e2e.js run saw assistant
// counts survive a chat-resync rebuild but user counts collapse (2 -> 1 on
// switch-back, 3 -> 1 after reload), right after a console
// "[chat-resync] ...: transcript has N message(s) this chat never painted -
// rebuilding" warning naming a missing tool_use sig. That sig only ever
// belongs to a quiet-mode reply (mcp__cc_conductor__send_message or an AUQ
// tool - see chat-transcript-sig.ts's visibleEventSigs/visibleMessageSigs),
// so this repro drops a reply's tool_use off the runner channel (the real
// failure mode: event-store-delivery.ts's cross-source dedup or the lossy
// notifier can eat a live frame - see project_daemon_notifier_broadcast_lossy)
// and drives the exact recovery path: event-store's reconcileLatest notices
// the transcript tail is stale, chat-resync.ts's onTranscriptTail sees the
// renderer never painted it and forces a full loadInitial+loadFromStore
// rebuild. The human side of each turn is delivered the way the real
// composer does it (pushSynthetic optimistic echo, then the JSONL watcher's
// remote_echo replay, deduped by content sig - event-store.ts:330-332 and
// event-store-delivery.ts's pendingEchoes).

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import { userEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
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
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

function sendMessageEvent(text, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__send_message", { text }, id, ts);
}
function toolResultEvent(id, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "" }, is_error: false, timestamp: ts };
}
function remoteEchoOf(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts, remote_echo: true };
}

describe("chat-resync rebuild keeps every human user row (todo 1018)", () => {
  it("recovers both user bubbles after a live-dropped reply forces a resync rebuild", async () => {
    const sid = `sess-resync-user-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    await sessionEvents.ensureWatchListener(sid);

    // Fresh session: nothing in the JSONL yet.
    invokeRouter.queueOnce("load_history_page", { events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();

    // Turn 1, exactly as the composer + daemon deliver it: optimistic
    // synthetic echo first, then the runner's tool_use/tool_result, then the
    // JSONL watcher's real replay (deduped against the synthetic by content).
    const alphaPrompt = "Reply with only the word ALPHA and nothing else.";
    sessionEvents.pushSynthetic(sid, userEvent(alphaPrompt, 0));
    bus.emit(`chat:${sid}`, sendMessageEvent("ALPHA", "toolu_alpha", 2));
    bus.emit(`chat:${sid}`, toolResultEvent("toolu_alpha", 3));
    bus.emit(`chat-watch:${sid}`, remoteEchoOf(alphaPrompt, 1));

    // Turn 2: same human-side delivery, but the reply's tool_use is the frame
    // the notifier drops - it never reaches this renderer's live channel.
    const betaPrompt = "Now reply with only the word BETA and nothing else.";
    sessionEvents.pushSynthetic(sid, userEvent(betaPrompt, 0));
    bus.emit(`chat-watch:${sid}`, remoteEchoOf(betaPrompt, 4));

    expect(r.messages.filter((m) => m.kind === "user").length).toBe(2);

    // The full, authoritative JSONL (what reconcileLatest and the forced
    // loadInitial both read) has always had the missing reply.
    const fullPage = {
      events: [
        userEvent(alphaPrompt, 1),
        sendMessageEvent("ALPHA", "toolu_alpha", 2),
        toolResultEvent("toolu_alpha", 3),
        userEvent(betaPrompt, 4),
        sendMessageEvent("BETA", "toolu_beta", 5),
        toolResultEvent("toolu_beta", 6),
      ],
      oldest_seq: 0,
      newest_seq: 6,
      has_more: false,
    };
    // reconcileLatest's own fetch, then chat-resync's forced loadInitial
    // refetch - both hit load_history_page in sequence.
    invokeRouter.queueOnce("load_history_page", fullPage);
    invokeRouter.queueOnce("load_history_page", fullPage);

    await sessionEvents.reconcileLatest(sid, undefined);
    // onTranscriptTail's rebuild is fire-and-forget (void async IIFE) -
    // give its microtasks/macrotasks a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const userRows = r.messages.filter((m) => m.kind === "user");
    expect(userRows.length).toBe(2);
  });

  // todo 1018 root cause: a message typed mid-turn is delivered by the
  // daemon's PostToolBatch hook (src-tauri/src/daemon/hooks_server/nudge.rs)
  // straight into the running turn. The live surface renders it via ONE
  // pushSynthetic (sessions-wiring.ts's held-messages-delivered handler) -
  // but unlike an ordinary send, the CLI never echoes it back as a real
  // "user" JSONL line on its live stream, so no chat-watch event ever fires
  // for it. It only reaches the transcript as a hook-context "attachment"
  // line, which src-tauri/src/chat/parser/mod.rs's "attachment" arm now
  // recovers as a plain user_message on history replay (read_page). This
  // test proves the TS dedup pipeline treats that recovered row as the same
  // message (not a drop, not a double) once a resync rebuild reads it back.
  it("recovers a mid-turn held message (no watcher echo, ever) after a resync rebuild, exactly once", async () => {
    const sid = `sess-resync-midturn-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    await sessionEvents.ensureWatchListener(sid);

    invokeRouter.queueOnce("load_history_page", { events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(sid);
    await r.loadFromStore();

    // Turn 1: an ordinary send, delivered the normal way.
    const alphaPrompt = "Reply with only the word ALPHA and nothing else.";
    sessionEvents.pushSynthetic(sid, userEvent(alphaPrompt, 0));
    bus.emit(`chat:${sid}`, sendMessageEvent("ALPHA", "toolu_alpha", 2));
    bus.emit(`chat:${sid}`, toolResultEvent("toolu_alpha", 3));
    bus.emit(`chat-watch:${sid}`, remoteEchoOf(alphaPrompt, 1));

    // Mid-turn: Joe types while turn 1 is still running. No chat-watch event
    // ever fires for this one - that absence is the bug's actual mechanism.
    const betaPrompt = "Now reply with only the word BETA and nothing else.";
    sessionEvents.pushSynthetic(sid, userEvent(betaPrompt, 0));

    expect(r.messages.filter((m) => m.kind === "user").length).toBe(2);

    // The authoritative JSONL page, as read_page now returns it post-fix: the
    // held message recovered from the "attachment" line as an ordinary
    // user_message (same shape the parser's new arm emits).
    const fullPage = {
      events: [
        userEvent(alphaPrompt, 1),
        sendMessageEvent("ALPHA", "toolu_alpha", 2),
        toolResultEvent("toolu_alpha", 3),
        userEvent(betaPrompt, 4),
        sendMessageEvent("BETA", "toolu_beta", 5),
        toolResultEvent("toolu_beta", 6),
      ],
      oldest_seq: 0,
      newest_seq: 6,
      has_more: false,
    };
    invokeRouter.queueOnce("load_history_page", fullPage);
    invokeRouter.queueOnce("load_history_page", fullPage);

    await sessionEvents.reconcileLatest(sid, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const userRows = r.messages.filter((m) => m.kind === "user");
    expect(userRows.length).toBe(2); // alpha + beta, beta recovered exactly once
  });
});
