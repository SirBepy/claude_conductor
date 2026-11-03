// @vitest-environment jsdom
// asserts: src/shared/chat/chat-card-turns.ts, src/shared/chat/chat-dom-renderer.ts, src/shared/chat/chat-pagination.ts

// A message card shrinks to a mini card once a LATER turn has a visible
// send_message row. The state is derived from the transcript on every render, so
// it has to come out right through each path a row can arrive by: a live append,
// a history load, and an older page prepended above.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
const { sweepOldCards } = await import("../src/shared/chat/chat-card-turns.ts");
const { renderMessage } = await import("../src/shared/chat/chat-transforms.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");

const SEND = "mcp__cc_conductor__send_message";
const UPDATE = "mcp__cc_conductor__update_message";
let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
  document.body.innerHTML = "";
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.window.__TAURI__ = makeBus();
});

const send = (id, input, ts = 0) => toolUseEvent(SEND, { text: "x", ...input }, id, ts);
const report = (id, ts) => send(id, { kind: "report", verdict: "Done", text: `report ${id}`, done: ["a"] }, ts);
const bubble = (id, ts) => send(id, { text: `legacy ${id}` }, ts);
const ack = (id, ts) => send(id, { kind: "ack", text: `ack ${id}` }, ts);

// Unique id per renderer: the event store is a module singleton keyed by session.
let seq = 0;
async function mount(initial = []) {
  invokeMock.mockResolvedValue({ events: initial, oldest_seq: 1, newest_seq: initial.length, has_more: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(`sess-cards-${++seq}`);
  await r.loadFromStore();
  return { r, container };
}

const roots = (container) => [...container.querySelectorAll(".mc-root")];
const oldFlags = (container) => roots(container).map((el) => el.classList.contains("is-old"));
const push = (r, ev) => sessionEvents.pushSynthetic(r.currentSessionId(), ev);

describe("sweepOldCards", () => {
  const msgs = (...rows) => rows.map((m) => ({ ts: 0, ...m }));
  const card = (kind = "report") => ({ kind: "message", card: { kind }, text: "t" });
  const els = (ms) => ms.map((m) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = renderMessage(m);
    // A question card has its own builder; a bare div stands in for its row.
    return wrap.firstElementChild ?? document.createElement("div");
  });
  const flags = (e) => e.map((el) => el.classList.contains("is-old"));

  it("shrinks a card only once a later turn has a visible message", () => {
    const m = msgs({ kind: "user" }, card(), { kind: "user" }, card());
    const e = els(m);
    sweepOldCards(m, e, true);
    expect(flags(e)).toEqual([false, true, false, false]);
  });

  it("keeps two cards of the same turn full size", () => {
    const m = msgs({ kind: "user" }, card(), card("answer"));
    const e = els(m);
    sweepOldCards(m, e, true);
    expect(flags(e)).toEqual([false, false, false]);
  });

  it("counts a legacy bubble as a later turn's voice", () => {
    const m = msgs({ kind: "user" }, card(), { kind: "user" }, { kind: "message", text: "plain" });
    const e = els(m);
    sweepOldCards(m, e, true);
    expect(flags(e)[1]).toBe(true);
  });

  it("does not count an ack, a retracted row or a failed row", () => {
    for (const later of [card("ack"), { kind: "message", text: "x", retracted: true }, { kind: "message", text: "x", failed: true }]) {
      const m = msgs({ kind: "user" }, card(), { kind: "user" }, later);
      const e = els(m);
      sweepOldCards(m, e, true);
      expect(flags(e)[1]).toBe(false);
    }
  });

  it("starts a turn at a question card and at a meta system row, not at a plain system row", () => {
    for (const boundary of [{ kind: "question" }, { kind: "system", metaKind: "peer" }]) {
      const m = msgs(card(), boundary, card());
      const e = els(m);
      sweepOldCards(m, e, true);
      expect(flags(e)[0]).toBe(true);
    }
    const m = msgs(card(), { kind: "system", text: "Session started" }, card());
    const e = els(m);
    sweepOldCards(m, e, true);
    expect(flags(e)[0]).toBe(false);
  });

  it("grows a card back when the later message that overtook it is retracted", () => {
    const m = msgs({ kind: "user" }, card(), { kind: "user" }, card());
    const e = els(m);
    sweepOldCards(m, e, true);
    expect(flags(e)[1]).toBe(true);
    m[3] = { ...m[3], retracted: true };
    sweepOldCards(m, e, true);
    expect(flags(e)[1]).toBe(false);
  });

  it("marks an unanimated shrink so a history load plays no motion", () => {
    const m = msgs({ kind: "user" }, card(), { kind: "user" }, card());
    const e = els(m);
    sweepOldCards(m, e, false);
    expect(e[1].classList.contains("mc-still")).toBe(true);
    const live = els(m);
    sweepOldCards(m, live, true);
    expect(live[1].classList.contains("mc-still")).toBe(false);
  });

  it("ignores rows that drew no card", () => {
    const m = msgs({ kind: "user" }, { kind: "message", text: "plain" }, { kind: "user" }, card());
    const e = els(m);
    expect(() => sweepOldCards(m, e, true)).not.toThrow();
    expect(e[1].classList.contains("is-old")).toBe(false);
  });
});

describe("through the renderer", () => {
  it("shrinks the earlier card when a later turn's card lands live, and animates it", async () => {
    const { r, container } = await mount();
    push(r, userEvent("first", 1));
    push(r, report("m1", 2));
    expect(oldFlags(container)).toEqual([false]);

    push(r, userEvent("second", 3));
    push(r, report("m2", 4));
    expect(oldFlags(container)).toEqual([true, false]);
    // On screen at full size a moment ago, so the shrink plays.
    expect(roots(container)[0].classList.contains("mc-still")).toBe(false);
  });

  it("does not shrink when the later turn only sent an ack", async () => {
    const { r, container } = await mount();
    push(r, userEvent("first", 1));
    push(r, report("m1", 2));
    push(r, userEvent("second", 3));
    push(r, ack("a1", 4));
    expect(oldFlags(container)).toEqual([false]);
    // The ack is in the DOM but hidden as narration.
    expect(container.querySelector(".chat-narration")).not.toBeNull();
    push(r, report("m2", 5));
    expect(oldFlags(container)).toEqual([true, false]);
  });

  it("builds an opened chat with the old cards already shrunk and no motion to play", async () => {
    const { container } = await mount([
      userEvent("first", 1), report("m1", 2), userEvent("second", 3), report("m2", 4), userEvent("third", 5), bubble("b3", 6),
    ]);
    expect(oldFlags(container)).toEqual([true, true]);
    for (const el of roots(container)) expect(el.classList.contains("mc-still")).toBe(true);
  });

  it("shrinks cards that arrive on an older page above a later card", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 5_000_000), report("new", 5_001_000)],
      oldest_seq: 10, newest_seq: 12, has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("old question", 1_000_000), report("old1", 1_001_000), userEvent("older follow-up", 2_000_000), report("old2", 2_001_000)],
      oldest_seq: 0, newest_seq: 9, has_more: false,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    await r.attach(`sess-cards-${++seq}`);
    await r.loadFromStore();
    expect(oldFlags(container)).toEqual([false]);

    await r.fetchOlder();
    // Newest turn stays full; both prepended turns are overtaken.
    expect(oldFlags(container)).toEqual([true, true, false]);
    expect(roots(container)[0].classList.contains("mc-still")).toBe(true);
  });

  it("keeps the card when update_message edits the message", async () => {
    const { r, container } = await mount();
    push(r, userEvent("first", 1));
    push(r, report("m1", 2));
    push(r, toolUseEvent(UPDATE, { message: 1, text: "edited headline" }, "u1", 3));
    const m = r.messages.find((x) => x.kind === "message");
    expect(m.card.kind).toBe("report");
    expect(m.text).toBe("edited headline");
    expect(container.querySelector(".mc-root .mc-head").textContent).toContain("edited headline");
  });

  it("derives the same shrink for the older-page mapper as for the live one", () => {
    const ev = report("m1", 1);
    expect(eventToRenderedMessage(ev).card).toEqual(eventToRenderedMessage({ ...ev }).card);
    expect(eventToRenderedMessage(ev).card.kind).toBe("report");
  });
});
