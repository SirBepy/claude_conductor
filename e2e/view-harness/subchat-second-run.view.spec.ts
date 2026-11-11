// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// asserts: src/views/sessions/sub-list.ts, src/views/sessions/main-chat.ts, src/views/sessions/sidebar-entries.ts, src/views/sessions/sidebar-rows.ts, src/views/sessions/sidebar-row-visuals.ts, src/views/sessions/session-header.ts, src/views/sessions/subchat-view.ts
// Reviewed 2026-11-05: sub-list.ts's row button now opens a new window instead of moving the sub; the lists and initials this spec asserts are unchanged and it passes.
// Reviewed 2026-11-05: subchat-view.ts lost the header "Move to sidebar" button (it is a chat-menu item now); the header initials and lists this spec asserts are unchanged and it passes.
import { test, expect, type Page } from "@playwright/test";
import { assistantMsg, capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// Fixes from the second real subchats run: a main chat that picked "Wait for them"
// stays in Main chats with a quiet hourglass (it used to vanish into the collapsed
// Closing group, most visibly on the phone), the sub list orders Finished by finish
// time and scrolls when long, and a sub read in place wears its list initials.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, ...over });
const finished = (id: string, name: string, pid: number, over: Over = {}) =>
  sub(id, name, pid, { subchat_finished: true, awaiting: "done", ...over });

// Inside the sub list's one-hour fold, so these finished subs are listed rather than folded under "+N earlier".
const RECENT = Date.now() - 5 * 60_000;
const finishCard = (subId: string, ts: number) => ({
  id: `finish-${subId}-1`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, verdict: "Done", text: "ok",
});

function invokeFor(sessions: unknown[], cards: unknown[] = []) {
  const events = [userMsg("hello"), assistantMsg("hi")];
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    list_subchat_cards: cards,
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_slash_commands: [],
    list_auto_accept: [],
  };
}

async function mount(page: Page, size: { width: number; height: number }, sessions: unknown[], cards: unknown[] = []): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "sessions", invoke: invokeFor(sessions, cards) });
  await page.locator("#sessions-list li").first().waitFor();
  await page.waitForTimeout(250);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const headers = async (page: Page) => (await page.locator("#sessions-list li.session-group-header").allTextContents()).map((t) => t.trim());
const countBtn = (page: Page) => page.locator("#session-pane .session-header .sub-count-btn");
const listRows = (page: Page) => page.locator(".sub-list-popover .sub-row");

async function openMain(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await row(page, "main").click();
  await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
  await page.locator(".session-composer .cc-typing-input").waitFor({ state: "attached" });
}

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / second subchats run (${label})`, () => {
    test("a main chat waiting for its subs to close stays in Main chats with a quiet hourglass", async ({ page }) => {
      const waiting = chat("main", "CV redesign", 101, { closing: true });
      await mount(page, size, [waiting, sub("sub-a", "Footer", 102, { busy: true })]);
      const texts = await headers(page);
      expect(texts[0]).toBe("Main chats");
      expect(texts, "it did not move to Closing").not.toContain("Closing");
      await expect(row(page, "main")).toHaveCount(1);
      const mark = row(page, "main").locator(".session-close-wait");
      await expect(mark).toHaveCount(1);
      await expect(mark).toHaveAttribute("data-tip", /Closing when its subs finish\. Close it again/);
      // Quiet: the row keeps its "1x" and is not styled as a closing row.
      await expect(row(page, "main").locator(".session-sub-count")).toHaveText("1x");
      await expect(row(page, "main")).not.toHaveClass(/closing/);
      await capture(page.locator("#sessions-list"), `main-chat-close-wait-${label}`);
    });

    test("with every sub finished a closing chat is on its way out and moves to Closing as before", async ({ page }) => {
      await mount(page, size, [chat("main", "CV redesign", 101, { closing: true }), finished("sub-a", "Footer", 102)]);
      expect(await headers(page)).toContain("Closing");
      await expect(row(page, "main").locator(".session-close-wait")).toHaveCount(0);
    });

    test("the header count carries the hourglass and the list says how to change your mind", async ({ page }) => {
      await mount(page, size, [chat("main", "CV redesign", 101, { closing: true }), sub("sub-a", "Footer", 102, { busy: true })]);
      await openMain(page);
      await expect(countBtn(page).locator(".sub-close-wait")).toHaveCount(1);
      await expect(countBtn(page)).toHaveAttribute("title", /Closing when its subs finish/);
      await countBtn(page).click();
      await expect(page.locator(".sub-list-popover .sub-list-note")).toContainText("Close it again to change your mind");
      await capture(page, `main-chat-close-wait-list-${label}`);
    });

    test("a chat that is not waiting shows none of it", async ({ page }) => {
      await mount(page, size, [chat("main", "CV redesign", 101), sub("sub-a", "Footer", 102, { busy: true })]);
      await openMain(page);
      await expect(row(page, "main").locator(".session-close-wait")).toHaveCount(0);
      await expect(countBtn(page).locator(".sub-close-wait")).toHaveCount(0);
      await countBtn(page).click();
      await expect(page.locator(".sub-list-popover .sub-list-note")).toHaveCount(0);
    });

    test("Finished lists the sub that finished last first, by its finish card, whatever order the rows came in", async ({ page }) => {
      const subs = [finished("sub-a", "Alpha", 102), finished("sub-b", "Bravo", 103), finished("sub-c", "Charlie", 104)];
      const cards = [finishCard("sub-a", RECENT + 3000), finishCard("sub-b", RECENT + 9000), finishCard("sub-c", RECENT + 6000)];
      await mount(page, size, [chat("main", "CV redesign", 101), ...subs], cards);
      await openMain(page);
      await countBtn(page).click();
      await listRows(page).first().waitFor();
      const order = await listRows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subId));
      expect(order).toEqual(["sub-b", "sub-c", "sub-a"]);
      await capture(page, `sub-list-finished-order-${label}`);
    });

    test("a long list scrolls inside the popover and never runs off the screen", async ({ page }) => {
      const subs = Array.from({ length: 24 }, (_, i) => finished(`sub-${i}`, `Job ${i}`, 200 + i));
      const cards = subs.map((s, i) => finishCard(s.session_id, RECENT + i * 10));
      await mount(page, size, [chat("main", "CV redesign", 101), ...subs], cards);
      await openMain(page);
      await expect(countBtn(page)).toContainText("24");
      await countBtn(page).click();
      await expect(listRows(page)).toHaveCount(24);
      const pop = page.locator(".sub-list-popover");
      const box = (await pop.boundingBox())!;
      expect(box.y + box.height, "its bottom edge is on screen").toBeLessThanOrEqual(size.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      const scroll = await pop.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
      expect(scroll.oy).toBe("auto");
      expect(scroll.sh, "there is more to scroll to than fits").toBeGreaterThan(scroll.ch);
      // The oldest finish is reachable by scrolling, and is last.
      await pop.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(listRows(page).last()).toBeInViewport();
      expect(await listRows(page).last().getAttribute("data-sub-id")).toBe("sub-0");
      await capture(page, `sub-list-24-rows-${label}`);
    });

    test("a sub read in place wears the same initials as its list row, not a question mark", async ({ page }) => {
      await mount(page, size, [chat("main", "CV redesign", 101), sub("sub-a", "Footer links", 102, { busy: true })]);
      await openMain(page);
      await countBtn(page).click();
      await expect(listRows(page).first().locator(".sub-dot")).toContainText("FL");
      await listRows(page).first().click();
      await expect(page.locator("#session-pane .session-header .sub-back-btn")).toBeVisible();
      const avatar = page.locator("#session-pane .session-header .session-header-char-placeholder");
      await expect(avatar).toHaveText("FL");
      await capture(page.locator("#session-pane .session-header"), `sub-header-initials-${label}`);
    });
  });
}

test.describe("view-harness / second subchats run (desktop hover)", () => {
  test("the hover card says the chat closes when its subs finish", async ({ page }) => {
    await mount(page, DESKTOP, [chat("main", "CV redesign", 101, { closing: true }), sub("sub-a", "Footer", 102, { busy: true })]);
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("closing when subs finish");
  });
});
