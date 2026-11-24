// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/question-liveness.ts
//
// Opening a chat after a while drew an old question card under Waiting on you a
// few times and then stopped (Joe, 2026-11-24). The card is dead (no daemon
// prompt holds it) or already skipped, but the dashboard drew it from the rows it
// had at once and only dropped it when the liveness read or the late Skip marks
// landed. A frame sampler on the Waiting card catches what a final assertion that
// waits for it to be gone does not: any draw at all.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock, heldRef } = vi.hoisted(() => ({ invokeMock: vi.fn(), heldRef: { value: [], marksDelay: 0, marks: [], reads: 0, fail: false, hang: false, readsAtFirstDraw: null } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
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
            if (heldRef.hang) return new Promise(() => {});
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
const { state } = await import("../src/views/sessions/state.ts");
const { QuestionLiveness } = await import("../src/views/sessions/chat-dashboard/question-liveness.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");

const ASK = "mcp__cc_conductor__ask_user_question";
const ACK = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';
const OLD = 1_762_000_000_000;
const result = (id, text, ts = 0) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts });
const askInput = (q) => ({ questions: [{ question: q, header: "Done card", options: [{ label: "A" }, { label: "B" }] }] });

/** An old unanswered card; `cardAtEnd` keeps it inside the newest page, else enough calls follow to push it above. */
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
    if (cmd === "get_skipped_question_marks") return new Promise((res) => setTimeout(() => res(structuredClone(heldRef.marks)), heldRef.marksDelay));
    if (cmd === "list_channel_messages") return Promise.resolve({ messages: [] });
    if (cmd === "list_message_drafts") return Promise.resolve({ drafts: [] });
    if (cmd === "list_subchat_cards" || cmd === "list_previews" || cmd === "ask_list_threads") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

let chat = 0;
/** Builds the pane and starts sampling the Waiting card BEFORE the chat loads, so a first draw is seen. */
async function openChat(events) {
  serve(events);
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  const sid = `flicker-${++chat}`;
  const frames = [];
  const seen = () => !!pane.querySelector(".cdash-waiting")?.textContent?.includes("What should go?");
  const sample = () => {
    const now = seen();
    if (now && heldRef.readsAtFirstDraw === null) heldRef.readsAtFirstDraw = heldRef.reads;
    frames.push(now);
  };
  const obs = new MutationObserver(sample);
  obs.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true });
  await r.attach(sid);
  state.renderer = r;
  const dash = new ChatDashboard(pane, r);
  await r.loadFromStore();
  return { pane, r, dash, sid, frames, stop: () => obs.disconnect() };
}

const settleTick = (ms = 300) => new Promise((res) => setTimeout(res, ms));
const skips = () => invokeMock.mock.calls.filter(([cmd, a]) => cmd === "respond_question" && a?.skipped).map(([, a]) => a.id);

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  heldRef.value = [];
  heldRef.marks = [];
  heldRef.marksDelay = 0;
  heldRef.reads = 0;
  heldRef.fail = false;
  heldRef.hang = false;
  heldRef.readsAtFirstDraw = null;
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

describe("a dead question card on a chat opened after a while", () => {
  it("above the loaded page: never drawn, not for one frame", async () => {
    const { frames, stop } = await openChat(transcript());
    await vi.waitFor(() => expect(skips()).toEqual(["q-old"]), { timeout: 10000, interval: 10 });
    await settleTick();
    stop();
    expect(frames.filter(Boolean)).toEqual([]);
  });

  it("a card the daemon still holds is drawn once and stays", async () => {
    // The prompt is held from the start (the next chat id is known): the liveness read finds it, so the card shows.
    heldRef.value = [{ id: "ignored", event: "question-requested", payload: { id: "q-old", session_id: `flicker-${chat + 1}`, questions: askInput("What should go?").questions } }];
    const { pane, frames, stop } = await openChat(transcript());
    await vi.waitFor(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("What should go?"), { timeout: 10000, interval: 10 });
    await settleTick();
    stop();
    expect(skips()).toEqual([]);
    expect(frames.at(-1)).toBe(true);
  });

  it("a card the daemon cannot be asked about is drawn once its read fails, not before", async () => {
    heldRef.fail = true;
    const { pane, frames, stop } = await openChat(transcript());
    await vi.waitFor(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("What should go?"), { timeout: 10000, interval: 10 });
    expect(heldRef.reads).toBeGreaterThan(0);
    stop();
    expect(frames.indexOf(true)).toBeGreaterThan(-1);
    // The first draw of the card comes after the failed read began, never before.
    expect(heldRef.readsAtFirstDraw).toBeGreaterThan(0);
    expect(skips()).toEqual([]);
  });

  it("a young card above the page draws at once, as before", async () => {
    const evs = transcript();
    const now = Date.now();
    evs[1].timestamp = now - 1000;
    evs[2].timestamp = now - 900;
    const { pane, stop } = await openChat(evs);
    await vi.waitFor(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("What should go?"), { timeout: 10000, interval: 10 });
    expect(heldRef.reads).toBe(0);
    stop();
  });

  it("skipped by a Skip mark that arrives after the page paints: never drawn", async () => {
    heldRef.marksDelay = 900;
    heldRef.marks = [{ timestamp: OLD + 30, question_id: "q-old" }];
    const { frames, stop } = await openChat(transcript({ cardAtEnd: true }));
    await settleTick(1500);
    stop();
    expect(frames.filter(Boolean)).toEqual([]);
  });
});

describe("skip marks that never arrive", () => {
  it("do not hide an old open card for good: it draws once the hold runs out", async () => {
    heldRef.marksDelay = 60_000;
    const { pane, stop } = await openChat(transcript({ cardAtEnd: true }));
    await settleTick(500);
    expect(pane.querySelector(".cdash-waiting")?.textContent ?? "").not.toContain("What should go?");
    await vi.waitFor(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("What should go?"), { timeout: 9000, interval: 50 });
    stop();
  }, 20000);
});

describe("a daemon read that never answers", () => {
  it("does not hide an old card for good: it draws once the read's deadline passes", async () => {
    heldRef.hang = true;
    const { pane, stop } = await openChat(transcript());
    await settleTick(500);
    expect(pane.querySelector(".cdash-waiting")?.textContent ?? "").not.toContain("What should go?");
    await vi.waitFor(() => expect(pane.querySelector(".cdash-waiting")?.textContent).toContain("What should go?"), { timeout: 9000, interval: 50 });
    stop();
    expect(skips()).toEqual([]);
  }, 20000);
});

describe("QuestionLiveness.apply while skip marks are pending", () => {
  const card = (id) => ({ kind: "question", id, ts: OLD, input: askInput("Which?") });

  it("holds an old card it never drew, and keeps one an earlier draw already showed", () => {
    let pending = null;
    const live = new QuestionLiveness({ sessionId: () => null, mirrored: () => false, settle: async () => {}, changed() {}, onScreenId: () => null, skipMarksPendingSince: () => pending });
    const rows = [card("a")];
    // Drawn while no marks were pending (a plain chat).
    expect(live.apply(rows, "skipped", Date.now())[0].text).toBeUndefined();
    // A reload now waits for marks: the drawn card stays, a card never drawn is held.
    pending = Date.now();
    const out = live.apply([card("a"), card("b")], "skipped", Date.now());
    expect(out[0].text).toBeUndefined();
    expect(out[1].text).toBe("skipped");
    live.dispose();
  });
});
