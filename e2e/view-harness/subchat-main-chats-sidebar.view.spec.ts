// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-21 (the open chat's viewed mark is renewed every minute by a heartbeat in chat-seen.ts, started from sidebar.ts): nothing this spec asserts changed, and it passes in the run of every spec that depends on sidebar.ts.
// Reviewed 2026-11-14 (pc-1740, the sidebar project filter rail and the phone Filter by project submenu are removed): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-12 (honest sub states): the main chat's ring no longer stays green once every sub finished and the chat is read, and glows while any sub works; a queued sub's hover dot is dim; the three hover tests expected a finished sub's row, which the hover has not listed since it keeps to what is happening now (main-chat.ts hoverRows), so they now expect only the unfinished rows.
// Reviewed 2026-11-12 (project main chat): the sidebar lists one Main chats row per project; this spec's rows have no project pointer, so every mode-on chat lists as before. Its three desktop-hover tests that expect a finished sub in the hover card were already red on HEAD (main-chat.ts leaves finished subs out of `hoverRows`) and still are; the rest pass.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed. Its failing tests fail the same way on the commit before this change.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-05: a closing main chat with a running sub now stays in Main chats (it is the Wait for them choice); the closing test here uses a finished sub, everything else holds.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: main-chat.ts's progress text says paused or rate limited for a frozen or rate-limited sub instead of working; this spec's subs are neither, so its contract holds and it passes.
// Reviewed 2026-11-05: main-chat.ts and the hover card gained a "queued" kind for a sub held for the writer slot; this spec has no queued sub, so asking/working/finished rows are unchanged, and it passed after the change. The queued row is covered in subchat-writer-slot.view.spec.ts.
// Reviewed 2026-11-05: a chat with subs keeps its sub summary after the mode is turned off (the group still follows the mode), a closing sub no longer reads as finished for the ring, and each hover row names the sub's tier; the existing tests keep their contract and pass.
// Reviewed 2026-11-16 (chat heads, pc-1769): the sidebar's Main chats group, red dots and the 3x count are now the chat heads' kind, red count and an N subs hover fact; the group, closing and hidden tests assert the stack instead of group headers.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/sidebar.ts, src/views/sessions/sidebar-ring.ts, src/views/sessions/main-chat.ts, src/views/sessions/sidebar-hover-card.ts, src/views/sessions/sidebar-hover-card-html.ts, src/views/sessions/permission-modal/gating.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Subchats step 13, on the chat heads: a chat with Use subchats on is a "main" head, never
// leaves the stack, and reports its hidden subs by a red count, an "N subs" hover fact, a
// hover list and a ring. Drives the real stack at desktop and phone width.

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
  await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
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
const kindOf = (page: Page, id: string) => row(page, id).getAttribute("data-head-kind");
const stackIds = (page: Page) =>
  page.locator("#sessions-list li.chat-head:not(.chat-head-control)[data-session-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.sessionId!));
/** The red number on a head: how many cards wait on Joe behind it (the head's one number, red). */
const waiting = async (scope: Locator): Promise<number> => {
  const c = scope.locator(".chat-head-tag .ht-n.is-red");
  return (await c.count()) === 0 ? 0 : Number((await c.textContent())!.trim());
};
const ringOf = (page: Page, id: string) => row(page, id).locator(".avatar-ring");
const facts = (page: Page, id: string) => row(page, id).getAttribute("data-facts");

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / main chats sidebar (${label})`, () => {
    test("a mode-on chat is a main head and a mode-off chat is a plain one, and no sub has a head", async ({ page }) => {
      await mount(page, size, ALL);
      expect(await kindOf(page, "main")).toBe("main");
      expect(await kindOf(page, "empty")).toBe("main");
      expect(await kindOf(page, "plain")).toBe("chat");
      await expect(page.locator('#sessions-list li[data-session-id^="sub-"]')).toHaveCount(0);
    });

    test("a main chat never changes place or Ctrl+N number when a sub asks", async ({ page }) => {
      await mount(page, size, ALL);
      const hintBefore = await row(page, "main").getAttribute("data-kbd-hint");
      const orderBefore = await stackIds(page);
      expect(hintBefore).not.toBeNull();

      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 2)]);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
      await expect(row(page, "main")).toHaveAttribute("data-kbd-hint", hintBefore!);
      expect(await stackIds(page)).toEqual(orderBefore);
    });

    test("a mode-off chat is unaffected: its battery is as before and it draws no ring", async ({ page }) => {
      const plain = chat("plain", "Plain chat", 110, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: null } });
      await mount(page, size, [MAIN, ...SUBS, plain]);
      await expect(row(page, "plain").locator(".chat-head-battery")).toHaveCount(1);
      expect(await facts(page, "plain")).not.toContain("subs");
      expect(await waiting(row(page, "plain"))).toBe(0);
      // A working plan chat draws no arc either: a head says nothing about work or plan progress.
      await expect(ringOf(page, "plain")).toHaveCount(0);
    });

    test("the red count adds one per asking sub and the main chat's own question, none for working or finished subs", async ({ page }) => {
      await mount(page, size, ALL);
      expect(await waiting(row(page, "main"))).toBe(0);

      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(1);
      await fireEvent(page, "question-requested", [subPrompt("sub-contact", 3)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(2);
      // The main chat's own question is one more.
      await fireEvent(page, "question-requested", [ownPrompt("main", 1)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(3);
      // Skills works and Header finished: neither added to the count. A mode-off chat and a mode-on chat with no subs show none.
      expect(await waiting(row(page, "plain"))).toBe(0);
      expect(await waiting(row(page, "empty"))).toBe(0);
      await capture(page.locator("#sessions-list"), `main-chats-heads-asking-${label}`);
    });

    test("the red count is also on the closed toggle", async ({ page }) => {
      await mount(page, size, ALL);
      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1), subPrompt("sub-contact", 1)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(2);
      const toggle = page.locator("#sessions-list li[data-heads-toggle]");
      await toggle.click();
      await expect(row(page, "main")).toHaveCount(0);
      await expect(toggle.locator(".chat-head-count")).toHaveText("2");
      await capture(page.locator("#sessions-list"), `main-chats-heads-closed-${label}`);

      await toggle.click();
      await expect(row(page, "main")).toHaveCount(1);
    });

    test("the sub count is a hover fact that replaces the battery once there are subs, and a chat with none keeps its battery", async ({ page }) => {
      await mount(page, size, ALL);
      expect(await facts(page, "main")).toBe("4 subs");
      await expect(row(page, "main").locator(".chat-head-battery")).toHaveCount(0);

      await expect(row(page, "empty").locator(".chat-head-battery")).toHaveCount(1);
      expect(await facts(page, "empty")).toBe("");
    });

    test("a chat turned off mid-run keeps its count and sub fact, and the count still routes", async ({ page }) => {
      // Mode off for every chat, but "main" still has four subs from before.
      await mount(page, size, ALL, []);
      expect(await kindOf(page, "main")).toBe("chat");
      expect(await facts(page, "main")).toBe("4 subs");
      await expect(row(page, "main").locator(".chat-head-battery")).toHaveCount(0);
      // A chat that never had subs is untouched.
      await expect(row(page, "plain").locator(".chat-head-battery")).toHaveCount(1);

      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 2), subPrompt("sub-contact", 1)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(2);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
      await capture(page.locator("#sessions-list"), `mode-off-with-subs-${label}`);
    });

    test("a closing main chat stays in the stack with the closing class and no ring", async ({ page }) => {
      // Every sub finished: a close in progress is on its way out. (While a sub still runs, the daemon's
      // closing flag is the "Wait for them" choice: subchat-second-run.)
      await mount(page, size, [chat("main", "CV redesign", 101, { closing: true }), SUBS[3]!]);
      await expect(row(page, "main")).toHaveClass(/closing/);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-closing");
      await expect(ringOf(page, "main")).toHaveCount(0);
    });

    test("a hidden main chat leaves the stack for the hidden head", async ({ page }) => {
      await mount(page, size, ALL, ["main", "empty"], ["main"]);
      await expect(row(page, "empty")).toHaveCount(1);
      await expect(row(page, "main")).toHaveCount(0);
      const hidden = page.locator("#sessions-list li[data-heads-hidden]");
      await expect(hidden).toHaveCount(1);
      await hidden.click();
      await expect(row(page, "main")).toHaveCount(1);
      await expect(row(page, "empty")).toHaveCount(0);
    });

    // Joe 2026-11-20: "i still see yellow circles around chat bubbles... i dont want it". Working and
    // plan progress are not drawn on a circle at all (V2 priority badge).
    test("a main chat draws no ring while it works, while subs work, or when it is read and idle", async ({ page }) => {
      const working = chat("main", "CV redesign", 101, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: null } });
      await mount(page, size, [working, ...SUBS, EMPTY_MAIN]);
      await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-working");
    });

    test("a parked question gives a main chat one red number and the attention state", async ({ page }) => {
      await mount(page, size, ALL);
      await fireEvent(page, "question-requested", [subPrompt("sub-footer", 1)]);
      await expect.poll(() => waiting(row(page, "main"))).toBe(1);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
      await expect(ringOf(page, "main")).toHaveCount(0);
      await expect(row(page, "main").locator(".ht-n")).toHaveCount(1);
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
    // The hover is about what is happening now: the finished Header sub is not listed (it is resumable from the header list).
    await expect(rows).toHaveCount(3);
    // Asking first, then working.
    await expect(rows.nth(0)).toContainText("Footer");
    await expect(rows.nth(0)).toContainText("0 of 5 answered");
    await expect(rows.nth(1)).toContainText("Contact");
    await expect(rows.nth(1)).toContainText("0 of 1 answered");
    await expect(rows.nth(2)).toContainText("Skills");
    await expect(rows.nth(2)).toContainText("step 3 of 6");

    const colours = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(".hc-dot")!).backgroundColor));
    const probe = await page.evaluate(() => {
      const paint = (v: string) => { const d = document.createElement("i"); d.style.background = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return { red: paint("--st-question"), yellow: paint("--st-working") };
    });
    expect(colours).toEqual([probe.red, probe.red, probe.yellow]);
    // The chat's own state and plan blocks give way to the sub list.
    await expect(card.locator(".hc-state")).toHaveCount(0);
    await capture(page.locator("body"), "main-chats-hover-card");
  });

  test("a sub held behind another is a dim row that says what it waits for, and keeps the ring off green", async ({ page }) => {
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
    // Only the queued sub: the finished one is not listed.
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("Footer links");
    await expect(rows.nth(0)).toContainText("waiting for Header");
    await expect(rows.nth(0)).toHaveClass(/is-queued/);
    const colours = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(".hc-dot")!).backgroundColor));
    const probe = await page.evaluate(() => {
      const paint = (v: string) => { const d = document.createElement("i"); d.style.background = `var(${v})`; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return { dim: paint("--color-text-muted"), yellow: paint("--st-working") };
    });
    // Not progressing: dim, never the working yellow.
    expect(colours).toEqual([probe.dim]);
    expect(colours[0]).not.toBe(probe.yellow);
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

  test("the hover card names each sub's tier beside its name, and a mode-off chat with subs still gets the list", async ({ page }) => {
    const sonnet = sub("sub-footer", "Footer", 102, { model: "claude-sonnet-4-5", effort: "medium" });
    const opus = sub("sub-header", "Header", 105);
    await mount(page, DESKTOP, [MAIN, sonnet, opus], []);
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    const rows = card.locator(".hc-subrow");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".hc-tier")).toHaveText("Sonnet medium");
    await expect(rows.nth(1).locator(".hc-tier")).toHaveText("Opus high");
    await capture(page.locator("body"), "main-chats-hover-card-tier");
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
  test("the main head, its red count and its sub fact show on the phone, with no hover card", async ({ page }) => {
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
    expect(await kindOf(page, "main")).toBe("main");
    expect(await facts(page, "main")).toBe("4 subs");
    await expect.poll(() => waiting(row(page, "main"))).toBe(2);
    const box = (await row(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator(".cc-row-card")).toHaveCount(0);
  });
});
