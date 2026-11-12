// @vitest-environment jsdom
// asserts: src/shared/chat/chat-classifiers.ts, src/shared/chat/chat-event-handler-messages.ts, src/shared/chat/chat-event-to-message.ts, src/shared/chat/event-store-delivery.ts, src/shared/chat/dashboard/dashboard-model.ts
//
// A compaction draws ONE quiet row and never a message from Joe, live and on
// history load. The events are what the Rust parser makes of the spike's real
// lines (tests/fixtures/compact-spike, pinned by chat/parser/compaction.rs).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { userEvent, assistantEvent, remoteEchoUserEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

// vitest runs from the repo root; import.meta.url is root-relative under jsdom.
const fixturePath = (name) => resolve("tests/fixtures/compact-spike", name);
const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const HISTORY = fixture("history-events.json");
const LIVE = fixture("live-events.json");
const TRANSCRIPT = readFileSync(fixturePath("transcript.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { isCompactUserMessage, cleanUserBlocks } = await import("../src/shared/chat/chat-classifiers.ts");
const { isJoeMessage, deriveStrip } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { flushRenderNow } = await import("../src/shared/chat/flush-scheduler.ts");

let invokeRouter;
beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  // The scrollback path observes its top sentinel; jsdom has no observer.
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  resetTransportForTests();
});

// Joe's own message before the compaction (spike section 0) and the reply after it.
const JOE = "Also an open job for you to remember: ping me about the 'quokka-migration' before touching delta.js again, no exceptions, and keep the word 'plinth' out of every commit message.";
const COMPACT_TYPED = "/compact keep the open jobs, decisions and Joe's last two messages word for word";

const text = (blocks) => (blocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");

/** Everything a compaction must never draw. */
function expectOneQuietRow(r, container) {
  const rows = r.messages.filter((m) => m.isCompaction);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("system");
  expect(rows[0].text).toBe("Compacted 85.8k to 9.9k");

  const chips = container.querySelectorAll(".compact-chip");
  expect(chips).toHaveLength(1);
  expect(chips[0].textContent).toBe("Compacted 85.8k to 9.9k");
  expect(chips[0].getAttribute("title")).toBe("Context compacted in 21s");

  // No Joe bubble for the command, the summary or the stdout line; no meta row for the caveat.
  const users = r.messages.filter((m) => m.kind === "user");
  for (const m of users) {
    expect(text(m.content)).not.toMatch(/\/compact|This session is being continued|local-command|PreCompact/);
  }
  expect(r.messages.some((m) => m.metaKind)).toBe(false);
  expect(container.textContent).not.toContain("Scheduled wake");

  // The dashboard never takes a compaction row for Joe.
  expect(rows.every((m) => !isJoeMessage(m))).toBe(true);
  const strip = deriveStrip({ messages: r.messages, plans: [] });
  expect(strip?.messages.map((m) => text(m.content))).toEqual([JOE]);
}

async function rendererFor(sid) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(sid);
  await r.loadFromStore();
  flushRenderNow(r);
  return { r, container };
}

function rendererOver(events) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  for (const ev of events) r.handleEvent(ev);
  flushRenderNow(r);
  return { r, container };
}

describe("compaction lines in the classifier", () => {
  it("the /compact command line (slash form) and the typed echo are compaction, not messages", () => {
    const commandLine = TRANSCRIPT.find((l) => l.message?.content?.includes?.("<command-name>/compact</command-name>"));
    expect(isCompactUserMessage([{ type: "text", text: commandLine.message.content }])).toBe(true);
    expect(isCompactUserMessage([{ type: "text", text: COMPACT_TYPED }])).toBe(true);
    expect(isCompactUserMessage([{ type: "text", text: "/compact" }])).toBe(true);
    expect(isCompactUserMessage([{ type: "text", text: "why did /compact run?" }])).toBe(false);
    expect(isCompactUserMessage([{ type: "text", text: "/compactor is a word" }])).toBe(false);
    // A held message is one block per paragraph; a later "/compact" paragraph keeps it a message.
    expect(isCompactUserMessage([{ type: "text", text: "First thought." }, { type: "text", text: "/compact later, not now" }])).toBe(false);
  });

  it("the local-command caveat cleans to nothing", () => {
    const caveat = TRANSCRIPT.find((l) => l.isMeta === true);
    expect(cleanUserBlocks([{ type: "text", text: caveat.message.content }])).toEqual([]);
  });
});

describe("a compaction draws one quiet row", () => {
  it("on history load (initial hydrate)", async () => {
    const sid = `sess-compact-hist-${Math.random()}`;
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent(JOE, 1794487000000), assistantEvent("Noted.", 1794487001000), ...HISTORY, assistantEvent("Still here.", 1794487300000)],
      oldest_seq: 0,
      newest_seq: 20,
      has_more: false,
    });
    const { r, container } = await rendererFor(sid);
    expectOneQuietRow(r, container);
  });

  it("on scrollback (older page)", async () => {
    const sid = `sess-compact-page-${Math.random()}`;
    invokeRouter.queueOnce("load_history_page", {
      events: [assistantEvent("Still here.", 1794487300000)],
      oldest_seq: 15,
      newest_seq: 20,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent(JOE, 1794487000000), assistantEvent("Noted.", 1794487001000), ...HISTORY],
      oldest_seq: 0,
      newest_seq: 14,
      has_more: false,
    });
    const { r, container } = await rendererFor(sid);
    await r.fetchOlder();
    flushRenderNow(r);
    expectOneQuietRow(r, container);
  });

  it("live: the typed echo, the boundary and the summary the pump publishes", async () => {
    const sid = `sess-compact-live-${Math.random()}`;
    const bus = makeBus();
    globalThis.window.__TAURI__ = bus;
    resetTransportForTests();
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent(JOE, 1794487000000), assistantEvent("Noted.", 1794487001000)],
      oldest_seq: 0,
      newest_seq: 2,
      has_more: false,
    });
    await sessionEvents.loadInitial(sid);
    await sessionEvents.ensureWatchListener(sid);

    bus.emit(`chat:${sid}`, remoteEchoUserEvent(COMPACT_TYPED));
    for (const ev of LIVE) bus.emit(`chat:${sid}`, ev);
    // The file watcher reads the same lines from the transcript: the boundary
    // again, plus the caveat, command and stdout user lines.
    for (const ev of HISTORY) bus.emit(`chat-watch:${sid}`, ev);

    const { r, container } = rendererOver(sessionEvents.events(sid));
    expectOneQuietRow(r, container);
  });

  it("the same boundary delivered twice still draws one row", () => {
    const boundary = HISTORY.find((e) => e.type === "compacted");
    const { r, container } = rendererOver([userEvent(JOE, 1), assistantEvent("Noted.", 2), ...HISTORY, { ...boundary, timestamp: 0 }]);
    expectOneQuietRow(r, container);
  });

  it("an auto-compact inside a running turn joins that turn instead of splitting its footer", () => {
    const auto = { type: "compacted", pre_tokens: 160000, post_tokens: 12000, duration_ms: 30000, trigger: "auto", timestamp: 0 };
    const turnUsage = { type: "turn_usage", input_tokens: 12000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_cost_usd: 0, duration_ms: 90000, has_thinking: false, model: "m", awaiting: null, autopilot_changed: null };
    const { r, container } = rendererOver([
      userEvent("Refactor the parser.", 0),
      toolUseEvent("Bash", { command: "ls" }, "t1", 0),
      { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
      auto,
      toolUseEvent("Bash", { command: "cargo test" }, "t2", 0),
      { type: "tool_result", tool_use_id: "t2", output: { type: "text", text: "ok" }, is_error: false, timestamp: 0 },
      assistantEvent("Done.", 0),
      turnUsage,
    ]);
    const chips = container.querySelectorAll(".compact-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("Compacted 160.0k to 12.0k");
    expect(chips[0].getAttribute("title")).toBe("Claude Code compacted the context automatically in 30s");
    expect(container.querySelectorAll(".turn-footer")).toHaveLength(1);
    expect(r.messages.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("the compaction opens a turn, so the dashboard's last Joe message stays his own", () => {
    const { r } = rendererOver([userEvent(JOE, 1), assistantEvent("Noted.", 2), ...HISTORY]);
    const lastJoe = r.messages.findLastIndex(isJoeMessage);
    expect(text(r.messages[lastJoe].content)).toBe(JOE);
    expect(r.messages.findIndex((m) => m.isCompaction)).toBeGreaterThan(lastJoe);
  });
});
