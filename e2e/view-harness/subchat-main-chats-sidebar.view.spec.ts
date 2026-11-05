// Reviewed 2026-11-05: main-chat.ts's progress text says paused or rate limited for a frozen or rate-limited sub instead of working; this spec's subs are neither, so its contract holds and it passes.
// asserts: src/views/sessions/sidebar-entries.ts, src/views/sessions/sidebar-rows.ts, src/views/sessions/sidebar-ring.ts, src/views/sessions/main-chat.ts, src/views/sessions/sidebar-hover-card.ts, src/views/sessions/sidebar-hover-card-html.ts, src/views/sessions/permission-modal/gating.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Subchats step 13: a chat with Use subchats on sits in its own "Main chats"
// group at the top of the sidebar, never leaves it, and reports its hidden subs
// by red dots, a "3x" count, a hover list and a ring. Drives the real sidebar
// at desktop and phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const PLAN = [
  { text: "Read the code", status: "done" },
  { text: "Write the header", status: "done" },
  { text: "Render the rows", status: "active" },
  { text: "Verify", status: "pending" },
  { text: "Polish", status: "pending" },
  { text: "Ship", status: "pending" },
] as const;

const CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: true, awaiting: null, ...over });

/** One main chat with four subs: two asking, one working with a plan, one finished. */
const SUBS = [
  sub("sub-footer", "Footer", 102),
  sub("sub-contact", "Contact", 103),
  sub("sub-skills", "Skills", 104, { progress: { plan: [...PLAN] as never, state_since: null } }),
  sub("sub-header", "Header", 105, { busy: false, awaiting: "done", subchat_finished: true }),
];
const MAIN = chat("main", "CV redesign", 101);
const PLAIN = chat("plain", "Plain chat", 110);
const EMPTY_MAIN = chat("empty", "Fresh main", 111);

const q = (n: number) => ({ question: `Question ${n}?`, header: `Q${n}`, options: [{ label: "Yes" }, { label: "No" }] });
let seq = 0;
const subPrompt = (sub: string, count: number) => ({
  id: `prompt-${sub}`, session_id: sub, display_session_id: "main", seq: ++seq,
  questions: Array.from({ length: count }, (_, i) => q(i + 1)),
});
const ownPrompt = (session: string, count: number) => ({
  id: `prompt-${session}`, session_id: session, seq: ++seq,
  questions: Array.from({ length: count }, (_, i) => q(i + 1)),
});

function invokeFor(sessions: unknown[], on: string[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: on,
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
  };
}

async function settle(page: Page): Promise<void> {
  // Unscoped `li`: a chat in the (collapsed) Closing group renders only its header.
  await page.locator("#sessions-list li").first().waitFor();
  await expect.poll(() => page.locator(".sessions-list .row-entering").count()).toBe(0);
  // The mode flags hydrate after boot and redraw the list; a mode-on chat's
  // ring/count/group is only right after that, and neither transport exposes a
  // "hydrated" signal to wait on, so give it a beat.
  await page.waitForTimeout(250);
}

async function mount(
  page: Page,
  size: { width: number; height: number },
  sessions: unknown[],
  on: string[] = ["main", "empty"],
  hidden: string[] = [],
): Promise<void> {
  await page.setViewportSize(size);
  if (hidden.length) {
    await page.addInitScript((ids) => localStorage.setItem("cc_hidden_sessions", JSON.stringify(ids)), hidden);
  }
  await mountView(page, { view: "sessions", invoke: invokeFor(sessions, on) });
  await settle(page);
}

const ALL = [MAIN, ...SUBS, PLAIN, EMPTY_MAIN];
const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const headers = (page: Page) => page.locator("#sessions-list li.session-group-header");
const headerTexts = async (page: Page) => (await headers(page).allTextContents()).map((t) => t.trim());
const dots = (scope: Locator) => scope.locator(".ask-dot");
const ringOf = (page: Page, id: string) => row(page, id).locator(".avatar-ring circle");

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / main chats sidebar (${label})`, () => {
    test("a mode-on chat sits in Main chats above everything, and a mode-off chat does not", async ({ page }) => {
      await mount(page, size, ALL);
      const texts = await headerTexts(page);
      expect(texts[0]).toBe("Main chats");
      expect(texts.slice(1)).not.toContain("Main chats");
      // The group holds both mode-on chats and the header comes first in the list.
      const order = await page.locator("#sessions-list li").evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.sessionId ?? (el.classList.contains("session-group-header") ? `#${el.textContent!.trim()}` : "?")));
      expect(order.slice(0, 3).sort()).toEqual(["#Main chats", "empty", "main"].sort());
      expect(order.indexOf("plain")).toBeGreaterThan(order.indexOf("main"));
      expect(order.indexOf("plain")).toBeGreaterThan(order.indexOf("empty"));
      // The subs have no row anywhere.
      await expect(page.locator('#sessions-list li[data-session-id^="sub-"]')).toHaveCount(0);
    });

    test("a main chat never changes group or Ctrl+N number when a sub asks", async ({ page }) => {
      await mount(page, size, ALL);
      const hintBefore = await row(page, "main").getAttribute("data-kbd-hint");
      const headersBefore = await headerTexts(page);
      expect(hintBefore).not.toBeNull();

      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 2)]);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
      await expect(row(page, "main")).toHaveAttribute("data-kbd-hint", hintBefore!);
      expect(await headerTexts(page)).toEqual(headersBefore.map((t) => t));
      // Still directly under the Main chats header, not under Input Needed.
      const group = await page.evaluate(() => {
        let cur = document.querySelector('#sessions-list li[data-session-id="main"]')!.previousElementSibling;
        while (cur && !cur.classList.contains("session-group-header")) cur = cur.previousElementSibling;
        return cur?.textContent?.trim();
      });
      expect(group).toBe("Main chats");
    });

    test("a mode-off chat is unaffected: its battery, plan arc and group are as before", async ({ page }) => {
      const plain = chat("plain", "Plain chat", 110, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: null } });
      await mount(page, size, [MAIN, ...SUBS, plain]);
      await expect(row(page, "plain").locator(".session-model-battery")).toHaveCount(1);
      await expect(row(page, "plain").locator(".session-sub-count")).toHaveCount(0);
      await expect(dots(row(page, "plain"))).toHaveCount(0);
      // A working plan chat still draws its arc over the dim track.
      await expect(ringOf(page, "plain")).toHaveCount(2);
      await expect(ringOf(page, "plain").nth(0)).toHaveClass(/is-track/);
      expect(await headerTexts(page)).toContain("In Progress");
    });

    test("one dot per asking sub, the main chat's own question included, none for working or finished subs", async ({ page }) => {
      await mount(page, size, ALL);
      await expect(dots(row(page, "main"))).toHaveCount(0);

      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1)]);
      await expect(dots(row(page, "main"))).toHaveCount(1);
      await fireEvent(page, "question-requested", [subPrompt("sub-contact", 3)]);
      await expect(dots(row(page, "main"))).toHaveCount(2);
      // The main chat's own question is one more dot.
      await fireEvent(page, "question-requested", [ownPrompt("main", 1)]);
      await expect(dots(row(page, "main"))).toHaveCount(3);
      // Skills works and Header finished: neither added a dot, and the dots sit beside the project name.
      await expect(row(page, "main").locator(".session-row-project .ask-dots")).toHaveCount(1);
      // A mode-off chat and a mode-on chat with no subs show none.
      await expect(dots(row(page, "plain"))).toHaveCount(0);
      await expect(dots(row(page, "empty"))).toHaveCount(0);
      await capture(page.locator("#sessions-list"), `main-chats-group-expanded-${label}`);
    });

    test("the dots stay visible with the group collapsed", async ({ page }) => {
      await mount(page, size, ALL);
      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1), subPrompt("sub-contact", 1)]);
      const header = headers(page).first();
      await expect(header).toContainText("Main chats");
      await expect(dots(header)).toHaveCount(2);

      await header.click();
      await expect(row(page, "main")).toHaveCount(0);
      await expect(row(page, "empty")).toHaveCount(0);
      await expect(dots(headers(page).first())).toHaveCount(2);
      await capture(page.locator("#sessions-list"), `main-chats-group-collapsed-${label}`);

      await headers(page).first().click();
      await expect(row(page, "main")).toHaveCount(1);
    });

    test("3x replaces the battery once there are subs, and a chat with none keeps its battery", async ({ page }) => {
      await mount(page, size, ALL);
      const chips = row(page, "main").locator(".session-chips");
      await expect(chips.locator(".session-sub-count")).toHaveText("4x");
      await expect(chips.locator(".session-model-battery")).toHaveCount(0);
      // Counts the finished sub too, and carries no word.
      await expect(chips).toHaveText(/^\s*4x\s*$/);

      await expect(row(page, "empty").locator(".session-model-battery")).toHaveCount(1);
      await expect(row(page, "empty").locator(".session-sub-count")).toHaveCount(0);
    });

    test("closing and hiding both take a main chat out of the group", async ({ page }) => {
      await mount(page, size, [chat("main", "CV redesign", 101, { closing: true }), ...SUBS.slice(0, 1)]);
      expect(await headerTexts(page)).not.toContain("Main chats");
      expect(await headerTexts(page)).toContain("Closing");
    });

    test("a hidden main chat leaves the group for the Hidden list", async ({ page }) => {
      test.skip(label === "phone", "the phone lists Hidden chats in the kebab menu, not the sidebar");
      await mount(page, size, ALL, ["main", "empty"], ["main"]);
      const texts = await headerTexts(page);
      expect(texts[0]).toBe("Main chats");
      await expect(row(page, "empty")).toHaveCount(1);
      // main is not under the Main chats header any more (Hidden is collapsed by default).
      await expect(row(page, "main")).toHaveCount(0);
      expect(texts.some((t) => t.startsWith("Hidden"))).toBe(true);
    });

    test("the ring: yellow, solid, no arc while the main agent works", async ({ page }) => {
      const working = chat("main", "CV redesign", 101, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: null } });
      await mount(page, size, [working, ...SUBS]);
      // The same plan on a plain chat would draw an arc over a track; a main chat draws one ring.
      await expect(ringOf(page, "main")).toHaveCount(1);
      await expect(ringOf(page, "main")).toHaveAttribute("data-tone", "working");
      await expect(ringOf(page, "main")).not.toHaveClass(/is-track/);
    });

    test("the ring: green only once every sub has finished", async ({ page }) => {
      const finished = [
        sub("sub-a", "A", 102, { busy: false, awaiting: "done", subchat_finished: true }),
        sub("sub-b", "B", 103, { busy: false, awaiting: "done", subchat_finished: true }),
      ];
      await mount(page, size, [MAIN, ...finished]);
      await expect(ringOf(page, "main")).toHaveCount(1);
      await expect(ringOf(page, "main")).toHaveAttribute("data-tone", "done");
    });

    test("the ring: no ring while any sub is still working, and none for a main chat with no subs", async ({ page }) => {
      const finished = sub("sub-a", "A", 102, { busy: false, awaiting: "done", subchat_finished: true });
      await mount(page, size, [MAIN, finished, sub("sub-b", "B", 103), EMPTY_MAIN]);
      // An idle, read main chat with a sub still working: no ring at all.
      await expect(row(page, "main").locator(".avatar-ring")).toHaveCount(0);
      // No subs yet is not "all finished".
      await expect(row(page, "empty").locator(".avatar-ring")).toHaveCount(0);
    });

    test("a parked question keeps the attention ring on a main chat", async ({ page }) => {
      await mount(page, size, ALL);
      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1)]);
      await expect(ringOf(page, "main")).toHaveAttribute("data-tone", "attention");
    });
  });
}

test.describe("view-harness / main chats sidebar (desktop hover)", () => {
  test("the hover card lists every sub with its dot colour and progress", async ({ page }) => {
    await mount(page, DESKTOP, ALL);
    await fireEvent(page, "question-requested", [subPrompt("sub-footer", 5), subPrompt("sub-contact", 1)]);
    await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);

    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    const rows = card.locator(".hc-subrow");
    await expect(rows).toHaveCount(4);
    // Asking first, then working, then finished.
    await expect(rows.nth(0)).toContainText("Footer");
    await expect(rows.nth(0)).toContainText("0 of 5 answered");
    await expect(rows.nth(1)).toContainText("Contact");
    await expect(rows.nth(1)).toContainText("0 of 1 answered");
    await expect(rows.nth(2)).toContainText("Skills");
    await expect(rows.nth(2)).toContainText("step 3 of 6");
    await expect(rows.nth(3)).toContainText("Header");
    await expect(rows.nth(3)).toContainText("finished");

    const colours = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(".hc-dot")!).backgroundColor));
    const probe = await page.evaluate(() => {
      const paint = (v: string) => { const d = document.createElement("i"); d.style.background = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return { red: paint("--st-question"), yellow: paint("--st-working"), green: paint("--st-done") };
    });
    expect(colours).toEqual([probe.red, probe.red, probe.yellow, probe.green]);
    // The chat's own state and plan blocks give way to the sub list.
    await expect(card.locator(".hc-state")).toHaveCount(0);
    await capture(page.locator("body"), "main-chats-hover-card");
  });

  test("a sub held behind another is a yellow row that says what it waits for, and keeps the ring off green", async ({ page }) => {
    // `after`: the row exists and counts, but nothing has started it.
    const queued = sub("sub-queued", "Footer links", 106, {
      busy: false,
      progress: { plan: null, state_since: null, waiting_for: "waiting for Header" },
    });
    const finished = sub("sub-header", "Header", 105, { busy: false, awaiting: "done", subchat_finished: true });
    await mount(page, DESKTOP, [MAIN, finished, queued]);
    // Every other sub finished and one is queued: nothing is "all finished" yet.
    await expect(row(page, "main")).not.toHaveAttribute("data-st", "st-done");
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    const rows = card.locator(".hc-subrow");
    await expect(rows).toHaveCount(2);
    // Queued sits above finished.
    await expect(rows.nth(0)).toContainText("Footer links");
    await expect(rows.nth(0)).toContainText("waiting for Header");
    await expect(rows.nth(0)).toHaveClass(/is-queued/);
    await expect(rows.nth(1)).toContainText("finished");
    const colours = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(".hc-dot")!).backgroundColor));
    const probe = await page.evaluate(() => {
      const paint = (v: string) => { const d = document.createElement("i"); d.style.background = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return { yellow: paint("--st-working"), green: paint("--st-done") };
    });
    expect(colours).toEqual([probe.yellow, probe.green]);
    await capture(page.locator("body"), "main-chats-hover-card-queued");
  });

  test("the main chat's own question shows as a This chat row, and a chat with no subs keeps the plain card", async ({ page }) => {
    await mount(page, DESKTOP, ALL);
    await fireEvent(page, "question-requested", [ownPrompt("main", 2)]);
    let box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card.locator(".hc-subrow").first()).toContainText("This chat");
    await expect(card.locator(".hc-subrow").first()).toContainText("0 of 2 answered");

    await page.mouse.move(box.x + 6, box.y + 700);
    await expect(card).toBeHidden();
    box = (await row(page, "empty").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await expect(card).toBeVisible();
    await expect(card.locator(".hc-subrow")).toHaveCount(0);
    await expect(card.locator(".hc-state")).toHaveCount(1);
  });

  test("a mode-off chat's hover card is unchanged", async ({ page }) => {
    const plain = chat("plain", "Plain chat", 110, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: null } });
    await mount(page, DESKTOP, [MAIN, ...SUBS, plain]);
    const box = (await row(page, "plain").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toContainText("Plan: 2 of 6 steps");
    await expect(card.locator(".hc-subrow")).toHaveCount(0);
  });
});

test.describe("view-harness / main chats sidebar (phone transport)", () => {
  // The phone has no Tauri event bus: it reads list_subchats_on and polls
  // list_pending_prompts over the remote RPC, so this is the path a paired phone takes.
  test("the group, its dots and 3x show on the phone, with no hover card", async ({ page }) => {
    const pending = [subPrompt("sub-footer", 1), subPrompt("sub-contact", 2)];
    await page.setViewportSize(PHONE);
    await mountViewPhone(page, {
      view: "sessions",
      invoke: {
        ...invokeFor(ALL, ["main", "empty"]),
        list_pending_prompts: pending.map((p) => ({ id: p.id, event: "question-requested", durable: true, payload: p })),
      },
    });
    await settle(page);
    expect((await headerTexts(page))[0]).toBe("Main chats");
    await expect(row(page, "main").locator(".session-sub-count")).toHaveText("4x");
    await expect(dots(row(page, "main"))).toHaveCount(2);
    await expect(dots(headers(page).first())).toHaveCount(2);
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator(".cc-row-card")).toHaveCount(0);
  });
});
