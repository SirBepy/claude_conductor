// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/features-model.ts, src/views/sessions/chat-dashboard/features-html.ts, src/shared/chat/dashboard/dashboard-model.ts

// The merged Plan card's lines: a main chat's subs grouped into one line per feature, each drawn as
// a trail of one icon per chat, with the ids as icons and the name taking the room the trail leaves.

import { describe, it, expect } from "vitest";

const { buildFeatures, activeChatOf } = await import("../src/shared/chat/dashboard/features-model.ts");
const { featuresHtml, TRAIL_MAX } = await import("../src/views/sessions/chat-dashboard/features-html.ts");
const { deriveDashboard, MAIN_CHAT_ATTACHMENTS } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { renderPlan, initialPlanUi } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");

const at = (min) => new Date(Date.UTC(2026, 10, 23, 10, min)).toISOString();

const item = (id, name, kind, startMin, extra = {}) => ({
  id, name, kind, closing: false, model: "claude-sonnet-5-5", effort: "high", progress: kind === "working" ? "step 2 of 4" : kind,
  startedAt: startMin === null ? null : at(startMin), finishedAt: kind === "finished" ? Date.parse(at(59)) : null, ring: null, hover: null, ...extra,
});

const src = (it, extra = {}) => ({ item: it, todoId: null, title: it.name, ...extra });

describe("grouping subs into features", () => {
  it("puts the chats of one todo on one line, oldest first, the first chat naming it", () => {
    const state = buildFeatures([
      src(item("b", "pc-1804 review", "working", 20), { todoId: "pc-1804", title: "Review" }),
      src(item("a", "pc-1804 build", "finished", 5), { todoId: "pc-1804", title: "Build run lanes" }),
      src(item("c", "pc-1804 fix", "asking", 40), { todoId: "pc-1804", title: "Fix" }),
    ]);
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row.key).toBe("todo:pc-1804");
    expect(row.title).toBe("Build run lanes");
    expect(row.chats.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(row.chats.map((c) => c.state)).toEqual(["done", "working", "asking"]);
  });

  it("drops a feature whose every chat finished: the Done card has it", () => {
    expect(buildFeatures([src(item("a", "x", "finished", 1))])).toBeNull();
    // A finished chat beside a working one of the same job stays in that job's trail.
    const mixed = buildFeatures([src(item("a", "x", "finished", 1), { todoId: "pc-3" }), src(item("b", "y", "working", 2), { todoId: "pc-3" })]);
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.rows[0].chats.map((c) => c.state)).toEqual(["done", "working"]);
    // A finished chat alone on its line leaves the card.
    expect(buildFeatures([src(item("a", "x", "finished", 1)), src(item("b", "y", "working", 2))]).rows.map((r) => r.title)).toEqual(["y"]);
  });

  it("lists queued features first, then the rest by when they started", () => {
    const state = buildFeatures([
      src(item("w2", "later job", "working", 30)),
      src(item("q1", "waiting job", "queued", null)),
      src(item("w1", "earlier job", "working", 10)),
    ]);
    expect(state.rows.map((r) => r.chats[0].id)).toEqual(["q1", "w1", "w2"]);
    expect(state.rows[0].queued).toBe(true);
    expect(state.rows[0].startedAt).toBeNull();
  });

  it("reads a ticket id from a sub's name and groups on it", () => {
    const state = buildFeatures([
      src(item("a", "sc-56709 invite modal", "working", 1)),
      src(item("b", "review sc-56709", "working", 2)),
    ], (t) => (t.id === "sc-56709" ? "https://app.shortcut.com/acme/story/56709" : null));
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].ticket).toEqual({ id: "sc-56709", tracker: "shortcut", url: "https://app.shortcut.com/acme/story/56709" });
  });

  it("names a ticket feature without its id: the id is an icon under the name", () => {
    const state = buildFeatures([src(item("a", "sc-56709 invite modal", "working", 1), { title: "Sc 56709 Invite modal" })]);
    expect(state.rows[0].title).toBe("Invite modal");
    // A name that is only the id stays whole.
    expect(buildFeatures([src(item("b", "sc-56710", "working", 1), { title: "Sc 56710" })]).rows[0].title).toBe("Sc 56710");
  });

  it("shows the chat that needs Joe, else a working one, else a queued one", () => {
    const state = buildFeatures([
      src(item("a", "job one", "queued", null), { todoId: "pc-1", title: "Job" }),
      src(item("b", "job two", "working", 3), { todoId: "pc-1", title: "Job" }),
      src(item("c", "job three", "asking", 4), { todoId: "pc-1", title: "Job" }),
    ]);
    expect(activeChatOf(state.rows[0]).id).toBe("c");
    state.rows[0].chats = state.rows[0].chats.filter((c) => c.id !== "c");
    expect(activeChatOf(state.rows[0]).id).toBe("b");
  });

  it("takes the kind the daemon stored, else the one the name suggests", () => {
    const state = buildFeatures([
      src(item("a", "review the header", "working", 1), { storedKind: "gate", todoId: "pc-9", title: "T" }),
      src(item("b", "review the footer", "working", 2), { todoId: "pc-9", title: "T" }),
    ]);
    expect(state.rows[0].chats.map((c) => c.kind)).toEqual(["gate", "review"]);
  });
});

describe("the lines as markup", () => {
  const ctx = (over = {}) => ({ open: null, selOf: activeChatOf, pic: () => "", task: () => "", slot: (id) => `<div class="pf-slot" data-chat="${id}"></div>`, ...over });

  const feature = (n) => buildFeatures(Array.from({ length: n }, (_, i) => src(item(`c${i}`, `pc-77 chat ${i}`, i === n - 1 ? "working" : "finished", i + 1), { todoId: "pc-77", title: "Header work" }))).rows[0];

  it("draws one icon per chat, coloured by its state, each carrying the chat menu", () => {
    const html = featuresHtml({ rows: [feature(3)] }, ctx());
    expect(html.match(/class="pf-ti[ "]/g)).toHaveLength(3);
    expect(html).toContain('data-st="done"');
    expect(html).toContain('data-st="working"');
    expect(html.match(/data-chat-menu-id="c\d"/g)).toHaveLength(3);
    expect(html).not.toContain("pf-earlier");
  });

  it("folds the chats beyond the trail's room into one Earlier button", () => {
    const html = featuresHtml({ rows: [feature(TRAIL_MAX + 3)] }, ctx());
    expect(html.match(/class="pf-ti[ "]/g)).toHaveLength(TRAIL_MAX);
    expect(html).toContain('data-act="pf-earlier"');
    expect(html).toContain("3 earlier chats");
    // The newest chats stay; the oldest fold.
    expect(html).toContain(`data-chat="c${TRAIL_MAX + 2}"`);
    expect(html).not.toContain('data-chat="c0"');
  });

  it("shows the todo and the ticket as icons under the name, never as words", () => {
    const row = buildFeatures([src(item("a", "sc-5001 something", "working", 1), { todoId: "pc-77", title: "Something" })], () => "https://app.shortcut.com/acme/story/5001").rows[0];
    const html = featuresHtml({ rows: [row] }, ctx());
    expect(html).toContain('data-act="pf-todo"');
    expect(html).toContain("ph-check-square-offset");
    expect(html).toContain('<a class="pf-lk" href="https://app.shortcut.com/acme/story/5001"');
    expect(html).toContain("<svg");
    const box = document.createElement("div");
    box.innerHTML = html;
    // Only the name is words; the ids are icons whose id is a tooltip.
    expect(box.querySelector(".pf-rmain").textContent).toBe("Something");
    expect(html).not.toContain("ph-ticket");
  });

  it("keeps the ids inside a fold the line's open state unfolds (features-card.css), not drawn beside the name", () => {
    const row = buildFeatures([src(item("a", "sc-5001 something", "working", 1), { todoId: "pc-77", title: "Something" })], () => null).rows[0];
    const box = document.createElement("div");
    box.innerHTML = featuresHtml({ rows: [row] }, ctx());
    // The fold sits inside the line's row, whose aria-expanded the stylesheet reads.
    expect(box.querySelectorAll('.pf-row .pf-ids > .pf-ids-in > .pf-lk')).toHaveLength(2);
    expect(box.querySelector(".pf-row").getAttribute("aria-expanded")).toBe("false");
    box.innerHTML = featuresHtml({ rows: [row] }, ctx({ open: row.key }));
    expect(box.querySelector(".pf-row").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens one chat's plan under the line and leaves the others closed", () => {
    const row = feature(2);
    const closed = featuresHtml({ rows: [row] }, ctx());
    expect(closed).not.toContain("pf-body");
    expect(closed).toContain('aria-expanded="false"');
    const withSteps = { ...row, chats: row.chats.map((c) => ({ ...c, steps: [{ text: "Write the card", status: "done" }, { text: "Test it", status: "active" }] })) };
    const open = featuresHtml({ rows: [withSteps] }, ctx({ open: row.key }));
    expect(open).toContain("pf-body");
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Write the card");
    expect(open).toContain("ph-check-circle");
    expect(open).toContain('class="pf-slot"');
  });

  it("says what a queued chat waits on instead of drawing a plan", () => {
    const row = buildFeatures([src(item("q", "waits", "queued", null, { hover: { queue: { waitingFor: "Build", place: 1, behind: null } } }))]).rows[0];
    const html = featuresHtml({ rows: [row] }, ctx({ open: row.key, task: () => "Wire the card" }));
    expect(html).toContain("Waits for Build, next in line");
    expect(html).toContain("Wire the card");
    expect(html).toContain(">Queued<");
  });

  it("leaves the time column to the card's patcher and gives a started line its full date on hover", () => {
    const html = featuresHtml({ rows: [feature(2)] }, ctx());
    expect(html).toMatch(/class="pf-when" data-tip="Started \d+ Nov - \d+:\d\d(AM|PM)"/);
    expect(html).toContain('class="dn-at pf-ago" data-ms=');
  });
});

describe("what a main chat's dashboard draws", () => {
  const base = { messages: [], plans: [], busy: false, now: Date.parse(at(30)), sessionId: "main" };
  const subs = [item("s1", "pc-5 build", "working", 1), item("s2", "other thing", "queued", null)];
  const zones = (d) => [...d.left, ...d.right].map((z) => z.id);

  it("replaces the Subchats card with feature lines in the Plan card and hides Attachments", () => {
    const d = deriveDashboard({ ...base, subs, mainChat: true, images: [{ index: 0, title: "shot", label: "", size: 1 }] });
    const plan = d.right.find((z) => z.id === "plan").state;
    expect(plan.features.rows).toHaveLength(2);
    expect(zones(d)).not.toContain("subchats");
    expect(zones(d)).not.toContain("links");
    expect(MAIN_CHAT_ATTACHMENTS).toBe(false);
  });

  it("leaves a chat that is not a main chat as it was: Subchats card, Attachments, no lines", () => {
    const d = deriveDashboard({ ...base, subs, images: [{ index: 0, title: "shot", label: "", size: 1 }] });
    const plan = d.right.find((z) => z.id === "plan").state;
    expect(plan.features).toBeNull();
    expect(zones(d)).toContain("subchats");
    expect(zones(d)).toContain("links");
  });
});

describe("a main chat with no chat in progress", () => {
  const base = { messages: [], plans: [], busy: false, now: Date.parse(at(30)), sessionId: "main", mainChat: true, doneLines: true };
  const planOf = (d) => d.right.find((z) => z.id === "plan").state;
  const draw = (s) => { const el = document.createElement("div"); el.innerHTML = renderPlan(s, { ui: initialPlanUi(), busy: false, idleAt: null, card: () => "" }); return el; };

  it("still draws the merged Plan card, with an empty list, when every sub finished", () => {
    const d = deriveDashboard({ ...base, subs: [item("a", "pc-5 build", "finished", 1)] });
    expect(planOf(d).features).toEqual({ rows: [] });
    expect(d.right.find((z) => z.id === "done").state.lines).toHaveLength(1);
  });

  it("still draws it with no sub at all, and never the old Subchats or Attachments cards", () => {
    const d = deriveDashboard({ ...base, subs: [], images: [{ index: 0, title: "shot", label: "", size: 1 }] });
    expect(planOf(d).features).toEqual({ rows: [] });
    expect([...d.left, ...d.right].map((z) => z.id)).not.toContain("subchats");
    expect([...d.left, ...d.right].map((z) => z.id)).not.toContain("links");
  });

  it("labels the card Plan, keeps its merged shape, and draws a line host only when there are lines", () => {
    const empty = draw(planOf(deriveDashboard({ ...base, subs: [] })));
    expect(empty.querySelector(".cdash-plan.is-features")).not.toBeNull();
    expect(empty.querySelector(".cdash-h-t").textContent).toBe("Plan");
    expect(empty.querySelector(".pf-host")).toBeNull();
    expect(empty.querySelector(".cdash-pnone").textContent).toBe("No chats in progress.");
    const full = draw(planOf(deriveDashboard({ ...base, subs: [item("a", "going", "working", 1)] })));
    expect(full.querySelector(".pf-host")).not.toBeNull();
    expect(full.querySelector(".cdash-pnone")).toBeNull();
  });

  it("draws only the header and the lines: no history, steps, summary, result or resting foot", () => {
    const msgs = [
      { kind: "assistant", role: "assistant", text: "Review started: a read-only sub is listing everything.", ts: 5 },
    ];
    const plans = [
      { steps: [{ label: "Inventory", status: "done" }, { label: "Capture rounds", status: "active" }], at: 0, lastAt: 1, startedAt: 1, id: "p1" },
      { steps: [{ label: "Older step", status: "done" }], at: 0, lastAt: 1, startedAt: 0, id: "p0" },
    ];
    const state = planOf(deriveDashboard({ ...base, messages: msgs, plans, subs: [item("a", "going", "working", 1)] }));
    // The data is still derived: the plan, its history and the status are there for other readers.
    expect(state.job).not.toBeNull();
    expect(state.earlier.length).toBeGreaterThan(0);
    const card = draw(state);
    expect(card.querySelector(".cdash-pnav")).toBeNull();
    expect(card.querySelector(".cdash-steps, .cdash-step")).toBeNull();
    expect(card.querySelector(".cdash-plan-lead, .cdash-plan-body, .cdash-result, .cdash-rsum")).toBeNull();
    expect(card.querySelector(".cdash-status, .cdash-pstatus")).toBeNull();
    expect(card.textContent).not.toContain("Capture rounds");
    expect(card.querySelector(".pf-host")).not.toBeNull();
  });
});
