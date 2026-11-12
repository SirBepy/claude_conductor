// Reviewed 2026-11-12 (quotes as reply bubbles): renderMarkdown tags every blockquote .md-quote and lifts a leading **Name:** onto a speaker line, the transcript no longer wraps a quote in a copy card (.card-block is gone), and the draft editor's blockquote rule moved into the shared one; nothing this spec asserts changed, and it passes (chat-message-cards and subchat-passed fail their phone-width overflow tests on pristine HEAD too).
// Reviewed 2026-11-10: chat-dom-renderer.ts's flushRender also fires the renderer's onFlushed hook (the chat dashboard's re-derive); no row or card markup changed, and this spec passes in Messages view.
// Reviewed 2026-11-05: chat-message-card.ts gained an optional quiet `tagNote` after a sub's tag and chat-message-cards.css two rules for it; a card without one draws as before, and this spec passes.
// Reviewed 2026-11-05: chat-message-cards.css gained the .passed-row rule only; no card rule changed - this spec's contract is unchanged and it passes.
// Reviewed 2026-11-06: chat-message-card.ts draws a card's optional `visuals` under its body, and chat-pagination.ts / chat-event-handler-tools.ts revise them on update_message; a card without visuals draws as before.
// asserts: src/shared/chat/message-visuals-render.ts, src/shared/chat/chat-message-card.ts, src/shared/chat/chat-message-cards.css, src/shared/chat/chat-card-turns.ts, src/shared/chat/chat-dom-renderer.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A send_message that declared a kind draws as a verdict card through the real
// renderer and the real chat CSS; once a later turn speaks, the earlier cards
// shrink to one-line mini cards that a click reopens in place. Same flow at
// desktop width and at phone width (390px), with nothing branching on the transport.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

const send = (id: string, input: Record<string, unknown>) => ({
  type: "tool_use", tool_name: SEND, input, id, timestamp: 0, parent_tool_use_id: null,
});
// The runner channel drops a user_message that is not a remote echo (the composer pushes its own
// synthetic copy), so a live turn in this spec has to arrive as one.
const user = (text: string, live = false) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0, remote_echo: live });

const ANSWER = send("a1", {
  kind: "answer",
  verdict: "Yes",
  tone: "neutral",
  text: "Empty billers can happen, and your call is what's built.\nIt acts like a turned-off link, the same as an inactive group.",
  points: ["Wrong account: the borrower is already told.", "\"Did you mean this biller?\": left out, it could send money to the wrong company."],
});
const REPORT = send("r1", {
  kind: "report",
  verdict: "Built, not pushed",
  text: "sc-56605 committed as `c083bd89`",
  done: ["Analyze, 621 unit tests, own-link and group-link e2e", "Link goes straight to the biller", "Signup and loan attribute to the parent group", "Turned-off links open `/biller`"],
  not_done: ["Biller turned off mid-flow: generic error on Review until the link is reopened"],
  waiting_on: ["Chat \"Gate: zng-app push\": gate, push, ticket moves"],
  your_move: ["Ask Lenar: QA group with 2+ enabled billers, and is the sc-56598 deploy on QA?"],
  details: [{ id: "calls", label: "3 calls to check", body_md: "- own values merge into `SlugBiller`" }],
});
const VISUALS_ANSWER = send("v1", {
  kind: "answer",
  verdict: "Opus costs most",
  text: "Cost per model, last 7 days",
  visuals: [
    { type: "table", title: "Cost by model", columns: ["Model", "Chats", "Turns", "Cost", "Cache hit rate", "Median latency"], rows: [["Opus", 4, 212, "$18.40", "91%", "4.2s"], ["Sonnet", 21, 1040, "$9.75", "88%", "2.1s"]] },
    { type: "bar", title: "Slowest files", unit: "s", data: [{ label: "subchats-spawn", value: 9.2 }, { label: "chat-flow", value: 7.4 }] },
    { type: "line", title: "Usage by day", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Opus", values: [12, 30, 62] }, { name: "Sonnet", values: [20, 24, 30] }] },
  ],
});
const TIMELINE_ANSWER = send("v2", {
  kind: "answer",
  verdict: "Two gaps this week",
  text: "Clockify, Mon and Tue",
  visuals: [{ type: "donut", title: "Chat state", data: [{ label: "Done", value: 18 }, { label: "Blocked", value: 2 }] }, { type: "timeline", title: "Logged time", rows: [{ label: "Mon 3 Nov", blocks: [{ start: "09:00", end: "12:30", label: "Subchats review" }, { start: "13:30", end: "17:00", label: "Tables" }] }, { label: "Tue 4 Nov", blocks: [{ start: "10:00", end: "11:00" }] }] }],
});
const RATING = send("g1", {
  kind: "rating",
  verdict: "🙂 7/10 Good, two fixes from great",
  tone: "good",
  text: "The core is sound and cheap to build, but it has no failure path and no test.\nNext move: **apply all** the suggestions, **apply some** (say which), or **ignore** and carry on?",
  points: ["→ 8/10: add a retry with a visible error state; costs about half a day", "→ 9/10: add a test that fails without the fix; costs an hour, locks the behavior", "→ 10/10: ship behind a setting for a week first; costs a slower rollout"],
});
const FIRST_TURN =[user("ok go with what you think on billers, can it ever be empty though?"), ANSWER, REPORT];
const SECOND_TURN = [
  user("ok, push it", true),
  send("r2", { kind: "report", verdict: "Pushed, one move is yours", text: "50ef89f is on origin/develop; Claude watches CI, then tests on dev", done: ["Pushed"], your_move: ["Move sc-54311 to Testing when convenient"] }),
];

async function mountChat(page: Page, width: number, history: unknown[]): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const chat = (page: Page) => page.locator("#session-pane .session-messages");

async function expectNoOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("#session-pane .session-messages")!;
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (host.scrollWidth > host.clientWidth + 1) bad.push(`host ${host.scrollWidth}>${host.clientWidth}`);
    for (const el of host.querySelectorAll<HTMLElement>(".mc-root, .mc-root *")) {
      if (el.closest(".mc-fold[style*='hidden']")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) bad.push(`${el.className || el.tagName} right ${Math.round(r.right)}>${vw}`);
    }
    return bad;
  });
  expect(over).toEqual([]);
}

for (const vp of [{ name: "desktop", width: 900 }, { name: "phone", width: 390 }]) {
  test.describe(`message cards at ${vp.name} width`, () => {
    test("a report draws verdict, your-move row and wordless chips that open the sections", async ({ page }) => {
      await mountChat(page, vp.width, FIRST_TURN);
      const roots = chat(page).locator(".mc-root");
      await expect(roots).toHaveCount(2);
      await expect(roots.locator(".is-old")).toHaveCount(0);

      const report = roots.nth(1);
      await expect(report.locator(".mc-full .mc-verdict")).toHaveText("Built, not pushed");
      // Split colour: what landed in green, what did not in amber.
      await expect(report.locator(".mc-full .mc-verdict .mc-t-good")).toHaveText("Built,");
      await expect(report.locator(".mc-full .mc-verdict .mc-t-warn")).toHaveText("not pushed");
      const yours = report.locator(".mc-full .mc-sec--yours");
      await expect(yours).toBeVisible();
      await expect(yours).toContainText("Ask Lenar");

      const summary = report.locator(".mc-full .mc-more > summary");
      await expect(summary).toBeVisible();
      expect((await summary.innerText()).replace(/\s+/g, " ").trim()).toBe("4 1 1");
      await expect(report.locator(".mc-full .mc-chip").first()).toHaveAttribute("aria-label", "4 done");
      await expect(report.locator(".mc-full .mc-more .mc-sec--done")).toBeHidden();
      await capture(chat(page), `cards-finished-${vp.name}`);

      await summary.click();
      await expect(report.locator(".mc-full .mc-more .mc-sec--done")).toBeVisible();
      await expect(report.locator(".mc-full .mc-more .mc-sec--not")).toContainText("generic error on Review");
      await expect(report.locator(".mc-full .mc-more .mc-sec--wait")).toContainText("Gate: zng-app push");
      await expect(report.locator(".mc-full .mc-more .drill-chip")).toHaveText("3 calls to check");
      await expectNoOverflow(page);
      await capture(chat(page), `cards-chips-open-${vp.name}`);

      // The answer: tinted, labelled, with its points one click away.
      const answer = roots.nth(0);
      await expect(answer.locator(".mc-full .mc-label")).toHaveText("Answer to you");
      await expect(answer.locator(".mc-full .mc-points summary")).toHaveText("2 more points");
    });

    test("a rating shows its ways to raise the score as open rows, score first and cost muted", async ({ page }) => {
      await mountChat(page, vp.width, [user("rate it"), RATING]);
      const card = chat(page).locator(".mc-root").first().locator(".mc-full");
      await expect(card.locator(".mc-lifts-label")).toHaveText("How to raise it");
      const rows = card.locator(".mc-lift");
      await expect(rows).toHaveCount(3);
      await expect(rows.first().locator(".mc-lift-to")).toHaveText("8/10");
      await expect(rows.first().locator(".mc-lift-cost")).toBeVisible();
      // The phone pane slides in; measuring mid-slide reads every box as shifted right.
      await page.waitForFunction(() => Math.round(document.querySelector("#session-pane .session-messages")!.getBoundingClientRect().left) <= (document.querySelector("#session-pane")!.getBoundingClientRect().left) + 1);
      await expectNoOverflow(page);
      await capture(chat(page), `cards-rating-${vp.name}`);
    });

    test("visuals draw inside the card: a wide table, bars, a line, a donut and a timeline", async ({ page }) => {
      await mountChat(page, vp.width, [user("how much did each model cost?"), VISUALS_ANSWER, TIMELINE_ANSWER]);
      const roots = chat(page).locator(".mc-root");
      const cost = roots.nth(0).locator(".mc-full");
      await expect(cost.locator(".mv-fig")).toHaveCount(3);
      await expect(cost.locator(".mv-fig figcaption").first()).toHaveText("Cost by model");
      await expect(cost.locator(".mv-table th")).toHaveCount(6);
      await expect(cost.locator(".mv-bar-row")).toHaveCount(2);
      await expect(cost.locator(".mv-line polyline")).toHaveCount(2);
      const second = roots.nth(1).locator(".mc-full");
      await expect(second.locator(".mv-donut circle")).toHaveCount(2);
      const tl = second.locator(".mv-timeline");
      await expect(tl.locator(".mv-block")).toHaveCount(3);
      await expect(tl.locator(".mv-tl-row b").first()).toHaveText("7h");
      // A wide table scrolls inside its own wrapper instead of pushing the card past the screen, so
      // expectNoOverflow (which reads every descendant's rect, clipped or not) does not fit it: measure
      // the card, the wrapper and the host instead.
      const fit = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const host = document.querySelector<HTMLElement>("#session-pane .session-messages")!;
        const wrap = host.querySelector<HTMLElement>(".mv-table .table-wrap")!;
        const card = host.querySelector<HTMLElement>(".mc-root")!;
        return { hostFits: host.scrollWidth <= host.clientWidth + 1, cardRight: card.getBoundingClientRect().right, wrapRight: wrap.getBoundingClientRect().right, wrapScrolls: wrap.scrollWidth > wrap.clientWidth, vw };
      });
      expect(fit.hostFits).toBe(true);
      expect(fit.cardRight).toBeLessThanOrEqual(fit.vw + 1);
      expect(fit.wrapRight).toBeLessThanOrEqual(fit.vw + 1);
      // Six columns do not fit a phone card, so there the wrapper must be the thing that scrolls.
      if (vp.width < 500) expect(fit.wrapScrolls).toBe(true);
      // The SVG charts keep their ratio and fill the figure.
      const box = await cost.locator(".mv-line svg").boundingBox();
      expect(box!.width).toBeGreaterThan(150);
      expect(box!.height).toBeGreaterThan(50);
      await capture(chat(page), `cards-visuals-${vp.name}`);
    });

    test("a short visuals table shows no vertical scrollbar", async ({ page }) => {
      const SHORT = send("t1", {
        kind: "answer", verdict: "Trackers", tone: "neutral",
        text: "Three trackers",
        visuals: [{ type: "table", title: "Trackers", columns: ["Tracker", "Status"], rows: [["Sentry", "on"], ["Datadog", "off"], ["Plausible", "on"]] }],
      });
      await mountChat(page, vp.width, [user("which trackers?"), SHORT]);
      await expect(chat(page).locator(".table-wrap")).toHaveCount(1);
      const gutters = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#session-pane .table-wrap")].map((w) => ({
        // A vertical scrollbar takes width from the scroller (the wrapper has no border) and
        // shows as content taller than the box; a horizontal one is allowed on a narrow screen.
        gutter: w.offsetWidth - w.clientWidth,
        over: w.scrollHeight - w.clientHeight,
      })));
      expect(gutters).toHaveLength(1);
      for (const g of gutters) {
        expect(g.over).toBeLessThanOrEqual(0);
        expect(g.gutter).toBe(0);
      }
    });

    test("a table taller than its max height still scrolls inside its wrapper", async ({ page }) => {
      const rows = Array.from({ length: 60 }, (_, i) => [`Row ${i}`, i]);
      const TALL = send("t2", { kind: "answer", verdict: "Long", tone: "neutral", text: "Sixty rows", visuals: [{ type: "table", title: "Rows", columns: ["Name", "N"], rows }] });
      await mountChat(page, vp.width, [user("list rows"), TALL]);
      const m = await page.evaluate(() => {
        const w = document.querySelector<HTMLElement>("#session-pane .table-wrap")!;
        return { scrolls: w.scrollHeight > w.clientHeight + 1, y: getComputedStyle(w).overflowY, h: w.clientHeight };
      });
      expect(m.scrolls).toBe(true);
      expect(m.y).toBe("auto");
      expect(m.h).toBeLessThan(900);
    });

    test("a later turn shrinks the earlier cards to mini cards, and a click reopens one in place", async ({ page }) => {
      await mountChat(page, vp.width, FIRST_TURN);
      const roots = chat(page).locator(".mc-root");
      const fullHeight = (await roots.nth(1).boundingBox())!.height;

      await fireEvent(page, CHANNEL, SECOND_TURN);
      await expect(roots).toHaveCount(3);
      await expect(chat(page).locator(".mc-root.is-old")).toHaveCount(2);
      await expect(roots.nth(2)).not.toHaveClass(/is-old/);

      // Live: the shrink plays, so it carries a real transition.
      const duration = await roots.nth(1).locator(".mc-full").evaluate((e) => getComputedStyle(e).transitionDuration);
      expect(duration).toContain("0.35s");

      // After the transition the full form is gone and the mini row shows.
      await expect(roots.nth(1).locator(".mc-full")).toBeHidden();
      const mini = roots.nth(1).locator(".mc-mini .mc-mini-row");
      await expect(mini).toBeVisible();
      await expect(mini.locator(".mc-mini-lead")).toHaveText("Built, not pushed");
      await expect(mini.locator(".mc-mini-open")).toHaveText("your move, 1 not done, 1 waiting");
      const miniHeight = (await roots.nth(1).boundingBox())!.height;
      expect(miniHeight).toBeLessThan(fullHeight / 2);
      expect(miniHeight).toBeLessThan(80);
      // The answer keeps its tint after shrinking; the box is still there.
      const tint = await roots.nth(0).locator(".mc-card").evaluate((e) => getComputedStyle(e).backgroundColor);
      const plain = await roots.nth(1).locator(".mc-card").evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(tint).not.toBe(plain);
      await expectNoOverflow(page);
      await capture(chat(page), `cards-old-turn-${vp.name}`);

      // A click reopens the content where it sits.
      await mini.click();
      const d = roots.nth(1).locator(".mc-mini details.mc-mini-d");
      await expect(d).toHaveAttribute("open", "");
      await expect(roots.nth(1).locator(".mc-mini-body .mc-sec--yours")).toBeVisible();
      await expect(roots.nth(1).locator(".mc-mini-body .mc-sec--done")).toBeVisible();
      await expectNoOverflow(page);
      await capture(chat(page), `cards-old-turn-open-${vp.name}`);
      await mini.click();
      await expect(d).not.toHaveAttribute("open", "");
    });

    test("a chat opened with older turns shows them already shrunk, with no motion to play", async ({ page }) => {
      await mountChat(page, vp.width, [...FIRST_TURN, ...SECOND_TURN]);
      const roots = chat(page).locator(".mc-root");
      await expect(roots).toHaveCount(3);
      await expect(chat(page).locator(".mc-root.is-old")).toHaveCount(2);
      await expect(roots.nth(1).locator(".mc-mini .mc-mini-row")).toBeVisible();
      await expect(roots.nth(1).locator(".mc-full")).toBeHidden();
      const duration = await roots.nth(1).locator(".mc-full").evaluate((e) => getComputedStyle(e).transitionDuration);
      expect(duration).toBe("0s");
      await expectNoOverflow(page);
    });
  });
}
