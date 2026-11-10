// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-view-pref.ts

// The dashboard is drawn beside the transcript from the renderer's own rows:
// Joe's strip on top, Answers and Waiting on the left, Plan (with the Result
// once the job ends) on the right, the chat's status line moved into the Plan
// card while it runs, and nothing at all added to the pane in Messages view.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard, attachChatDashboard, applyChatViewSetting, detachChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { dashboardEnabled, readChatView } = await import("../src/views/sessions/chat-dashboard/chat-view-pref.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");
const { state } = await import("../src/views/sessions/state.ts");

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const STATUS = "mcp__cc_conductor__report_turn_status";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
});

function mountPane() {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  return { pane, r };
}

function feed(r, events) {
  for (const ev of events) r.handleEvent(ev);
}
const send = (input) => { const id = `m${++seq}`; return [toolUseEvent(SEND, input, id), ok(id)]; };
const plan = (steps) => { const id = `p${++seq}`; return [toolUseEvent(PLAN, { steps }, id), ok(id)]; };
const status = (s) => { const id = `s${++seq}`; return [toolUseEvent(STATUS, { status: s }, id), ok(id)]; };

/** Lets the dashboard's coalesced derive run. */
const tick = () => new Promise((res) => setTimeout(res, 5));

describe("chat view setting", () => {
  it("defaults to the dashboard and keeps Messages on the phone", () => {
    expect(readChatView({})).toBe("dashboard");
    expect(readChatView({ chatView: "bogus" })).toBe("dashboard");
    expect(readChatView({ chatView: "messages" })).toBe("messages");
    expect(dashboardEnabled(false, {})).toBe(true);
    expect(dashboardEnabled(true, {})).toBe(false);
    expect(dashboardEnabled(false, { chatView: "messages" })).toBe(false);
  });

  it("adds nothing to the pane in Messages view", () => {
    globalThis.window.__TAURI__ = {};
    setSettings({ chatView: "messages" });
    const { pane, r } = mountPane();
    feed(r, [userEvent("hi"), ...send({ kind: "answer", verdict: "Yes", text: "ok" })]);
    const before = pane.innerHTML;
    expect(attachChatDashboard(pane, r)).toBeNull();
    expect(pane.innerHTML).toBe(before);
    expect(pane.hasAttribute("data-chat-view")).toBe(false);
  });

  it("keeps Messages for a read-only external or automated session, which has no cards to show", () => {
    globalThis.window.__TAURI__ = {};
    const { pane, r } = mountPane();
    expect(attachChatDashboard(pane, r, { transcriptOnly: true })).toBeNull();
    expect(pane.querySelector(".cdash")).toBeNull();
    applyChatViewSetting();
    expect(pane.querySelector(".cdash")).toBeNull();
  });

  it("goes away with the pane when no chat is open", () => {
    globalThis.window.__TAURI__ = {};
    const { pane, r } = mountPane();
    const bar = pane.querySelector(".session-thinking");
    attachChatDashboard(pane, r);
    detachChatDashboard();
    expect(pane.querySelector(".cdash")).toBeNull();
    expect(r.onFlushed).toBeNull();
    expect(bar.parentElement.classList.contains("composer-shell")).toBe(true);
    applyChatViewSetting();
    expect(pane.querySelector(".cdash")).toBeNull();
  });

  it("switches an open chat between the views in place", async () => {
    globalThis.window.__TAURI__ = {};
    const { pane, r } = mountPane();
    attachChatDashboard(pane, r);
    expect(pane.querySelector(".cdash")).not.toBeNull();
    expect(pane.getAttribute("data-chat-view")).toBe("dashboard");
    setSettings({ chatView: "messages" });
    applyChatViewSetting();
    expect(pane.querySelector(".cdash")).toBeNull();
    expect(pane.hasAttribute("data-chat-view")).toBe(false);
    setSettings({ chatView: "dashboard" });
    applyChatViewSetting();
    expect(pane.querySelector(".cdash")).not.toBeNull();
  });
});

describe("chat dashboard layout", () => {
  it("draws the strip, Answers on the left and the Plan on the right from the chat's events", async () => {
    const { pane, r } = mountPane();
    const dash = new ChatDashboard(pane, r);
    feed(r, [
      userEvent("we should support trello"),
      userEvent("does it link tr- numbers?"),
      ...send({ kind: "answer", verdict: "Yes", text: "Once the board confirms." }),
      ...plan([{ text: "Read the tracker", status: "done", detail: "How Shortcut reads ids" }, { text: "Add Trello", status: "active" }]),
    ]);
    await tick();
    // The dashboard sits before the transcript, which keeps rendering underneath.
    expect(pane.firstElementChild).toBe(dash.el);
    expect(pane.querySelector(".session-messages .mc-root")).not.toBeNull();

    const strip = pane.querySelector(".cdash-strip");
    expect(strip.hidden).toBe(false);
    expect(strip.querySelector(".cdash-strip-msg").textContent).toContain("does it link tr- numbers?");
    expect(strip.querySelector("[data-act='strip-earlier']").textContent).toContain("1 earlier");

    const left = pane.querySelector(".cdash-left");
    const right = pane.querySelector(".cdash-right");
    expect([...left.querySelectorAll(".cdash-slot")].map((e) => e.dataset.zone)).toEqual(["answers"]);
    expect(left.querySelector(".mc-root .mc-verdict").textContent).toBe("Yes");
    // A chat with a plan is a job, so it also gets Links and files for its quick-view buttons.
    expect([...right.querySelectorAll(".cdash-slot")].map((e) => e.dataset.zone)).toEqual(["plan", "links"]);
    expect([...right.querySelectorAll(".cdash-step-l")].map((e) => e.textContent)).toEqual(["Read the tracker", "Add Trello"]);
    // The steps say where the plan is; the header carries no N/M count.
    expect(right.querySelector(".cdash-plan .cdash-h").textContent).toBe("Plan");
  });

  it("opens a step on click: its detail line, when it ran on a line of its own, how long on its row", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    const T0 = new Date(2026, 10, 10, 14, 43).getTime();
    r.handleEvent(userEvent("go"));
    r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "Read", status: "active", detail: "Reads the tracker code" }, { text: "Ship", status: "pending" }] }, "pa", T0));
    r.handleEvent(toolUseEvent(PLAN, { steps: [{ text: "Read", status: "done", detail: "Reads the tracker code" }, { text: "Ship", status: "active" }] }, "pb", T0 + 120_000));
    await tick();
    expect(pane.querySelector(".cdash-step-d")).toBeNull();
    expect(pane.querySelector(".cdash-step-t")).toBeNull();
    // Both steps ran, so both open; a pending step with no detail would not.
    expect(pane.querySelectorAll("button.cdash-step")).toHaveLength(2);
    pane.querySelector("button.cdash-step").click();
    expect(pane.querySelector(".cdash-step-d").textContent).toBe("Reads the tracker code");
    expect(pane.querySelector(".cdash-step-t").textContent).toMatch(/^\d.*:43.* to .*:45/);
    expect(pane.querySelector(".cdash-step-len").textContent).toBe("2 min");
    pane.querySelectorAll("button.cdash-step")[1].click();
    expect(pane.querySelector(".cdash-step-len").textContent).toBe("running");
    expect(pane.querySelector(".cdash-step-t").textContent).toMatch(/ to now$/);
    pane.querySelectorAll("button.cdash-step")[1].click();
    expect(pane.querySelector(".cdash-step-t")).toBeNull();
  });

  it("expands Joe's latest message on click and shows an earlier one picked from the list", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("first message"), userEvent("second message")]);
    await tick();
    const msg = () => pane.querySelector(".cdash-strip-msg");
    msg().click();
    expect(msg().classList.contains("open")).toBe(true);
    pane.querySelector("[data-act='strip-earlier']").click();
    const rows = [...pane.querySelectorAll(".cdash-pop-row")];
    expect(rows.map((b) => b.textContent)).toEqual(["second message", "first message"]);
    rows[1].click();
    expect(pane.querySelector(".cdash-pop")).toBeNull();
    expect(msg().textContent).toContain("first message");
    pane.querySelector("[data-act='strip-latest']").click();
    expect(msg().textContent).toContain("second message");
  });

  it("opens the chat-wide gallery, not the bare lightbox, for an image inside a dashboard card", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    const DATA = "iVBORw0KGgo=";
    feed(r, [{ type: "user_message", content: [{ type: "text", text: "look" }, { type: "image", mime: "image/png", data: DATA }], timestamp: 0 }]);
    await tick();
    // The card's own copy of the image: a different element from the transcript's,
    // so element identity cannot find its gallery slot.
    const img = document.createElement("img");
    img.className = "block image";
    img.src = `data:image/png;base64,${DATA}`;
    pane.querySelector(".cdash-body").appendChild(img);
    const errors = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
    img.click();
    spy.mockRestore();
    expect(document.querySelector(".chat-image-gallery-overlay")).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it("puts the Result under the finished plan's steps, in the Plan card", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("go"), ...status("done"), userEvent("build it"),
      ...plan([{ text: "Build", status: "done" }, { text: "Test", status: "done" }]),
      ...send({ kind: "report", verdict: "Built, not pushed", text: "Two commits", your_move: ["Push it"], visuals: [{ type: "table", columns: ["A"], rows: [["1"]] }] }),
      ...status("done"),
    ]);
    await tick();
    const right = pane.querySelector(".cdash-right");
    expect(right.querySelector(".cdash-result .mc-verdict").textContent).toBe("Built, not pushed");
    expect(right.querySelector(".cdash-result .mc-sec--yours").textContent).toContain("Push it");
    expect(right.querySelector(".cdash-result table")).not.toBeNull();
    // The steps stay open above the Result, with no way to fold them away.
    const card = right.querySelector(".cdash-plan.is-result");
    expect(card.querySelector(".cdash-h").textContent).toBe("Result");
    expect(card.querySelectorAll(".cdash-step--done")).toHaveLength(2);
    expect(card.querySelector("[data-act='show-plan']")).toBeNull();
    // The report is the Result, never an answer: Answers stays empty.
    expect([...pane.querySelectorAll(".cdash-left .cdash-slot")].map((e) => e.dataset.zone)).toEqual(["answers"]);
  });

  it("lists a blocker, tinted red, and the open question card in Waiting on you", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("go"),
      toolUseEvent("mcp__cc_conductor__ask_user_question", { questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }] }] }, "q1"),
      ok("q1"),
      ...send({ kind: "blocker", verdict: "Stuck on auth", text: "No token" }),
    ]);
    await tick();
    const w = pane.querySelector(".cdash-waiting");
    expect(w.classList.contains("is-blocked")).toBe(true);
    const stack = [...w.querySelector(".cdash-stack").children];
    expect(stack[0].querySelector(".mc-verdict").textContent).toBe("Stuck on auth");
    const q = w.querySelector(".msg.question-card");
    expect(q.dataset.questionId).toBe("q1");
    expect(q.textContent).toContain("Tabs or spaces?");
  });

  it("moves the chat's status line into the Plan card while it runs, and back when the card goes", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    const bar = pane.querySelector(".session-thinking");
    const home = bar.parentElement;
    await tick();
    expect(bar.parentElement).toBe(home);
    // A turn starts: the bar shows itself, and the Plan card draws to host it.
    bar.removeAttribute("hidden");
    await tick();
    const slot = pane.querySelector(".cdash-plan [data-slot='status']");
    expect(slot).not.toBeNull();
    expect(bar.parentElement).toBe(slot);
    // New plan steps redraw the card; the bar survives the redraw.
    feed(r, [userEvent("go"), ...plan([{ text: "One", status: "active" }])]);
    await tick();
    expect(pane.querySelector(".cdash-plan [data-slot='status'] .session-thinking")).toBe(bar);
    bar.setAttribute("hidden", "");
    await tick();
    // The turn it saw end is when the chat went idle.
    expect(pane.querySelector(".cdash-pstatus").textContent).toMatch(/^Idle since \d/);
    // Hidden, it goes home, so session-thinking-bar.ts shows it above the message box for held messages.
    expect(bar.parentElement).toBe(home);
  });

  it("puts the status line back above the message box when disposed", async () => {
    const { pane, r } = mountPane();
    const dash = new ChatDashboard(pane, r);
    const bar = pane.querySelector(".session-thinking");
    bar.removeAttribute("hidden");
    await tick();
    expect(bar.closest(".cdash")).not.toBeNull();
    dash.dispose();
    expect(bar.parentElement.classList.contains("composer-shell")).toBe(true);
    expect(bar.nextElementSibling.classList.contains("session-composer")).toBe(true);
    expect(pane.querySelector(".cdash")).toBeNull();
    expect(r.onFlushed).toBeNull();
  });

  it("keeps Answers and Plan on screen from the very start, empty", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    await tick();
    expect([...pane.querySelectorAll(".cdash-left .cdash-slot")].map((e) => e.dataset.zone)).toEqual(["answers"]);
    expect([...pane.querySelectorAll(".cdash-right .cdash-slot")].map((e) => e.dataset.zone)).toEqual(["plan"]);
    expect(pane.querySelector(".cdash-plan .cdash-pnone").textContent).toBe("Nothing planned yet.");
    expect(pane.querySelector(".cdash-pstatus").textContent).toBe("Idle");
    expect(pane.querySelector(".cdash-strip").hidden).toBe(true);
  });

  it("draws nothing while a history replay is half built", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    r.hydrating = true;
    feed(r, [userEvent("go"), ...send({ kind: "blocker", verdict: "Stuck", text: "x" })]);
    await tick();
    expect(pane.querySelector(".cdash-waiting")).toBeNull();
    r.hydrating = false;
    r.onFlushed();
    await tick();
    expect(pane.querySelector(".cdash-waiting")).not.toBeNull();
  });

  it("draws a finished history replay once it has loaded, with no later event to trigger it", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    await r.loadHistory([userEvent("go"), ...send({ kind: "blocker", verdict: "Stuck", text: "x" })]);
    await tick();
    expect(r.hydrating).toBe(false);
    expect(pane.querySelector(".cdash-waiting")).not.toBeNull();
  });

  it("keeps the status line above the message box while messages are held", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    const bar = pane.querySelector(".session-thinking");
    const prevHeld = state.heldMessages;
    state.heldMessages = { hasItemsForActive: () => true };
    try {
      bar.removeAttribute("hidden");
      await tick();
      expect(bar.parentElement.classList.contains("composer-shell")).toBe(true);
      state.heldMessages = { hasItemsForActive: () => false };
      bar.classList.add("busy");
      await tick();
      expect(bar.parentElement.dataset.slot).toBe("status");
    } finally {
      state.heldMessages = prevHeld;
    }
  });

  it("measures long user messages again once a hidden transcript is shown", async () => {
    globalThis.window.__TAURI__ = {};
    const { pane, r } = mountPane();
    attachChatDashboard(pane, r);
    feed(r, [userEvent("a very long message")]);
    const row = pane.querySelector(".session-messages .msg.user");
    // Built hidden: measured 0, so it was checked and left unclamped.
    expect(row.dataset.clampChecked).toBe("1");
    expect(row.classList.contains("has-clamp")).toBe(false);
    Object.defineProperty(row, "scrollHeight", { configurable: true, get: () => 900 });
    setSettings({ chatView: "messages" });
    applyChatViewSetting();
    expect(row.classList.contains("has-clamp")).toBe(true);
    expect(row.querySelector(".msg-clamp-toggle").textContent).toBe("Show more");
  });
});
