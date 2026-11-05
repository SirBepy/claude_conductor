// Reviewed 2026-11-05: chat-message-cards.css gained the .passed-row rule only; no card rule changed - this spec's contract is unchanged and it passes.
// asserts: src/shared/chat/chat-message-card.ts, src/shared/chat/chat-message-cards.css, src/shared/chat/chat-card-turns.ts, src/shared/chat/chat-dom-renderer.ts
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
const FIRST_TURN = [user("ok go with what you think on billers, can it ever be empty though?"), ANSWER, REPORT];
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
