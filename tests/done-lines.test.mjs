// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/done-model.ts, src/shared/chat/dashboard/features-model.ts, src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/done-lines-html.ts, src/views/sessions/chat-dashboard/done-lines-card.ts, src/views/sessions/chat-dashboard/done-lines-open.ts, src/views/sessions/chat-dashboard/done-lines-popup.ts

// The Done card of a main chat: the features whose every chat finished (the Plan card's own rows),
// the newest few inline, the rest of the last day in a popup under a divider per release.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { buildFeatures, buildDoneFeatures } = await import("../src/shared/chat/dashboard/features-model.ts");
const { DONE_INLINE, DONE_MIN, doneWindow, releaseOf, groupByRelease, doneMatches, UNRELEASED, EARLIER } = await import("../src/shared/chat/dashboard/done-model.ts");
const { deriveDashboard } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { doneLineHtml, doneHeadHtml, releaseDividerHtml } = await import("../src/views/sessions/chat-dashboard/done-lines-html.ts");
const { nextOpen, soleChat } = await import("../src/views/sessions/chat-dashboard/done-lines-open.ts");
const { DoneLinesCard } = await import("../src/views/sessions/chat-dashboard/done-lines-card.ts");

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 23, 12, 0);
const at = (min) => new Date(Date.UTC(2026, 10, 23, 10, min)).toISOString();

const item = (id, name, kind, startMin, endMs = null, extra = {}) => ({
  id, name, kind, closing: false, model: "claude-sonnet-5-5", effort: "high", progress: kind,
  startedAt: at(startMin), finishedAt: kind === "finished" ? endMs : null, ring: null, hover: null, ...extra,
});
const src = (it, extra = {}) => ({ item: it, todoId: null, title: it.name, ...extra });
const finished = (id, name, endMs, extra) => src(item(id, name, "finished", 1, endMs), extra);

describe("buildDoneFeatures", () => {
  it("keeps only the features whose every chat finished, newest finish first", () => {
    const rows = buildDoneFeatures([
      finished("a", "Old job", NOW - 5 * HOUR),
      finished("b", "New job", NOW - 1 * HOUR),
      src(item("c", "Still going", "working", 2)),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["New job", "Old job"]);
    expect(rows[0].doneAt).toBe(NOW - HOUR);
  });

  it("leaves a feature with a chat still working to the Plan card, which keeps it", () => {
    const sources = [
      finished("a", "x", NOW - HOUR, { todoId: "pc-3" }),
      src(item("b", "y", "working", 2), { todoId: "pc-3" }),
    ];
    expect(buildDoneFeatures(sources)).toEqual([]);
    expect(buildFeatures(sources).rows).toHaveLength(1);
  });

  it("is the Plan card's complement: a feature is on exactly one of them", () => {
    const sources = [finished("a", "done one", NOW - HOUR), src(item("b", "going", "working", 2))];
    expect(buildFeatures(sources).rows.map((r) => r.title)).toEqual(["going"]);
    expect(buildDoneFeatures(sources).map((r) => r.title)).toEqual(["done one"]);
  });

  it("takes a feature's finish from its latest chat and carries each chat's verdict", () => {
    const rows = buildDoneFeatures([
      finished("a", "pc-8 build", NOW - 3 * HOUR, { todoId: "pc-8", verdict: " Built and tested " }),
      finished("b", "pc-8 review", NOW - HOUR, { todoId: "pc-8" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].doneAt).toBe(NOW - HOUR);
    expect(rows[0].chats.map((c) => c.verdict)).toEqual(["Built and tested", null]);
  });

  it("sorts a feature with no known finish time last", () => {
    const rows = buildDoneFeatures([finished("a", "undated", null), finished("b", "dated", NOW - HOUR)]);
    expect(rows.map((r) => r.title)).toEqual(["dated", "undated"]);
    expect(rows[1].doneAt).toBeNull();
  });
});

describe("the done window", () => {
  const rows = (n, spacingMs) => buildDoneFeatures(Array.from({ length: n }, (_, i) => finished(`s${i}`, `Job ${i}`, NOW - i * spacingMs)));

  it("shows the newest three inline and the rest in the popup", () => {
    const w = doneWindow(rows(6, HOUR / 4), NOW);
    expect(DONE_INLINE).toBe(3);
    expect(w.inline).toHaveLength(3);
    expect(w.rest.length).toBeGreaterThan(0);
    expect(w.inline[0].title).toBe("Job 0");
  });

  it("holds the last day, but never fewer than ten when fewer finished in a day", () => {
    // Twelve finished more than a day ago, one minute apart: none is in the last day, so the newest ten stay.
    const old = buildDoneFeatures(Array.from({ length: 12 }, (_, i) => finished(`o${i}`, `Old ${i}`, NOW - 30 * HOUR - i * 60_000)));
    const w = doneWindow(old, NOW);
    expect(w.inline.length + w.rest.length).toBe(DONE_MIN);
  });

  it("holds every feature of the last day once there are ten or more of them", () => {
    const day = rows(14, HOUR / 2);
    const w = doneWindow(day, NOW);
    expect(w.inline.length + w.rest.length).toBe(14);
  });

  it("drops what is older than a day once ten newer ones exist", () => {
    const fresh = Array.from({ length: 10 }, (_, i) => finished(`f${i}`, `Fresh ${i}`, NOW - i * HOUR / 4));
    const stale = finished("z", "Stale", NOW - 40 * HOUR);
    const w = doneWindow(buildDoneFeatures([...fresh, stale]), NOW);
    expect([...w.inline, ...w.rest].map((r) => r.title)).not.toContain("Stale");
  });
});

describe("release dividers", () => {
  const releases = [{ version: "0.2.158", date: "2026-11-22" }, { version: "0.2.157", date: "2026-11-20" }];

  it("puts a finish under the first release whose day had not ended", () => {
    expect(releaseOf(Date.parse("2026-11-19T09:00:00"), releases)).toBe("0.2.157");
    expect(releaseOf(Date.parse("2026-11-20T23:00:00"), releases)).toBe("0.2.157");
    expect(releaseOf(Date.parse("2026-11-21T09:00:00"), releases)).toBe("0.2.158");
  });

  it("gives two releases on one day's finishes to the older version, whatever order the entries come in", () => {
    const sameDay = [{ version: "0.2.160", date: "2026-11-24" }, { version: "0.2.159", date: "2026-11-24" }, { version: "0.2.158", date: "2026-11-22" }];
    expect(releaseOf(Date.parse("2026-11-23T09:00:00"), sameDay)).toBe("0.2.159");
    expect(releaseOf(Date.parse("2026-11-23T09:00:00"), [...sameDay].reverse())).toBe("0.2.159");
  });

  it("calls a finish newer than every release unreleased, and an undated one earlier", () => {
    expect(releaseOf(Date.parse("2026-11-23T09:00:00"), releases)).toBe(UNRELEASED);
    expect(releaseOf(null, releases)).toBe(EARLIER);
    expect(releaseOf(NOW, [])).toBe(EARLIER);
  });

  it("starts a new group wherever the release changes", () => {
    const rows = buildDoneFeatures([
      finished("a", "A", Date.parse("2026-11-23T09:00:00")),
      finished("b", "B", Date.parse("2026-11-21T09:00:00")),
      finished("c", "C", Date.parse("2026-11-21T08:00:00")),
      finished("d", "D", Date.parse("2026-11-19T08:00:00")),
    ]);
    const groups = groupByRelease(rows, releases);
    expect(groups.map((g) => [g.release, g.rows.map((r) => r.title)])).toEqual([
      [UNRELEASED, ["A"]], ["0.2.158", ["B", "C"]], ["0.2.157", ["D"]],
    ]);
  });

  it("draws a release as a button that opens its What's new and the others as plain labels", () => {
    expect(releaseDividerHtml("0.2.158")).toMatch(/<button[^>]*data-act="dl-whatsnew"[^>]*data-ver="0.2.158"/);
    expect(releaseDividerHtml(UNRELEASED)).not.toContain("<button");
    expect(releaseDividerHtml(EARLIER)).toContain("Earlier");
  });
});

describe("search and the new badge", () => {
  const [row] = buildDoneFeatures([finished("a", "Invite modal", NOW - HOUR, { todoId: "pc-77", title: "Invite modal" })]);

  it("matches a title or a todo id and ignores case", () => {
    expect(doneMatches(row, "invite")).toBe(true);
    expect(doneMatches(row, "PC-77")).toBe(true);
    expect(doneMatches(row, "billing")).toBe(false);
    expect(doneMatches(row, "  ")).toBe(true);
  });
});

describe("what the dashboard derives", () => {
  const base = { messages: [], plans: [], busy: false, now: NOW, sessionId: "main" };
  const subs = [item("a", "Old job", "finished", 1, NOW - HOUR), item("b", "going", "working", 2)];
  const done = (d) => d.right.find((z) => z.id === "done")?.state;

  it("gives a main chat's Done card its features as lines and the Plan card the rest", () => {
    const d = deriveDashboard({ ...base, subs, mainChat: true, doneLines: true });
    expect(done(d).lines.map((r) => r.title)).toEqual(["Old job"]);
    expect(d.right.find((z) => z.id === "plan").state.features.rows.map((r) => r.title)).toEqual(["Going"]);
  });

  it("keeps the task list on a chat that is no main chat", () => {
    const d = deriveDashboard({ ...base, subs });
    expect(done(d).lines).toBeNull();
    expect(done(d).tasks).toHaveLength(1);
  });

  it("draws no Done card when the only finished chat shares its feature with a working one", () => {
    const sibling = [item("a", "pc-1803 build", "finished", 1, NOW - HOUR), item("b", "pc-1803 fix", "working", 2)];
    const d = deriveDashboard({ ...base, mainChat: true, doneLines: true, subs: sibling });
    expect(done(d)).toBeUndefined();
    expect(d.right.find((z) => z.id === "plan").state.features.rows).toHaveLength(1);
  });
});

describe("the opened line", () => {
  it("opens one line at a time and one chat in it", () => {
    const none = { feat: null, chat: null };
    const a = nextOpen(none, "dl-open", "todo:1", "");
    expect(a).toEqual({ feat: "todo:1", chat: null });
    expect(nextOpen(a, "dl-open", "todo:2", "")).toEqual({ feat: "todo:2", chat: null });
    expect(nextOpen(a, "dl-open", "todo:1", "")).toEqual(none);
    const b = nextOpen(a, "dl-chat", "todo:1", "c1");
    expect(b).toEqual({ feat: "todo:1", chat: "c1" });
    expect(nextOpen(b, "dl-chat", "todo:1", "c1")).toEqual({ feat: "todo:1", chat: null });
  });

  it("opens the sole chat of a line with the line, and none when the line holds more or is being closed", () => {
    const none = { feat: null, chat: null };
    expect(nextOpen(none, "dl-open", "todo:1", "", "c1")).toEqual({ feat: "todo:1", chat: "c1" });
    expect(nextOpen(none, "dl-open", "todo:1", "", null)).toEqual({ feat: "todo:1", chat: null });
    expect(nextOpen({ feat: "todo:1", chat: "c1" }, "dl-open", "todo:1", "", "c1")).toEqual(none);
  });

  it("finds a line's sole chat only when it holds exactly one", () => {
    const one = buildDoneFeatures([finished("a", "Solo job", NOW - HOUR, { todoId: "pc-1" })]);
    const two = buildDoneFeatures([finished("a", "Pair job", NOW - HOUR, { todoId: "pc-2" }), finished("b", "Pair job review", NOW - HOUR, { todoId: "pc-2" })]);
    expect(soleChat(one, "todo:pc-1")).toBe("a");
    expect(soleChat(two, "todo:pc-2")).toBeNull();
    expect(soleChat(one, "todo:nope")).toBeNull();
  });
});

describe("the card", () => {
  let host;
  let card;
  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    host.className = "dl-host";
    document.body.appendChild(host);
    card = new DoneLinesCard({ releases: () => [], now: () => NOW });
  });
  const rowsOf = (n) => buildDoneFeatures(Array.from({ length: n }, (_, i) => finished(`s${i}`, `Job ${i}`, NOW - (i + 1) * 60_000, { todoId: `pc-${i + 1}` })));
  const slots = () => [...host.querySelectorAll(".dl-slot:not(.is-leaving)")];

  it("draws the header with no chevron and only the newest three lines", () => {
    card.update(host, rowsOf(5));
    expect(host.querySelector(".dl-h .cdash-h-t").textContent).toBe("Done");
    expect(host.querySelector(".dl-caret")).toBeNull();
    expect(host.querySelector(".dl-h button:not(.dl-earlier)")).toBeNull();
    expect(slots()).toHaveLength(3);
    expect(host.querySelectorAll(".pf-row")).toHaveLength(3);
    // The row is the Plan card's own: same classes, so the same fonts.
    expect(host.querySelector(".pf-row .pf-title").textContent).toBe("Job 0");
  });

  it("is always open: its lines are reachable and nothing in the header folds the card", () => {
    card.update(host, rowsOf(2));
    expect(host.querySelector(".dl-fold")).toBeNull();
    expect(host.querySelector(".dl-rows").hasAttribute("inert")).toBe(false);
    expect(host.querySelector("[data-act='dl-toggle']")).toBeNull();
    // A stray click of the old toggle's name does nothing.
    expect(card.act("dl-toggle", host.querySelector(".dl-h"))).toBe(false);
    expect(host.querySelector(".dl-rows").hasAttribute("inert")).toBe(false);
  });

  it("offers the earlier popup only while there are lines beyond the inline ones", () => {
    card.update(host, rowsOf(3));
    expect(host.querySelector(".dl-earlier")).toBeNull();
    card.update(host, rowsOf(6));
    expect(host.querySelector(".dl-earlier")).not.toBeNull();
  });

  it("opens a line in place without redrawing it, and a data update keeps it open", () => {
    card.update(host, rowsOf(2));
    const line = host.querySelector(".dl-feat");
    card.act("dl-open", host.querySelector(".dl-feat .pf-row"));
    expect(line.classList.contains("is-open")).toBe(true);
    expect(line.querySelector(".pf-row").getAttribute("aria-expanded")).toBe("true");
    card.update(host, rowsOf(2));
    expect(host.querySelector(".dl-feat")).toBe(line);
    expect(line.classList.contains("is-open")).toBe(true);
  });

  // A line with two chats: the opened line shows its chat rows and no steps until one is picked.
  const pairRows = () => buildDoneFeatures([finished("p1", "Pair job", NOW - 2 * 60_000, { todoId: "pc-9" }), finished("p2", "Pair job review", NOW - 60_000, { todoId: "pc-9" })]);

  it("shows a chat's steps only after its row is picked, when the line holds more than one chat", () => {
    card.update(host, pairRows());
    const row = host.querySelector(".dl-feat .pf-row");
    card.act("dl-open", row);
    expect(host.querySelectorAll(".dl-chatwrap")).toHaveLength(2);
    expect(host.querySelector(".dl-chatwrap.is-open")).toBeNull();
    card.act("dl-chat", host.querySelector(".dl-chat"));
    expect(host.querySelectorAll(".dl-chatwrap.is-open")).toHaveLength(1);
    expect(host.querySelector(".dl-chatwrap.is-open .dl-cview").hasAttribute("inert")).toBe(false);
  });

  it("opens the chat of a line that holds exactly one, and closes it again with the line", () => {
    card.update(host, rowsOf(1));
    const row = host.querySelector(".dl-feat .pf-row");
    card.act("dl-open", row);
    expect(host.querySelector(".dl-chatwrap").classList.contains("is-open")).toBe(true);
    expect(host.querySelector(".dl-cview").hasAttribute("inert")).toBe(false);
    card.act("dl-open", row);
    expect(host.querySelector(".dl-chatwrap").classList.contains("is-open")).toBe(false);
    card.act("dl-open", row);
    expect(host.querySelector(".dl-chatwrap").classList.contains("is-open")).toBe(true);
  });

  it("enters a new line and lets a gone one leave, keeping the lines that stay", () => {
    card.update(host, rowsOf(2));
    const kept = host.querySelectorAll(".dl-slot")[1];
    const more = buildDoneFeatures([finished("n", "Brand new", NOW - 1000, { todoId: "pc-99" }), ...rowsOf(2).flatMap((r) => r.chats.map((c) => finished(c.id, c.name, c.finishedAt, { todoId: r.todoId })))]);
    card.update(host, more);
    expect([...host.querySelectorAll(".dl-slot")].some((s) => s === kept)).toBe(true);
    expect(host.querySelector(".dl-slot.is-new")).not.toBeNull();
    expect(host.querySelector(".dl-slot .pf-title").textContent).toBe("Brand new");
  });

  describe("the sub icon trail", () => {
    const rowOf = (n) => buildDoneFeatures(Array.from({ length: n }, (_, i) => finished(`t${i}`, `Sub ${i}`, NOW - (n - i) * HOUR, { todoId: "pc-9" })))[0];
    const draw = (n) => {
      const d = document.createElement("div");
      d.innerHTML = doneLineHtml(rowOf(n), { feat: null, chat: null });
      return d;
    };
    const icons = (d) => [...d.querySelectorAll(".dl-trail .dl-ti")].map((e) => e.getAttribute("aria-label"));

    it("shows all five icons and no chip at five", () => {
      const d = draw(5);
      expect(icons(d)).toHaveLength(5);
      expect(d.querySelector(".dl-more")).toBeNull();
    });

    it("shows the 3 newest and +3 at six, chip first", () => {
      const d = draw(6);
      expect(icons(d).map((l) => l.split(": ")[1])).toEqual(["Sub 3", "Sub 4", "Sub 5"]);
      expect(d.querySelector(".dl-trail").firstElementChild.className).toBe("dl-more");
      expect(d.querySelector(".dl-more").textContent).toBe("+3");
    });

    it("shows 3 and +17 at twenty, the title names the hidden subs, and all 20 chat rows stay in the opened line", () => {
      const d = draw(20);
      expect(icons(d)).toHaveLength(3);
      const more = d.querySelector(".dl-more");
      expect(more.textContent).toBe("+17");
      expect(more.getAttribute("title")).toContain("Sub 0");
      expect(more.getAttribute("title")).not.toContain("Sub 19");
      expect(d.querySelectorAll(".dl-chat")).toHaveLength(20);
    });

    it("picks the newest by finish time, not by position", () => {
      const row = rowOf(6);
      row.chats[0].finishedAt = NOW + HOUR;
      const d = document.createElement("div");
      d.innerHTML = doneLineHtml(row, { feat: null, chat: null });
      expect(icons(d).map((l) => l.split(": ")[1])).toEqual(["Sub 0", "Sub 4", "Sub 5"]);
    });
  });

  it("draws the chat rows the way the Plan card's icons are: a kind icon with the chat menu's id", () => {
    card.update(host, rowsOf(1));
    const html = doneLineHtml(rowsOf(1)[0], { feat: null, chat: null });
    expect(html).toContain("data-chat-menu-id");
    expect(html).toContain('data-st="done"');
    expect(doneHeadHtml({ hasMore: false })).not.toContain("<button");
    expect(doneHeadHtml({ hasMore: true })).toContain('data-act="dl-earlier"');
  });

  const withNewer = (n) => buildDoneFeatures([
    finished("z", "Newer job", NOW + 5000),
    ...rowsOf(n).flatMap((r) => r.chats.map((c) => finished(c.id, c.name, c.finishedAt, { todoId: r.todoId }))),
  ]);

  it("keeps the clock button across a header redraw so an open popup keeps its anchor", () => {
    card.update(host, rowsOf(6));
    const btn = host.querySelector(".dl-earlier");
    card.act("dl-earlier", btn);
    expect(document.querySelector(".dl-pop")).not.toBeNull();
    card.update(host, withNewer(6));
    expect(host.querySelector(".dl-earlier")).toBe(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes the popup on a second click of the clock button", () => {
    card.update(host, rowsOf(6));
    const btn = host.querySelector(".dl-earlier");
    card.act("dl-earlier", btn);
    const pop = document.querySelector(".dl-pop");
    card.act("dl-earlier", btn);
    expect(pop.classList.contains("is-closing")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the todo from an id icon inside the popup, which sits outside the dashboard's click delegate", () => {
    card.update(host, rowsOf(6));
    card.act("dl-earlier", host.querySelector(".dl-earlier"));
    const seen = [];
    const on = (e) => seen.push(e.detail.id);
    window.addEventListener("cc-backlog-open", on);
    document.querySelector(".dl-pop .pf-lk[data-act='pf-todo']").click();
    window.removeEventListener("cc-backlog-open", on);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^pc-\d+$/);
  });

  it("removes a What's new dialog with the card, which the popup that opened it no longer owns", () => {
    const withRelease = new DoneLinesCard({ releases: () => [{ version: "0.2.158", date: "2026-11-23" }], now: () => NOW });
    withRelease.update(host, rowsOf(6));
    withRelease.act("dl-earlier", host.querySelector(".dl-earlier"));
    document.querySelector(".dl-pop [data-act='dl-whatsnew']").click();
    const dialog = document.querySelector(".dl-wn");
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    expect(document.querySelector(".dl-pop").classList.contains("is-closing")).toBe(true);
    withRelease.detach();
    expect(dialog.classList.contains("is-open")).toBe(false);
  });

  it("closes an open popup when the zone hands the card a new host", () => {
    card.update(host, rowsOf(6));
    card.act("dl-earlier", host.querySelector(".dl-earlier"));
    const pop = document.querySelector(".dl-pop");
    const next = document.createElement("div");
    document.body.appendChild(next);
    card.update(next, rowsOf(6));
    expect(pop.classList.contains("is-closing")).toBe(true);
  });

  it("forgets everything on detach so a later chat starts clean", () => {
    card.update(host, rowsOf(2));
    card.act("dl-open", host.querySelector(".dl-feat .pf-row"));
    card.detach();
    card.update(host, rowsOf(2));
    expect(host.querySelector(".dl-feat").classList.contains("is-open")).toBe(false);
  });
});
