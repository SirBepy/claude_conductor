// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/question-reopen.ts
//
// The dashboard draws no question card (Joe, 2026-11-26): a question is the floating card by the
// message box, and one Joe missed is a line of the Plan card. The line is the feature line's own
// markup, names the chat that asks, and a click or Enter brings the answerable card back.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { reopenMock } = vi.hoisted(() => ({ reopenMock: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/question-reopen.ts", () => ({ reopenQuestionCard: reopenMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { renderPlan, initialPlanUi } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");
const { thinkingBarHtml } = await import("../src/views/sessions/session-thinking-bar.ts");

const ASK = "mcp__cc_conductor__ask_user_question";
const ask = (q, id) => toolUseEvent(ASK, { questions: [{ question: q, options: [{ label: "A" }] }] }, id);
const tick = () => new Promise((res) => setTimeout(res, 20));

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
  setSettings({});
  reopenMock.mockClear();
});

function mount() {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell">${thinkingBarHtml()}<div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  const dash = new ChatDashboard(pane, r);
  return { pane, r, dash, feed: (evs) => { for (const ev of evs) r.handleEvent(ev); } };
}

describe("a missed question as a Plan card line", () => {
  it("draws a line on the Plan card and no question card anywhere on the dashboard", async () => {
    const { pane, feed } = mount();
    feed([userEvent("go"), ask("Tabs or spaces?", "q1")]);
    await tick();
    const line = pane.querySelector(".cdash-plan .pq-host .pf-row");
    expect(line.dataset.act).toBe("pq-open");
    expect(line.querySelector(".pf-title").textContent).toBe("Tabs or spaces?");
    expect(line.querySelector(".pf-ago")).not.toBeNull();
    expect(pane.querySelector(".cdash .question-card")).toBeNull();
    expect(pane.querySelector(".cdash-waiting")).toBeNull();
  });

  it("goes once the question is answered", async () => {
    const { pane, feed } = mount();
    feed([userEvent("go"), ask("Tabs or spaces?", "q1")]);
    await tick();
    expect(pane.querySelector(".pq-host")).not.toBeNull();
    feed([userEvent('<auq-answer id="q1"/>User answered the question(s):\nQ: Tabs or spaces?\nA: A')]);
    await tick();
    expect(pane.querySelector(".pq-host")).toBeNull();
  });

  it("a click and Enter reopen that question's card", async () => {
    const { pane, r, feed } = mount();
    r.sessionId = "s-line";
    feed([userEvent("go"), ask("Tabs or spaces?", "q1")]);
    await tick();
    pane.querySelector(".pq-host .pf-row").click();
    expect(reopenMock).toHaveBeenCalledWith("s-line", "q1");
    pane.querySelector(".pq-host .pf-row").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(reopenMock).toHaveBeenCalledTimes(2);
  });
});

describe("renderPlan question lines", () => {
  const base = { mode: "empty", job: null, earlier: [], status: { kind: "idle", since: null }, steps: [], done: 0, lead: null, result: null, resultSummary: null, run: null, features: null };
  const ctx = { ui: initialPlanUi(), busy: false, idleAt: null, card: () => "", chat: { id: "c1", name: "Fix login" } };

  it("names the asking chat, carries its chat menu, and is drawn on a main chat's feature card too", () => {
    const questions = [{ id: "q9", title: "Which one?", at: 1_700_000_000_000 }];
    for (const s of [{ ...base, questions }, { ...base, features: { rows: [] }, questions }]) {
      const el = document.createElement("div");
      el.innerHTML = renderPlan(s, ctx);
      const ti = el.querySelector(".pq-host .pq-ti");
      expect(ti.getAttribute("aria-label")).toBe("Fix login is asking");
      expect(ti.dataset.chatMenuId).toBe("c1");
      expect(el.querySelector(".pq-host .pf-row").dataset.feat).toBe("q:q9");
    }
  });

  it("draws no host with nothing missed", () => {
    expect(renderPlan({ ...base, questions: [] }, ctx)).not.toContain("pq-host");
  });
});
