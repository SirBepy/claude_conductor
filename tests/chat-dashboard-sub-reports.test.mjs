// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts

// A sub's report (a job's finish, the all-finished card, when-done's note) is
// drawn on the main chat's dashboard in From subs. The main chat is told never
// to relay a sub's card, and before this zone the dashboard drew a job's finish
// nowhere but a 40-char verdict behind a click on the sub's avatar, so Joe saw
// none of his subs' results (2026-11-13).

import { describe, it, expect } from "vitest";

const { deriveDashboard, deriveReports, REPORTS_SHOWN } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { renderZone, initialUi } = await import("../src/views/sessions/chat-dashboard/dashboard-zones.ts");
const { subCardRow, SUBCARD_TOOL } = await import("../src/shared/chat/subchat-cards.ts");

const entry = (id, ts, over = {}) => ({
  id, ts, parent_id: "main", kind: "finish", sub_id: `sub-${id}`, sub_name: `job-${id}`, round: 1, model: "sonnet", effort: "high",
  verdict: `Verdict ${id}`, tone: "good", text: `Report text ${id}`, points: [], done: ["Built it"], not_done: [], waiting_on: [], your_move: [],
  facts: null, sum: null, set_key: null, ...over,
});
/** The row the renderer builds for a card merged into the transcript. */
const row = (e) => subCardRow({ tool_name: SUBCARD_TOOL, input: e });
const joe = (text, ts) => ({ kind: "user", content: [{ type: "text", text }], ts, parentToolUseId: null });

const derive = (input) => deriveReports({ input: { plans: [], ...input }, lastJoe: -1 });

describe("From subs", () => {
  it("draws a job's finish card that answers no question", () => {
    const state = derive({ messages: [joe("fix these", 1), row(entry("a", 2000))] });
    expect(state?.shown.map((m) => m.subCard.id)).toEqual(["a"]);
    const left = deriveDashboard({ messages: [joe("fix these", 1), row(entry("a", 2000))], plans: [] }).left.map((z) => z.id);
    expect(left).toContain("reports");
  });

  it("leaves out a finish that answers a question (the Answers card has it) and blockers (Waiting has them)", () => {
    const msgs = [row(entry("q", 2000, { question: "Why?" })), row(entry("b", 3000, { kind: "blocker" }))];
    expect(derive({ messages: msgs })).toBeNull();
  });

  it("keeps the all-finished card and when-done's note", () => {
    const msgs = [row(entry("all", 2000, { kind: "all_finished", sub_id: null })), row(entry("wd", 3000, { kind: "when_done" }))];
    expect(derive({ messages: msgs })?.shown.map((m) => m.subCard.id)).toEqual(["wd", "all"]);
  });

  it("reads cards from the renderer's pool that no loaded page holds", () => {
    // The dashboard hides the transcript, so an older page never loads: a card
    // older than the first page lives only in the pool.
    const state = derive({ messages: [joe("later", 9000)], subCards: [entry("old", 1000)] });
    expect(state?.shown.map((m) => m.subCard.id)).toEqual(["old"]);
  });

  it("keeps a row the transcript dropped out, though its card is still in the pool", () => {
    const e = entry("gone", 2000);
    expect(derive({ messages: [{ ...row(e), retracted: true }], subCards: [e] })).toBeNull();
  });

  it("does not draw a card twice when it is both a row and in the pool", () => {
    const e = entry("a", 2000);
    expect(derive({ messages: [row(e)], subCards: [e] })?.shown).toHaveLength(1);
  });

  it("shows the newest first and folds the rest", () => {
    const pool = [1, 2, 3, 4, 5].map((n) => entry(`c${n}`, n * 1000));
    const state = derive({ messages: [], subCards: pool });
    expect(state.shown.map((m) => m.subCard.id)).toEqual(["c5", "c4", "c3"].slice(0, REPORTS_SHOWN));
    expect(state.earlier.map((m) => m.subCard.id)).toEqual(["c2", "c1"]);
  });

  it("renders each report as the sub card Messages view draws, with the sub's name and text", () => {
    const pool = [1, 2, 3, 4].map((n) => entry(`c${n}`, n * 1000));
    const state = derive({ messages: [], subCards: pool });
    const ui = initialUi();
    const closed = renderZone("reports", state, { ui, busy: false });
    expect(closed).toContain("From subs");
    expect(closed).toContain('data-sub-card="1"');
    expect(closed).toContain("job-c4");
    expect(closed).toContain("Report text c4");
    expect(closed).not.toContain("Report text c1");
    expect(closed).toContain("1 earlier");
    const open = renderZone("reports", state, { ui: { ...ui, reportsOpen: true }, busy: false });
    expect(open).toContain("Report text c1");
  });
});
