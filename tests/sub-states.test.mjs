// @vitest-environment jsdom
// asserts: src/views/sessions/main-chat.ts, src/views/sessions/sub-list.ts, src/views/sessions/sidebar-hover-card-html.ts, src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/chat-menu.ts, src/views/sessions/sidebar-ring.ts

// The honest sub states (docs/chat-dashboard-design.md, "Seeing what subs are
// doing"): a sub that is not making progress is queued, paused, at its usage
// limit or stopped without finishing, never "working"; each draws a dim ring and
// a corner glyph, has its own hover card, and the Plan card's foot counts them.

import { describe, it, expect, vi } from "vitest";

const { mainChatInfo } = await import("../src/views/sessions/main-chat.ts");
const { subRingSpec, subGlyphHtml, subListHtml } = await import("../src/views/sessions/sub-list.ts");
const { ringHtml, mainChatRingSpec } = await import("../src/views/sessions/sidebar-ring.ts");
const { buildSubHoverCardHtml, buildHoverCardHtml } = await import("../src/views/sessions/sidebar-hover-card-html.ts");
const { countSubs, subCountsText, formatActionAge } = await import("../src/shared/chat/dashboard/subs-model.ts");
const { renderPlan, initialPlanUi } = await import("../src/views/sessions/chat-dashboard/plan-card.ts");
const { buildSubCardItems } = await import("../src/views/sessions/chat-menu-items.ts");
const { buildItemsBlock } = await import("../src/views/sessions/chat-menu.ts");
const { sessionRowOptions } = await import("../src/views/sessions/sidebar-rows.ts");

const NOW = Date.parse("2026-11-12T12:00:00Z");
const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-12T11:48:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const main = inst({ session_id: "main", name: "Main" });
const sub = (id, over = {}) => inst({ session_id: id, name: id, subchat_of: "main", busy: true, ...over });
const progress = (extra = {}) => ({ plan: null, state_since: null, ...extra });
const kindOf = (s) => mainChatInfo(main, [main, s]).subs[0];

describe("sub kinds", () => {
  it("a sub with a running turn is working", () => {
    expect(kindOf(sub("a")).kind).toBe("working");
  });

  it("a sub the daemon holds is queued, with what it waits for", () => {
    const q = kindOf(sub("a", { busy: false, progress: progress({ waiting_for: "waiting for header" }) }));
    expect(q).toMatchObject({ kind: "queued", progress: "waiting for header" });
  });

  it("a frozen sub is paused, and a gaming-mode park says so", () => {
    expect(kindOf(sub("a", { frozen: true }))).toMatchObject({ kind: "paused", progress: "paused" });
    const parked = kindOf(sub("a", { progress: progress({ parked: true }) }));
    expect(parked).toMatchObject({ kind: "paused", progress: "paused by gaming mode" });
    expect(parked.hover.gaming).toBe(true);
  });

  it("a sub past its usage limit is limited until the reset, with the time in words", () => {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    const s = kindOf(sub("a", { rate_limited_resets_at: BigInt(resets) }));
    expect(s.kind).toBe("limited");
    expect(s.progress).toMatch(/^usage limit, resets \d/);
    expect(s.hover.resetsAt).toBe(resets * 1000);
    // A reset in the past is no limit.
    expect(kindOf(sub("a", { rate_limited_resets_at: BigInt(Math.floor(Date.now() / 1000) - 60) })).kind).toBe("working");
  });

  it("a sub whose turn ended without finishing is stopped, not working", () => {
    const s = kindOf(sub("a", { busy: false, progress: progress({ stopped_unfinished: true }) }));
    expect(s).toMatchObject({ kind: "stopped", progress: "stopped without finishing" });
    // A turn that started again clears the flag on the daemon; a stale flag with a busy turn is working.
    expect(kindOf(sub("a", { busy: true, progress: progress({ stopped_unfinished: true }) })).kind).toBe("working");
  });

  it("an idle live sub is stopped even with no stopped flag (the flag is lost on a daemon restart)", () => {
    expect(kindOf(sub("a", { busy: false })).kind).toBe("stopped");
  });

  it("a working sub's clock starts at its turn, not at the row's start", () => {
    const w = kindOf(sub("a", { started_at: "2026-11-12T11:48:00Z", progress: progress({ state_since: "2026-11-13T09:00:00Z" }) }));
    expect(w.startedAt).toBe("2026-11-13T09:00:00Z");
    expect(kindOf(sub("a", { busy: false, started_at: "2026-11-12T11:48:00Z" })).startedAt).toBe("2026-11-12T11:48:00Z");
  });

  it("asking and finished outrank every idle state, and queued outranks paused", () => {
    expect(kindOf(sub("a", { frozen: true, subchat_finished: true, busy: false })).kind).toBe("finished");
    expect(kindOf(sub("a", { busy: false, frozen: true, progress: progress({ waiting_for: "x" }) })).kind).toBe("queued");
  });

  it("orders the list asking, working, queued, paused, limited, stopped, finished", () => {
    const resets = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const subs = [
      sub("fin", { subchat_finished: true, busy: false }),
      sub("stop", { busy: false, progress: progress({ stopped_unfinished: true }) }),
      sub("lim", { rate_limited_resets_at: resets }),
      sub("pau", { frozen: true }),
      sub("que", { busy: false, progress: progress({ waiting_for: "x" }) }),
      sub("wor"),
    ];
    expect(mainChatInfo(main, [main, ...subs]).subs.map((s) => s.kind)).toEqual(["working", "queued", "paused", "limited", "stopped", "finished"]);
  });

  it("only a working sub makes the main chat's anyWorking true", () => {
    const idle = [sub("q", { busy: false, progress: progress({ waiting_for: "x" }) }), sub("p", { frozen: true }), sub("st", { busy: false, progress: progress({ stopped_unfinished: true }) })];
    expect(mainChatInfo(main, [main, ...idle]).anyWorking).toBe(false);
    expect(mainChatInfo(main, [main, ...idle, sub("w")]).anyWorking).toBe(true);
  });
});

describe("rings and glyphs", () => {
  const spec = (s) => { const st = kindOf(s); return subRingSpec(st, s); };
  it("the four idle states draw a dim ring, never the working yellow", () => {
    for (const s of [
      sub("a", { busy: false, progress: progress({ waiting_for: "x" }) }),
      sub("a", { frozen: true }),
      sub("a", { rate_limited_resets_at: BigInt(Math.floor(Date.now() / 1000) + 3600) }),
      sub("a", { busy: false, progress: progress({ stopped_unfinished: true }) }),
    ]) {
      expect(spec(s)).toEqual({ kind: "solid", tone: "dim" });
      expect(ringHtml(spec(s))).toContain('data-tone="dim"');
    }
  });

  it("working, asking and finished keep their own rings", () => {
    expect(spec(sub("a"))).toEqual({ kind: "solid", tone: "working", glow: true });
    expect(spec(sub("a", { subchat_finished: true, busy: false }))).toEqual({ kind: "solid", tone: "done" });
  });

  it("draws clock, pause, hourglass and moon, and nothing for the other states", () => {
    expect(subGlyphHtml("queued")).toContain("ph-clock");
    expect(subGlyphHtml("paused")).toContain("ph-pause");
    expect(subGlyphHtml("limited")).toContain("ph-hourglass-medium");
    expect(subGlyphHtml("stopped")).toContain("ph-moon");
    for (const k of ["working", "asking", "finished"]) expect(subGlyphHtml(k)).toBe("");
  });

  it("the sub list files paused, limited and stopped subs apart from the running ones", () => {
    const subs = mainChatInfo(main, [main, sub("w"), sub("p", { frozen: true }), sub("st", { busy: false, progress: progress({ stopped_unfinished: true }) })]).subs;
    const html = subListHtml(subs, [main], true, new Map(), false, Date.now());
    expect(html.indexOf("Running")).toBeLessThan(html.indexOf("Not running"));
    const running = html.slice(html.indexOf("Running"), html.indexOf("Not running"));
    expect(running).toContain('data-sub-id="w"');
    expect(running).not.toContain('data-sub-id="p"');
    expect(html.slice(html.indexOf("Not running"))).toContain('data-sub-id="st"');
    expect(html).toContain("sub-glyph");
  });
});

describe("hover card", () => {
  const input = (s, extra = {}) => {
    const st = kindOf(s);
    return { name: st.name, tier: "Opus high", kind: st.kind, hover: st.hover, startedAt: st.startedAt, contextPct: null, now: NOW, ...extra };
  };
  const PLAN = [{ text: "Read", status: "done" }, { text: "Edit footer.css", status: "active" }, { text: "Verify", status: "pending" }];

  it("says the state in words, the step it is on, the time running and the last action with its age", () => {
    const html = buildSubHoverCardHtml(input(sub("Footer", {
      progress: progress({ plan: PLAN, last_action: "Editing footer.css", last_action_at: new Date(NOW - 18_000).toISOString() }),
    })));
    expect(html).toContain("Footer");
    expect(html).toContain("Working");
    expect(html).toContain("running 12:00");
    expect(html).toContain("Step 2 of 3");
    expect(html).toContain("Edit footer.css");
    expect(html).toContain("Editing footer.css");
    expect(html).toContain("18s ago");
    expect(html).not.toContain("hc-bar");
  });

  it("a queued sub's card says what it waits for and its place in line, and shows no run time", () => {
    const html = buildSubHoverCardHtml(input(sub("Form", {
      busy: false, progress: progress({ waiting_for: "waiting for the writer slot", queue_place: 3, queue_behind: "Footer" }),
    })));
    expect(html).toContain("Queued");
    expect(html).toContain("waiting for the writer slot");
    expect(html).toContain("Place 3 in line");
    expect(html).toContain("Behind Footer");
    expect(html).not.toContain("running ");
  });

  it("the sub at the front of the line is next, and a sub waiting on another sub has no place", () => {
    expect(buildSubHoverCardHtml(input(sub("a", { busy: false, progress: progress({ waiting_for: "x", queue_place: 1 }) })))).toContain("Next in line");
    expect(buildSubHoverCardHtml(input(sub("a", { busy: false, progress: progress({ waiting_for: "waiting for header" }) })))).not.toContain("in line");
  });

  it("a usage-limited card says when it resets, a parked one says gaming mode, a stopped one says where it stopped", () => {
    const resets = Math.floor(NOW / 1000) + 3600;
    vi.useFakeTimers({ now: NOW });
    try {
      expect(buildSubHoverCardHtml(input(sub("a", { rate_limited_resets_at: BigInt(resets) })))).toMatch(/Usage limit[\s\S]*Resets at \d/);
      expect(buildSubHoverCardHtml(input(sub("a", { progress: progress({ parked: true }) })))).toContain("Gaming mode paused it");
      const stopped = buildSubHoverCardHtml(input(sub("a", { busy: false, progress: progress({ stopped_unfinished: true, last_action: "Running tests", last_action_at: new Date(NOW - 125_000).toISOString() }) })));
      expect(stopped).toContain("Stopped without finishing");
      expect(stopped).toContain("Running tests");
      expect(stopped).toContain("2m ago");
      // Nothing runs, so no clock counts up beside "Stopped without finishing".
      expect(stopped).not.toContain("running ");
      expect(buildSubHoverCardHtml(input(sub("a", { frozen: true })))).not.toContain("running ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the context figure and escapes names and actions", () => {
    const html = buildSubHoverCardHtml(input(sub("<b>x</b>", { progress: progress({ last_action: "<i>y</i>", last_action_at: new Date(NOW).toISOString() }) }), { contextPct: 34.2 }));
    expect(html).toContain("34%");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>y</i>");
  });

  it("the main chat's own row card dots an idle sub dim, not working yellow", () => {
    const html = buildHoverCardHtml({
      title: "Main", project: "cv", st: "st-your-turn", plan: null, question: null, stateSince: null, contextPct: null, now: NOW,
      subs: [{ name: "Form", kind: "queued", progress: "waiting" }],
    });
    expect(html).toContain("var(--color-text-muted)");
    expect(html).not.toContain("var(--st-working)");
  });

  it("formats an action's age", () => {
    expect(formatActionAge(18_000)).toBe("18s ago");
    expect(formatActionAge(125_000)).toBe("2m ago");
    expect(formatActionAge(3 * 3600_000)).toBe("3h ago");
  });
});

describe("Plan foot counts", () => {
  const items = (...kinds) => kinds.map((kind) => ({ kind }));

  it("counts unfinished subs by state and leaves the empty states out", () => {
    const c = countSubs(items("working", "working", "asking", "asking", "queued", "queued", "stopped", "stopped", "stopped", "finished"));
    expect(subCountsText(c)).toBe("2 working · 2 asking · 2 queued · 3 stopped");
    expect(subCountsText(countSubs(items("paused", "limited", "working")))).toBe("1 working · 1 paused · 1 at usage limit");
  });

  it("is null when every sub finished or there are none, so the foot keeps its plain idle line", () => {
    expect(countSubs([])).toBeNull();
    expect(countSubs(items("finished", "finished"))).toBeNull();
  });

  const planState = { mode: "empty", job: null, earlier: [], status: { kind: "idle", since: Date.parse("2026-11-12T03:17:00") } };
  const foot = (subs) => {
    const host = document.createElement("div");
    host.innerHTML = renderPlan(planState, { ui: initialPlanUi(), busy: false, idleAt: null, subs, card: () => "" });
    return host.querySelector('[data-slot="status"]');
  };

  it("the foot counts the subs first, then the chat's own idle line muted", () => {
    const f = foot(countSubs(items("working", "working", "asking", "queued", "stopped")));
    expect(f.querySelector(".cdash-pcounts").textContent).toBe("2 working · 1 asking · 1 queued · 1 stopped");
    expect(f.querySelector(".cdash-pstatus-own").textContent).toMatch(/^This chat idle since \d/);
    expect(f.textContent).not.toMatch(/^Idle since/);
  });

  it("with no unfinished sub the foot is the plain idle line", () => {
    const f = foot(null);
    expect(f.querySelector(".cdash-pcounts")).toBeNull();
    expect(f.textContent).toMatch(/Idle since/);
  });

  it("a chat waiting on Joe's answer keeps saying so under the counts", () => {
    const host = document.createElement("div");
    host.innerHTML = renderPlan({ ...planState, status: { kind: "wait", since: Date.parse("2026-11-12T03:17:00") } }, { ui: initialPlanUi(), busy: false, idleAt: null, subs: countSubs(items("asking")), card: () => "" });
    expect(host.querySelector(".cdash-pstatus-own").textContent).toMatch(/^This chat is waiting on your answer · asked \d/);
  });
});

describe("main chat ring", () => {
  // The repro for Joe's "it goes green and never stops being green": every sub finished and
  // the chat read (`st-your-turn`) used to draw a solid green ring for as long as the subs
  // stayed finished. A read chat has no ring, as on any other chat.
  // Through the real row builder, the path the sidebar draws from. `unread` is the chat's own
  // finish not yet read (`st-done`); without it the chat is read and idle (`st-your-turn`).
  const rowRing = (subs, { unread = false } = {}) => sessionRowOptions(main, {
    isActive: false, unread: new Set(unread ? ["main"] : []), attention: new Set(), question: new Set(), rateLimited: new Set(), closing: new Set(),
    sort: "status", drainMap: new Map(), scheduledCountMap: new Map(), kbdHint: "", mainChat: mainChatInfo(main, [main, ...subs]),
  }).avatarExtras.ringHtml;
  const fin = (id) => sub(id, { subchat_finished: true, busy: false });
  const queuedSub = (id) => sub(id, { busy: false, progress: progress({ waiting_for: "x" }) });
  const stoppedSub = (id) => sub(id, { busy: false, progress: progress({ stopped_unfinished: true }) });

  it("does not stay green after every sub finished and Joe read the chat", () => {
    expect(rowRing([fin("a")])).toBe("");
    expect(mainChatInfo(main, [main, fin("a")]).allFinished).toBe(true);
  });

  // Joe, 2026-11-12: "they should only glow green IF ALLLL of the subchats are done... only then".
  it("is green when the chat's own turn is done and every sub finished", () => {
    const ring = rowRing([fin("a"), fin("b")], { unread: true });
    expect(ring).toContain('data-tone="done"');
  });

  it("one unfinished sub of several blocks green, whatever it is doing", () => {
    for (const unfinished of [queuedSub("q"), stoppedSub("s"), sub("p", { frozen: true })]) {
      const ring = rowRing([fin("a"), fin("b"), unfinished], { unread: true });
      expect(ring, unfinished.session_id).not.toContain('data-tone="done"');
      expect(ring, unfinished.session_id).toBe("");
    }
  });

  it("glows while a sub works, even beside finished ones, and never draws green then", () => {
    const ring = rowRing([fin("a"), sub("w")], { unread: true });
    expect(ring).toContain('data-tone="working"');
    expect(ring).toContain("is-glow");
    expect(ring).not.toContain('data-tone="done"');
    expect(rowRing([fin("a"), sub("w")])).toContain("is-glow");
  });

  it("draws the attention pulse while a sub asks, never green", () => {
    const ring = rowRing([fin("a"), sub("k", { awaiting: "question" })], { unread: true });
    expect(ring).toContain('data-tone="attention"');
    expect(ring).toContain("is-pulse");
    expect(ring).not.toContain('data-tone="done"');
  });

  it("stops glowing when the last working sub stops", () => {
    expect(rowRing([sub("a")])).toContain("is-glow");
    expect(rowRing([stoppedSub("a")])).toBe("");
  });

  it("a chat with no subs keeps the ordinary green for its own unread finish", () => {
    expect(rowRing([], { unread: true })).toContain('data-tone="done"');
  });
});

describe("queued sub's menu", () => {
  const ctx = (over = {}) => ({
    subId: "a", anchor: document.body, model: "opus", effort: "high", queued: true, finished: false, busy: false,
    frozen: false, pinned: false, mirrored: false, open: () => {}, latestPreview: async () => null, ...over,
  });
  const labels = (items) => items.map((i) => i.label);

  it("a running sub's menu is unchanged", () => {
    expect(labels(buildSubCardItems(ctx({ queued: false, busy: true })))).toEqual([
      "Open", "Open in new window", "Latest preview", "Pause", "Pin to sidemenu", "Stop this turn", "Change model", "Change effort", "Close",
    ]);
  });

  it("a queued sub's top level has Start now and Drop and none of the process-only items", () => {
    const items = buildSubCardItems(ctx());
    expect(labels(items)).toEqual(["Open", "Open in new window", "Latest preview", "Start now", "Pin to sidemenu", "Once it has started", "Drop"]);
    expect(items.find((i) => i.label === "Drop").danger).toBe(true);
    expect(labels(items.find((i) => i.children).children)).toEqual(["Pause", "Stop this turn", "Change model", "Change effort", "Close"]);
    // Every nested item is disabled with the reason, never silently dead.
    for (const c of items.find((i) => i.children).children) expect(c.run === undefined || c.disabledReason === "Not started yet").toBe(true);
  });

  it("Start now and Drop call the desktop-only RPCs with the sub's id", async () => {
    const calls = [];
    vi.resetModules();
    vi.doMock("../src/shared/ipc.ts", () => ({ invoke: async (cmd, args) => { calls.push([cmd, args]); return null; } }));
    const { buildSubCardItems: build } = await import("../src/views/sessions/chat-menu-items.ts");
    const items = build(ctx({ onAfterAction: () => calls.push(["after"]) }));
    await items.find((i) => i.label === "Start now").run();
    await items.find((i) => i.label === "Drop").run();
    expect(calls).toEqual([["start_queued_sub", { sessionId: "a" }], ["after"], ["drop_queued_sub", { sessionId: "a" }], ["after"]]);
    vi.doUnmock("../src/shared/ipc.ts");
  });

  it("a sub on another machine cannot be started or dropped from here", () => {
    const items = buildSubCardItems(ctx({ mirrored: true }));
    for (const l of ["Start now", "Drop"]) {
      const it = items.find((i) => i.label === l);
      expect(it.run).toBeUndefined();
      expect(it.disabledReason).toBeTruthy();
    }
  });

  it("the nested item opens a submenu beside the parent that lists the five, disabled", () => {
    document.body.innerHTML = "";
    const block = buildItemsBlock(buildSubCardItems(ctx()), () => {});
    document.body.appendChild(block);
    const parent = [...block.querySelectorAll(".smore-item")].find((b) => b.textContent.includes("Once it has started"));
    expect(parent.classList.contains("smore-has-sub")).toBe(true);
    expect(parent.classList.contains("is-disabled")).toBe(false);
    parent.click();
    const sub = document.querySelector(".chat-menu-submenu");
    expect([...sub.querySelectorAll(".smore-item")].map((b) => b.textContent)).toEqual(["Pause", "Stop this turn", "Change model", "Change effort", "Close"]);
    for (const b of sub.querySelectorAll(".smore-item")) expect(b.classList.contains("is-disabled")).toBe(true);
  });
});
