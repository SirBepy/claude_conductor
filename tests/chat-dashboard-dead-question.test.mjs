// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/question-liveness.ts, src/views/sessions/permission-modal/dismiss-open-questions.ts
//
// A question card above the loaded page that no daemon prompt holds cannot be
// brought back by a click (reopening rebuilds from the loaded transcript only),
// so it used to stay under Waiting on you for good, with "awaiting answer" and a
// toast on every click (Joe, 2026-11-21). The dashboard settles it as a Skip.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock, heldRef } = vi.hoisted(() => ({ invokeMock: vi.fn(), heldRef: { value: [] , fail: false, reads: 0 } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
// Everything but the daemon's prompt list is the real transport (the renderer listens on it).
vi.mock("../src/shared/transport.ts", async (orig) => {
  const real = await orig();
  return {
    ...real,
    getTransport: () => new Proxy(real.getTransport(), {
      get(target, prop) {
        if (prop === "call") {
          return async (method, args) => {
            if (method !== "list_pending_prompts") return target.call(method, args);
            heldRef.reads++;
            if (heldRef.fail) throw new Error("daemon unreachable");
            return heldRef.value;
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };
});

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { deadQuestionCards, LIVENESS_GRACE_MS, QUESTION_SETTLED_EVENT } = await import("../src/views/sessions/chat-dashboard/question-liveness.ts");
const { clearUnreopenableCard } = await import("../src/views/sessions/permission-modal/dismiss-open-questions.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");

const ASK = "mcp__cc_conductor__ask_user_question";
const ACK = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';
const OLD = 1_762_000_000_000;
const result = (id, text, ts = 0) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts });
const askInput = (q) => ({ questions: [{ question: q, header: "Done card", options: [{ label: "A" }, { label: "B" }] }] });

/** An old unanswered card, then enough tool calls that it sits above the newest page. */
function transcript({ cardAtEnd = false } = {}) {
  const evs = [userEvent("start", OLD)];
  const card = () => evs.push(toolUseEvent(ASK, askInput("What should go?"), "q-old", OLD + 10), result("q-old", ACK, OLD + 20));
  if (!cardAtEnd) card();
  for (let k = 0; k < 260; k++) {
    evs.push(toolUseEvent("Read", { file_path: `src/f${k}.ts` }, `r${k}`, OLD + 100 + k), result(`r${k}`, "body", OLD + 100 + k));
  }
  if (cardAtEnd) card();
  return evs;
}

const DIGEST_TOOLS = new Set([ASK]);
function digestOf(events) {
  const kept = new Set();
  const out = [];
  for (const ev of events) {
    if (ev.type === "user_message") out.push(ev);
    else if (ev.type === "tool_use" && DIGEST_TOOLS.has(ev.tool_name)) {
      kept.add(ev.id);
      out.push(ev);
    } else if (ev.type === "tool_result" && kept.has(ev.tool_use_id)) out.push(ev);
  }
  return out;
}

const PAGE = 200;
function serve(events) {
  const start = Math.max(0, events.length - PAGE);
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "load_history_page") return Promise.resolve(structuredClone({ events: events.slice(start), oldest_seq: start, newest_seq: events.length - 1, has_more: start > 0 }));
    if (cmd === "load_dashboard_digest") return Promise.resolve(structuredClone({ events: digestOf(events.slice(0, args.beforeSeq ?? events.length)), continues_from: null }));
    if (cmd === "list_channel_messages") return Promise.resolve({ messages: [] });
    if (cmd === "list_message_drafts") return Promise.resolve({ drafts: [] });
    if (cmd === "get_skipped_question_marks" || cmd === "list_subchat_cards" || cmd === "list_previews" || cmd === "ask_list_threads") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

let chat = 0;
async function openChat(events) {
  serve(events);
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  const sid = `dead-q-${++chat}`;
  await r.attach(sid);
  await r.loadFromStore();
  state.renderer = r;
  const dash = new ChatDashboard(pane, r);
  return { pane, r, dash, sid };
}

const waiting = (pane) => pane.querySelector(".cdash-waiting");
const skips = () => invokeMock.mock.calls.filter(([cmd, a]) => cmd === "respond_question" && a?.skipped).map(([, a]) => a.id);
const until = (check) => vi.waitFor(check, { timeout: 10000, interval: 10 });
const settleTick = () => new Promise((res) => setTimeout(res, 150));

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  heldRef.value = [];
  heldRef.fail = false;
  heldRef.reads = 0;
  state.renderer = null;
  state.sessions = [];
  globalThis.window.__TAURI__ = {};
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  setSettings({});
});

describe("deadQuestionCards", () => {
  const card = (id, q, ts = OLD) => ({ kind: "question", id, ts, input: askInput(q) });
  const NOW = OLD + 10 * LIVENESS_GRACE_MS;

  it("keeps a card a held prompt names by id, and judges the rest dead", () => {
    const cards = [card("a", "One?"), card("b", "Two?")];
    expect(deadQuestionCards(cards, [{ id: "a", questions: askInput("One?").questions }], NOW).map((c) => c.id)).toEqual(["b"]);
  });

  it("matches a prompt keyed by a random daemon id by what it asks, once", () => {
    const uuid = "0b1f9c52-3d0a-4f7e-9a40-1c2d3e4f5a6b";
    const cards = [card("a", "Same?"), card("b", "Same?")];
    expect(deadQuestionCards(cards, [{ id: uuid, questions: askInput("Same?").questions }], NOW).map((c) => c.id)).toEqual(["b"]);
  });

  it("a prompt asking the same thing keeps the card even when its id is not a daemon uuid", () => {
    // Claude Code sent no tool_use id, so the daemon keyed the prompt by something else.
    expect(deadQuestionCards([card("a", "Same?")], [{ id: "other-id", questions: askInput("Same?").questions }], NOW)).toEqual([]);
  });

  it("never judges a card younger than the grace", () => {
    expect(deadQuestionCards([card("a", "One?", NOW - 1000)], [], NOW)).toEqual([]);
    expect(deadQuestionCards([card("a", "One?", NOW - LIVENESS_GRACE_MS)], [], NOW).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("a question card above the loaded page", () => {
  it("leaves Waiting on you once no daemon prompt holds it, and its Skip mark is written", async () => {
    const { pane } = await openChat(transcript());
    await until(() => expect(skips()).toEqual(["q-old"]));
    await until(() => expect(waiting(pane)).toBeNull());
  });

  it("stays while the daemon still holds its prompt", async () => {
    heldRef.value = [{ id: "ignored", event: "question-requested", payload: { id: "q-old", session_id: "x", questions: askInput("What should go?").questions } }];
    const { pane, sid } = await openChat(transcript());
    heldRef.value[0].payload.session_id = sid;
    await until(() => expect(waiting(pane)?.textContent).toContain("What should go?"));
    await until(() => expect(heldRef.reads).toBeGreaterThan(0));
    await settleTick();
    expect(waiting(pane)?.textContent).toContain("What should go?");
    expect(skips()).toEqual([]);
  });

  it("stays when the daemon cannot be asked", async () => {
    heldRef.fail = true;
    const { pane } = await openChat(transcript());
    await until(() => expect(waiting(pane)?.textContent).toContain("What should go?"));
    await until(() => expect(heldRef.reads).toBeGreaterThan(0));
    await settleTick();
    expect(waiting(pane)?.textContent).toContain("What should go?");
    expect(skips()).toEqual([]);
  });

  it("a click that cannot reopen it clears it at once, with no daemon read needed", async () => {
    // The daemon holds it, so the liveness check keeps it: only the click clears it.
    const held = { id: "q-old", event: "question-requested", payload: { id: "q-old", session_id: "", questions: askInput("What should go?").questions } };
    heldRef.value = [held];
    const { pane, sid } = await openChat(transcript());
    held.payload.session_id = sid;
    await until(() => expect(waiting(pane)?.textContent).toContain("What should go?"));
    await clearUnreopenableCard(sid, "q-old");
    await until(() => expect(waiting(pane)).toBeNull());
    expect(skips()).toContain("q-old");
  });

  it("an announced settle drops it from the derive without waiting for a read", async () => {
    const held = { id: "q-old", event: "question-requested", payload: { id: "q-old", session_id: "", questions: askInput("What should go?").questions } };
    heldRef.value = [held];
    const { pane, sid } = await openChat(transcript());
    held.payload.session_id = sid;
    await until(() => expect(waiting(pane)?.textContent).toContain("What should go?"));
    window.dispatchEvent(new CustomEvent(QUESTION_SETTLED_EVENT, { detail: { sessionId: sid, id: "q-old" } }));
    await until(() => expect(waiting(pane)).toBeNull());
  });
});

describe("a question card inside the loaded page", () => {
  it("stays when no prompt is held: a click rebuilds it from the transcript, so it can still be answered", async () => {
    const { pane } = await openChat(transcript({ cardAtEnd: true }));
    await until(() => expect(waiting(pane)?.textContent).toContain("What should go?"));
    await settleTick();
    expect(waiting(pane)?.textContent).toContain("What should go?");
    expect(skips()).toEqual([]);
  });
});
