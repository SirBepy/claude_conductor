// @vitest-environment jsdom
// asserts: src/shared/chat/subchat-cards.ts, src/shared/chat/chat-subchat-card.ts, src/shared/chat/chat-card-turns.ts, src/shared/chat/chat-renderer.ts, src/shared/chat/chat-pagination.ts

// A sub's card in its main chat. The daemon stores it (it is in no transcript),
// the chat merges it into the timeline by timestamp, and it has to come out
// right through every path a row can arrive by: a load, an older page, the live
// frame, and a reload. Facts on the card come from code, so unknown shows as
// unknown. The real CSS and the phone width are driven by
// e2e/view-harness/subchat-cards.view.spec.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sweepOldCards } = await import("../src/shared/chat/chat-card-turns.ts");
const { mergeSubCards, normalizeCards, subCardEvent, SUBCARD_TOOL } = await import("../src/shared/chat/subchat-cards.ts");
const { renderMessage } = await import("../src/shared/chat/chat-transforms.ts");
const { resolveOrdinalIn } = await import("../src/shared/chat/chat-pagination.ts");
const { currentTurnNextActions } = await import("../src/shared/chat/chat-next-actions.ts");

const SEND = "mcp__cc_conductor__send_message";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let bus;
let pages;
let cards;
beforeEach(() => {
  invokeMock.mockReset();
  pages = [];
  cards = [];
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "load_history_page") {
      const page = args?.beforeSeq !== undefined ? pages[1] : pages[0];
      return Promise.resolve(page ?? { events: [], oldest_seq: 0, newest_seq: 0, has_more: false });
    }
    if (cmd === "list_subchat_cards") return Promise.resolve(cards);
    if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  document.body.innerHTML = "";
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  bus = makeBus();
  globalThis.window.__TAURI__ = bus;
});

const facts = (over = {}) => ({
  since: "spawn", commits: 2, files_changed: 3, insertions: 10, deletions: 1, scoped: true,
  uncommitted: 0, uncommitted_files: [], pushed: false,
  test: { state: "passed", command: "cargo test --lib", summary: "test result: ok. 4 passed", stale: false },
  reviewer: { state: "ran", text: "Found 1 problem, fixed." }, head: "abc", ...over,
});
const card = (id, ts, over = {}) => ({
  id, ts, parent_id: "main", kind: "finish", sub_id: "sub-header", sub_name: "Header", round: 1,
  verdict: "Built, not pushed", tone: null, text: `report ${id}`, points: [], done: ["header"], not_done: [], waiting_on: [], your_move: [],
  facts: facts(), sum: null, set_key: null, ...over,
});
const say = (id, ts) => toolUseEvent(SEND, { kind: "report", verdict: "Done", text: `main ${id}`, done: ["a"] }, id, ts);
const page = (events, hasMore = false) => ({ events, oldest_seq: 1, newest_seq: events.length, has_more: hasMore });

let seq = 0;
async function open() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  await r.attach(`sess-subcards-${++seq}`);
  await r.loadFromStore();
  return { r, container };
}
const order = (container) => [...container.querySelectorAll(".msg.mc-root")].map((el) => el.querySelector(".mc-head, .mc-mini-head")?.textContent?.trim() ?? "");
const subRoots = (container) => [...container.querySelectorAll('.mc-root[data-sub-card="1"]')];

describe("merging by timestamp", () => {
  const ev = (ts) => userEvent(`u${ts}`, ts);
  const placed = () => new Set();

  it("puts each card between the events it falls between, and an event-less tail last", () => {
    const merged = mergeSubCards([ev(T0), ev(T0 + 10 * MIN), ev(T0 + 20 * MIN)], [card("a", T0 + 5 * MIN), card("z", T0 + 30 * MIN)], placed(), false);
    expect(merged.map((e) => e.type === "tool_use" ? e.id : e.content[0].text)).toEqual([`u${T0}`, "a", `u${T0 + 10 * MIN}`, `u${T0 + 20 * MIN}`, "z"]);
  });

  it("a card is placed once however often the same pool is merged", () => {
    const p = placed();
    const first = mergeSubCards([ev(T0)], [card("a", T0 + 1)], p, false);
    const again = mergeSubCards([ev(T0)], [card("a", T0 + 1)], p, false);
    expect(first.filter((e) => e.type === "tool_use")).toHaveLength(1);
    expect(again.filter((e) => e.type === "tool_use")).toHaveLength(0);
  });

  it("with older pages left, only cards from this page on belong to it", () => {
    const merged = mergeSubCards([ev(T0 + 10 * MIN)], [card("old", T0), card("here", T0 + 11 * MIN)], placed(), true);
    expect(merged.filter((e) => e.type === "tool_use").map((e) => e.id)).toEqual(["here"]);
  });

  it("a tool_result with no time of its own is never split from its call", () => {
    const call = toolUseEvent("Read", {}, "t1", T0);
    const result = { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "x" }, is_error: false };
    const merged = mergeSubCards([call, result, ev(T0 + 10 * MIN)], [card("a", T0 + 1)], placed(), false);
    expect(merged.map((e) => e.type)).toEqual(["tool_use", "tool_result", "tool_use", "user_message"]);
    expect(merged[0].tool_name).toBe("Read");
    expect(merged[1].type).toBe("tool_result");
  });

  it("drops anything that is not a card", () => {
    expect(normalizeCards({ events: [] })).toEqual([]);
    expect(normalizeCards([{ id: "x" }, null, card("ok", 5), { ...card("bad", 1), kind: "weird" }]).map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("a sub's card in the main chat", () => {
  it("shows tagged with the sub's name and the real report beside the main agent's own cards, in time order", async () => {
    pages = [page([userEvent("go", T0), say("m1", T0 + MIN), userEvent("again", T0 + 20 * MIN), say("m2", T0 + 21 * MIN)])];
    cards = [card("c1", T0 + 10 * MIN)];
    const { container } = await open();
    expect(order(container)).toEqual(["main m1", "report c1", "main m2"]);
    const [sub] = subRoots(container);
    expect(sub.querySelector(".mc-full .mc-sub-name").textContent).toBe("Header");
    expect(sub.querySelector(".mc-full .mc-verdict").textContent).toBe("Built, not pushed");
  });

  it("reopening the chat shows the same cards in the same order without reading any sub", async () => {
    pages = [page([userEvent("go", T0), say("m1", T0 + MIN)])];
    cards = [card("c1", T0 + 5 * MIN)];
    const first = await open();
    expect(subRoots(first.container)).toHaveLength(1);
    const second = await open();
    expect(subRoots(second.container)).toHaveLength(1);
    expect(order(second.container)[1]).toContain("c1");
    const asked = invokeMock.mock.calls.filter((c) => c[0] === "load_history_page").map((c) => c[1].sessionId);
    expect(asked.every((id) => id.startsWith("sess-subcards-"))).toBe(true);
  });

  it("an older page puts its cards in their own place and none twice", async () => {
    pages = [
      page([userEvent("late", T0 + 30 * MIN), say("m3", T0 + 31 * MIN)], true),
      page([userEvent("early", T0), say("m1", T0 + MIN)]),
    ];
    cards = [card("c-old", T0 + 5 * MIN), card("c-new", T0 + 35 * MIN)];
    const { r, container } = await open();
    expect(subRoots(container).map((e) => e.textContent)).toHaveLength(1);
    expect(order(container).join("|")).toContain("c-new");
    expect(order(container).join("|")).not.toContain("c-old");
    await r.fetchOlder();
    const seen = order(container);
    expect(seen.findIndex((t) => t.includes("m1"))).toBeLessThan(seen.findIndex((t) => t.includes("c-old")));
    expect(seen.findIndex((t) => t.includes("c-old"))).toBeLessThan(seen.findIndex((t) => t.includes("m3")));
    expect(seen.filter((t) => t.includes("c-old"))).toHaveLength(1);
    expect(seen.filter((t) => t.includes("c-new"))).toHaveLength(1);
  });

  it("a live frame appends the card once, and a frame for another chat is ignored", async () => {
    pages = [page([userEvent("go", T0), say("m1", T0 + MIN)])];
    const { r, container } = await open();
    const sid = r.currentSessionId();
    bus.emit("subchat-card", { session_id: "someone-else", card: card("x", T0 + 9 * MIN) });
    expect(subRoots(container)).toHaveLength(0);
    bus.emit("subchat-card", { session_id: sid, card: card("live1", T0 + 9 * MIN) });
    bus.emit("subchat-card", { session_id: sid, card: card("live1", T0 + 9 * MIN) });
    await new Promise((res) => setTimeout(res, 20));
    expect(subRoots(container)).toHaveLength(1);
    expect(order(container).at(-1)).toContain("live1");
  });

  it("does not make the main agent's own bookkeeping count it", async () => {
    pages = [page([userEvent("go", T0), toolUseEvent(SEND, { kind: "answer", verdict: "Yes", text: "mine", next_actions: ["Do it"] }, "m1", T0 + MIN)])];
    cards = [card("c1", T0 + 5 * MIN)];
    const { r } = await open();
    expect(currentTurnNextActions(r.messages)).toEqual(["Do it"]);
    // update_message n=1 still addresses the main agent's own newest message.
    expect(r.messages[resolveOrdinalIn(r.messages, 1)].text).toBe("mine");
  });
});

describe("what the chips say", () => {
  const render = async (c) => {
    pages = [page([userEvent("go", T0)])];
    cards = [c];
    const { container } = await open();
    return subRoots(container)[0];
  };

  it("states commits, files, uncommitted, test, reviewer and not pushed from the facts", async () => {
    const el = await render(card("c1", T0 + MIN));
    const chips = [...el.querySelectorAll(".mc-full .mc-facts .mc-chip")].map((c) => c.textContent.trim());
    expect(chips).toEqual(["2", "3", "0", "passed", "ran", "not pushed"]);
    const words = el.querySelector(".mc-full .mc-facts-list").textContent;
    expect(words).toContain("2 commits since it started, counting only commits that touch files it edited");
    expect(words).toContain("3 files changed (+10 -1)");
    expect(words).toContain("cargo test --lib");
    expect(words).toContain("Not pushed");
  });

  it("shows anything the daemon could not read as unknown, never a number", async () => {
    const el = await render(card("c2", T0 + MIN, { facts: facts({
      commits: null, files_changed: null, uncommitted: null, pushed: null,
      test: { state: "unknown" }, reviewer: { state: "none", note: "no reviewer ran" },
    }) }));
    const chips = [...el.querySelectorAll(".mc-full .mc-facts .mc-chip")].map((c) => c.textContent.trim());
    expect(chips).toEqual(["?", "?", "?", "unknown", "none"]);
    const words = el.querySelector(".mc-full .mc-facts-list").textContent;
    expect(words).toContain("Commits: unknown");
    expect(words).toContain("Uncommitted files: unknown");
    expect(words).toContain("Last test run: unknown");
    expect(words).toContain("No reviewer (no reviewer ran)");
  });

  it("a card with no stored facts says so instead of drawing none", async () => {
    const el = await render(card("c3", T0 + MIN, { facts: null }));
    expect(el.querySelector(".mc-full .mc-facts-list").textContent).toContain("unknown");
  });

  it("a failed test and an uncommitted file read as not-good chips", async () => {
    const el = await render(card("c4", T0 + MIN, { facts: facts({ uncommitted: 2, uncommitted_files: ["a.ts", "b.ts"], test: { state: "failed" } }) }));
    const tones = [...el.querySelectorAll(".mc-full .mc-facts .mc-chip")].map((c) => c.className.match(/mc-chip--(\w+)/)[1]);
    expect(tones.slice(2, 4)).toEqual(["not", "not"]);
    expect(el.querySelector(".mc-full .mc-facts-list").textContent).toContain("a.ts, b.ts");
  });

  it("the all-finished card states a count and is never green", async () => {
    const sum = { subs: 3, commits: 5, files_changed: 12, uncommitted: 0, unpushed: 1, tests_passed: 2, tests_failed: 0, tests_unknown: 1, reviewed: 1, unreviewed: 2, unknown_subs: 1 };
    const el = await render({ id: "all-1", ts: T0 + MIN, parent_id: "main", kind: "all_finished", verdict: "All 3 subs finished", text: "5 commits", sum, tone: null });
    expect(el.querySelector(".mc-full .mc-verdict").textContent).toBe("All 3 subs finished");
    expect(el.querySelector(".mc-full .mc-verdict .mc-t-good")).toBeNull();
    expect(el.querySelector(".mc-full .mc-sub-name")).toBeNull();
    const chips = [...el.querySelectorAll(".mc-full .mc-facts .mc-chip")].map((c) => c.textContent.trim());
    expect(chips[0]).toBe("5+");
    expect(el.querySelector(".mc-full .mc-facts-list").textContent).toContain("1 sub with figures the daemon could not read");
  });
});

describe("old sub cards shrink by their own rule", () => {
  function rows(...specs) {
    const messages = specs.map((s, i) => {
      if (s.user) return { kind: "user", content: [{ type: "text", text: "u" }], ts: i };
      if (s.main) return { kind: "message", text: "m", card: { kind: "report" }, ts: i };
      return { kind: "message", text: "s", card: { kind: "report" }, subCard: { id: `c${i}`, ts: i, parent_id: "m", kind: s.kind ?? "finish", sub_id: s.sub, verdict: "v", text: "t" }, ts: i };
    });
    const els = messages.map((m) => { const w = document.createElement("div"); w.innerHTML = renderMessage(m); return w.firstElementChild; });
    return { messages, els };
  }
  const flags = (els) => els.map((e) => e.classList.contains("is-old"));

  it("a newer card from the same sub makes the earlier one old, another sub's does not", () => {
    const { messages, els } = rows({ sub: "a" }, { sub: "b" }, { sub: "a" });
    sweepOldCards(messages, els, false);
    expect(flags(els)).toEqual([true, false, false]);
  });

  it("a main-chat turn that has spoken since makes a sub card old", () => {
    const { messages, els } = rows({ sub: "a" }, { user: true }, { main: true });
    sweepOldCards(messages, els, false);
    expect(flags(els)[0]).toBe(true);
  });

  it("a sub card at the end is still full size, and the all-finished card ages by a newer one", () => {
    const one = rows({ user: true }, { main: true }, { sub: "a" });
    sweepOldCards(one.messages, one.els, false);
    expect(flags(one.els)).toEqual([false, false, false]);
    const two = rows({ kind: "all_finished" }, { kind: "all_finished" });
    sweepOldCards(two.messages, two.els, false);
    expect(flags(two.els)).toEqual([true, false]);
  });

  it("a sub card does not age the main agent's own card", () => {
    const { messages, els } = rows({ user: true }, { main: true }, { sub: "a" }, { user: true });
    sweepOldCards(messages, els, false);
    // The last turn has not spoken yet, so the earlier main card is current.
    expect(flags(els)[1]).toBe(false);
  });
});

describe("the synthetic event", () => {
  it("is a tool_use of a name no real tool has, carrying the whole entry", () => {
    const e = subCardEvent(card("c1", T0));
    expect(e.type).toBe("tool_use");
    expect(e.tool_name).toBe(SUBCARD_TOOL);
    expect(e.input.sub_name).toBe("Header");
  });
});
