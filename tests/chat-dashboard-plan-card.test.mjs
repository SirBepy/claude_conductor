// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/session-thinking-bar.ts

// The Plan card across a chat's life (docs/chat-dashboard-design.md): it never
// vanishes, the finished job stays as the last job, a new plan pushes the old
// one into a pager whose middle button swaps the card for the list, and the
// foot is the way back while an earlier plan shows. In the dashboard the
// status line says what Claude is doing, not which step it is on.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { spanText } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");
const { initThinkingBar, syncThinkingBar, thinkingBarHtml, updateThinkingBar } = await import("../src/views/sessions/session-thinking-bar.ts");
const { state } = await import("../src/views/sessions/state.ts");

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });
const send = (input) => { const id = `m${++seq}`; return [toolUseEvent(SEND, input, id), ok(id)]; };
const plan = (steps) => { const id = `p${++seq}`; return [toolUseEvent(PLAN, { steps }, id), ok(id)]; };
const status = (s) => { const id = `s${++seq}`; return [toolUseEvent(STATUS, { status: s }, id), ok(id)]; };
const tick = () => new Promise((res) => setTimeout(res, 5));

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
});

function mount() {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  const dash = new ChatDashboard(pane, r);
  const feed = (events) => { for (const ev of events) r.handleEvent(ev); };
  return { pane, r, dash, feed };
}

/** A job: Joe asks, Claude plans, finishes every step, reports, closes the turn. */
const job = (ask, steps, verdict) => [
  userEvent(ask),
  ...plan(steps.map((text) => ({ text, status: "done" }))),
  ...send({ kind: "report", verdict, text: "ok" }),
  ...status("done"),
];

const card = (pane) => pane.querySelector(".cdash-right .cdash-plan");
const title = (pane) => card(pane).querySelector(".cdash-h-t").textContent;
const click = (pane, sel) => { card(pane).querySelector(sel).click(); };

describe("the Plan card across a chat's life", () => {
  it("keeps the finished job, dimmed, as the last job when Joe writes with no new plan", async () => {
    const { pane, feed } = mount();
    feed(job("sync trello", ["Read", "Add source"], "Built, not pushed"));
    await tick();
    expect(title(pane)).toBe("Result");
    feed([userEvent("does it skip archived cards?"), ...send({ kind: "answer", verdict: "Yes", text: "It does." }), ...status("done")]);
    await tick();
    expect(card(pane).classList.contains("is-last")).toBe(true);
    expect(title(pane)).toMatch(/^Last job/);
    expect(card(pane).querySelector(".cdash-dim .cdash-result .mc-verdict").textContent).toBe("Built, not pushed");
    expect(card(pane).querySelectorAll(".cdash-step")).toHaveLength(2);
    // One job only: no pager.
    expect(card(pane).querySelector(".cdash-pnav")).toBeNull();
  });

  it("puts a new plan on the card with the older one a step back, and the foot leads back", async () => {
    const { pane, feed } = mount();
    feed([...job("sync trello", ["Read"], "Built"), userEvent("show due dates"), ...plan([{ text: "Chip", status: "active" }])]);
    await tick();
    expect(title(pane)).toBe("Plan");
    // On the current plan the middle says how many earlier plans there are.
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("1");
    expect(card(pane).querySelector("[data-act='plan-next']").hidden).toBe(true);
    click(pane, "[data-act='plan-prev']");
    expect(card(pane).classList.contains("is-earlier")).toBe(true);
    expect(card(pane).querySelector(".cdash-result .mc-verdict").textContent).toBe("Built");
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("1 / 2");
    expect(card(pane).querySelector("[data-act='plan-prev']").disabled).toBe(true);
    // The foot is the way back to the current plan.
    const foot = card(pane).querySelector(".cdash-status.is-away");
    expect(foot).not.toBeNull();
    foot.click();
    expect(title(pane)).toBe("Plan");
    expect(card(pane).querySelector(".cdash-status.is-away")).toBeNull();
  });

  it("swaps the card for the list and back to what was open, by the middle button or Esc", async () => {
    const { pane, feed } = mount();
    feed([...job("one", ["A"], "First"), ...job("two", ["B"], "Second"), userEvent("three"), ...plan([{ text: "C", status: "active" }])]);
    await tick();
    click(pane, "[data-act='plan-prev']");
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("2 / 3");
    click(pane, "[data-act='plan-list']");
    expect(card(pane).classList.contains("is-list")).toBe(true);
    // Newest first; no way-back foot in the list.
    expect([...card(pane).querySelectorAll(".cdash-pl-t")].map((e) => e.textContent)).toEqual(["two", "one"]);
    expect(card(pane).querySelector(".cdash-status").hidden).toBe(true);
    // Closing goes back to the plan it was opened over.
    click(pane, "[data-act='plan-list']");
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("2 / 3");
    click(pane, "[data-act='plan-list']");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("2 / 3");
    // A row opens that plan.
    click(pane, "[data-act='plan-list']");
    card(pane).querySelectorAll(".cdash-pl-row")[1].click();
    expect(card(pane).querySelector(".cdash-pnav-mid").textContent).toBe("1 / 3");
    expect(card(pane).querySelector(".cdash-result .mc-verdict").textContent).toBe("First");
    click(pane, "[data-act='plan-next']");
    click(pane, "[data-act='plan-next']");
    expect(title(pane)).toBe("Plan");
  });

  it("leaves Esc pressed in the message box to the message box", async () => {
    const { pane, feed } = mount();
    feed([...job("one", ["A"], "First"), userEvent("two"), ...plan([{ text: "B", status: "active" }])]);
    await tick();
    click(pane, "[data-act='plan-list']");
    const box = document.createElement("textarea");
    pane.querySelector(".session-composer").appendChild(box);
    box.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card(pane).classList.contains("is-list")).toBe(true);
  });

  it("keeps a running turn's status line on screen while the list hides the foot", async () => {
    const { pane, feed } = mount();
    const bar = pane.querySelector(".session-thinking");
    feed([...job("one", ["A"], "First"), userEvent("two"), ...plan([{ text: "B", status: "active" }])]);
    bar.removeAttribute("hidden");
    await tick();
    expect(bar.parentElement.dataset.slot).toBe("status");
    click(pane, "[data-act='plan-list']");
    await tick();
    // The foot is hidden in the list, so the line waits above the message box.
    expect(bar.parentElement.classList.contains("composer-shell")).toBe(true);
    click(pane, "[data-act='plan-list']");
    await tick();
    expect(bar.parentElement.dataset.slot).toBe("status");
  });

  it("gives a long list a search box that filters as Joe types", async () => {
    const { pane, feed } = mount();
    const events = [];
    for (let i = 1; i <= 8; i++) events.push(...job(`job ${i}${i === 3 ? " trello" : ""}`, [`S${i}`], `V${i}`));
    feed([...events, userEvent("now"), ...plan([{ text: "Z", status: "active" }])]);
    await tick();
    click(pane, "[data-act='plan-list']");
    const input = card(pane).querySelector(".cdash-pl-search input");
    expect(input).not.toBeNull();
    input.value = "trello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const shown = [...card(pane).querySelectorAll(".cdash-pl-row")].filter((r) => !r.hidden);
    expect(shown.map((r) => r.querySelector(".cdash-pl-t").textContent)).toEqual(["job 3 trello"]);
  });

  it("says the chat waits on Joe's answer while a question card is open", async () => {
    const { pane, feed } = mount();
    feed([userEvent("go"), toolUseEvent("mcp__cc_conductor__ask_user_question", { questions: [{ question: "Tabs?", options: [{ label: "Tabs" }] }] }, "q1"), ok("q1")]);
    await tick();
    expect(card(pane).querySelector(".cdash-pstatus.is-wait").textContent).toMatch(/^Waiting on your answer/);
  });

  it("reads a step's length in seconds, minutes, then hours", () => {
    expect(spanText(40_000)).toBe("40s");
    expect(spanText(120_000)).toBe("2 min");
    expect(spanText(65 * 60_000)).toBe("1 h 5 min");
    expect(spanText(120 * 60_000)).toBe("2 h");
  });
});

describe("the status line inside the dashboard", () => {
  let pane;
  let r;

  beforeEach(() => {
    state.pendingNewSession = null;
    state.heldMessages = null;
    state.selectedId = "chat-a";
    state.sessions = [{ session_id: "chat-a", busy: true }];
    ({ pane, r } = mount());
    pane.setAttribute("data-chat-view", "dashboard");
    initThinkingBar(pane);
    syncThinkingBar(r);
  });

  afterEach(() => {
    state.sessions = [];
    updateThinkingBar();
    initThinkingBar(null);
  });

  const text = () => pane.querySelector(".thinking-text").textContent;

  it("says what Claude is doing, with the tool's icon, even when a plan step is active", () => {
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "Draw the switch", status: "active" }] }, "p1"));
    r.handleEvent(toolUseEvent("Edit", { file_path: "C:/a/settings.ts", old_string: "a", new_string: "b" }, "e1"));
    syncThinkingBar(r);
    expect(text()).toBe(r.lastActivity);
    expect(text()).not.toBe("Draw the switch");
    const icon = pane.querySelector(".thinking-icon");
    expect(icon.hidden).toBe(false);
    expect(icon.classList.contains("ph-pencil-simple")).toBe(true);
  });

  it("keeps the plan step on the line outside the dashboard", () => {
    pane.removeAttribute("data-chat-view");
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "Draw the switch", status: "active" }] }, "p1"));
    syncThinkingBar(r);
    expect(text()).toBe("Draw the switch");
    expect(pane.querySelector(".thinking-icon").hidden).toBe(true);
  });

  it("opens on click to the turn's counts and the calls before the current one", () => {
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent("Read", { file_path: "C:/a/one.ts" }, "t1"));
    r.handleEvent(toolUseEvent("Grep", { pattern: "derivePlan" }, "t2"));
    r.handleEvent(toolUseEvent("Read", { file_path: "C:/a/two.ts" }, "t3"));
    syncThinkingBar(r);
    const bar = pane.querySelector(".session-thinking");
    bar.classList.add("is-open");
    updateThinkingBar();
    const detail = bar.querySelector(".thinking-detail");
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector(".thinking-counts").textContent).toBe("This turn: 2 read · 1 search");
    const rows = [...detail.querySelectorAll(".thinking-trail-row span")].map((e) => e.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("derivePlan");
    expect(rows[1]).toContain("one.ts");
  });
});
