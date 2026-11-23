// Reviewed 2026-11-23 (the No project dashboard door lists every main chat there, put-away ones too, and the Open main chat button passes its element on): a project's single door is unchanged and passes.
// Reviewed 2026-11-23 (No project main chats each stand alone): only a draft in the No project (vault) folder and its own main chats changed (covered in scratch-main-chat.view.spec.ts); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-22 (Turn into a project, pc-1806 step 8): chat-menu-items.ts gained one menu item, shown only for a No project chat; nothing this spec asserts changed, and it passes in the run of every spec that depends on that file.
// Reviewed 2026-11-21 (the closed toggle's number no longer counts hidden chats, put-away ones included): the waiting-card case asserts that now.
// asserts: src/views/sessions/put-away.ts, src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/close-chat.ts, src/views/sessions/chat-menu.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/chat-menu-ctx.ts, src/views/sessions/sidebar-ctx-menu.ts, src/views/sessions/sidebar-hover-card.ts, src/views/sessions/active-session.ts, src/views/sessions/active-session-composer.ts, src/views/sessions/subchat-view.ts, src/views/sessions/project-main-chats.ts, src/views/sessions/sessions.css, src/views/command-palette/sources.ts, src/shared/chat/composer.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Put away (pc-1806 step 5): closing a project's main chat puts it away. It leaves the stack for the
// Hidden view with a Paused badge, opens read-only without waking anything, adds none of its waiting
// cards to the closed toggle's number (a hidden chat draws none), and its Close reads "Put away" in the menu and on Ctrl+W. Drives the real
// sessions view at desktop and phone width. History never lists it (an open row): daemon test
// `a_put_away_main_chat_is_never_a_past_chat` in ipc/chat/history_list.rs.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/Projects/cv-site";
const AWAY = "2026-11-21T10:00:00Z";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, ...over });

const PROJECTS = [{ id: "p1", path: CWD, name: "cv-site", main_chat_id: "main" }];
const OTHER = sessionInstance({ session_id: "plain", name: "Plain chat", pid: 110, cwd: "C:/Projects/other", project_id: "p2" });
const MAIN = chat("main", "CV redesign", 101);
const AWAY_MAIN = chat("main", "CV redesign", 101, { hidden_at: AWAY, frozen: true });
// The pause froze the subs that had work left; a finished one stays finished.
const SUBS = [
  sub("sub-footer", "Footer", 102, { frozen: true }),
  sub("sub-contact", "Contact", 103, { frozen: true }),
  sub("sub-done", "Header", 104, { subchat_finished: true, awaiting: "done" }),
];

function invokeFor(sessions: unknown[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_projects: PROJECTS,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_slash_commands: [],
    list_auto_accept: [],
    confirm_question_rendered: null,
    clear_session: true,
    cancel_turn: null,
    send_message: null,
    unfreeze_session: null,
  };
}

async function mount(page: Page, phone: boolean, size: { width: number; height: number }, sessions: unknown[]): Promise<void> {
  await page.setViewportSize(size);
  await (phone ? mountViewPhone : mountView)(page, { view: "sessions", invoke: invokeFor(sessions) });
  await page.locator("#sessions-list li").first().waitFor();
  // The pointers and the mode flags hydrate after boot and redraw the list.
  await page.waitForTimeout(300);
}

const head = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const hiddenHead = (page: Page) => page.locator("#sessions-list li[data-heads-hidden]");
const toggleHead = (page: Page) => page.locator("#sessions-list li[data-heads-toggle]");
const title = (page: Page) => page.locator("#session-pane .session-header .title");
const calls = async (page: Page, cmd: string) => (await invokeCalls(page)).filter((c) => c.cmd === cmd);

for (const [label, size, phone] of [["desktop", DESKTOP, false], ["phone", PHONE, true]] as const) {
  test.describe(`view-harness / put away (${label})`, () => {
    test("a put-away main chat leaves the stack for the Hidden view, where its head wears the Paused badge", async ({ page }) => {
      await mount(page, phone, size, [AWAY_MAIN, ...SUBS, OTHER]);
      await expect(head(page, "main")).toHaveCount(0);
      await expect(head(page, "plain")).toBeVisible();
      await expect(hiddenHead(page)).toBeVisible();
      await expect(hiddenHead(page).locator(".chat-head-count")).toHaveText("1");
      await capture(page, `put-away-stack-${label}`);

      await hiddenHead(page).click();
      await expect(head(page, "main")).toBeVisible();
      await expect(head(page, "main")).toHaveClass(/is-put-away/);
      await expect(head(page, "main").locator(".chat-head-paused")).toBeVisible();
      await expect(head(page, "main").locator(".chat-head-paused")).toHaveAttribute("aria-label", "Paused");
      // A hidden chat takes no Ctrl+N number.
      await expect(head(page, "main")).not.toHaveAttribute("data-kbd-hint", /.+/);
      await page.mouse.move(size.width - 20, size.height - 20);
      await page.waitForTimeout(700);
      await capture(page, `put-away-hidden-view-${label}`);
    });

    test("a chat that is not put away has no Paused badge and the closed toggle shows no count", async ({ page }) => {
      await mount(page, phone, size, [MAIN, ...SUBS, OTHER]);
      await expect(head(page, "main")).toBeVisible();
      await expect(head(page, "main").locator(".chat-head-paused")).toHaveCount(0);
      await expect(hiddenHead(page)).toHaveCount(0);
    });

    test("a card waiting behind a put-away chat adds nothing to the closed toggle", async ({ page }) => {
      await mount(page, phone, size, [{ ...AWAY_MAIN, awaiting: "question" }, ...SUBS, OTHER]);
      await toggleHead(page).click();
      await expect(head(page, "plain")).toHaveCount(0);
      await expect(toggleHead(page).locator(".chat-head-count")).toHaveCount(0);
      await capture(page, `put-away-waiting-counted-${label}`);
    });

    test("opening it is read-only: a banner says why, the composer is off, and nothing wakes it", async ({ page }) => {
      const rpcMethods: string[] = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/api/rpc")) rpcMethods.push((r.postDataJSON() as { method: string }).method);
      });
      await mount(page, phone, size, [AWAY_MAIN, ...SUBS, OTHER]);
      await hiddenHead(page).click();
      await head(page, "main").click();
      await expect(title(page)).toHaveText("CV redesign");
      const banner = page.locator("#session-pane .readonly-banner.put-away-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Put away, 2 subs paused");
      await expect(banner).toContainText("Read-only");
      // The desktop's one button is the way back (Reopen, pc-1806 step 6); the phone has none, a reopen is a desktop-pipe call.
      if (phone) await expect(banner.locator("button")).toHaveCount(0);
      else await expect(banner.locator("button")).toHaveText(["Reopen"]);
      await expect(page.locator(".session-composer .composer-textarea")).toBeDisabled();
      await expect(page.locator(".session-composer .composer-textarea")).toHaveAttribute("placeholder", /Put away/);
      await expect(page.locator(".session-composer .composer-send")).toBeDisabled();
      await page.waitForTimeout(400);
      // The phone has no Tauri mock to read calls from: its daemon calls are the /api/rpc requests.
      const sent = phone ? rpcMethods : (await invokeCalls(page)).map((c) => c.cmd);
      expect(sent).not.toContain("unfreeze_session");
      expect(sent).not.toContain("send_message");
      // The first head column floats over the pane's left edge: the banner's words start right of it.
      if (!phone) expect((await banner.locator("strong").boundingBox())!.x).toBeGreaterThanOrEqual(68);
      await page.waitForTimeout(500);
      await capture(page, `put-away-read-only-${label}`);
    });
  });
}

test.describe("view-harness / put away (desktop only: hover, menu and keys)", () => {
  test("the hover card says it is put away and how many subs are paused", async ({ page }) => {
    await mount(page, false, DESKTOP, [AWAY_MAIN, ...SUBS, OTHER]);
    await hiddenHead(page).click();
    // The heads of the Hidden view enter with a short scale-in: hover only once they settled.
    await page.waitForTimeout(600);
    await page.mouse.move(600, 400);
    const box = (await head(page, "main").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Put away, 2 subs paused");
    await capture(page.locator("body"), "put-away-hover-card");
  });

  test("hovering a put-away head moves nothing: its box is the same with the pointer on it", async ({ page }) => {
    await mount(page, false, DESKTOP, [AWAY_MAIN, ...SUBS, OTHER]);
    await hiddenHead(page).click();
    await page.mouse.move(600, 400);
    // A loaded machine can stretch the heads' scale-in: measure only once two reads agree.
    let last = "";
    await expect.poll(async () => {
      const b = JSON.stringify(await head(page, "main").boundingBox());
      const stable = b === last;
      last = b;
      return stable;
    }, { intervals: [250] }).toBe(true);
    const before = (await head(page, "main").boundingBox())!;
    // The head's face nudges right on hover by design (chat-heads.css), and the badge rides on the face:
    // the head's own box and the badge's place on the face must not change.
    const onFace = async () => {
      const f = (await head(page, "main").locator(".chat-head-face").boundingBox())!;
      const b = (await head(page, "main").locator(".chat-head-paused").boundingBox())!;
      return { x: b.x - f.x, y: b.y - f.y, w: b.width, h: b.height };
    };
    const badgeBefore = await onFace();
    await page.mouse.move(before.x + 6, before.y + before.height / 2);
    await page.waitForTimeout(400);
    const after = (await head(page, "main").boundingBox())!;
    expect(after).toEqual(before);
    expect(await onFace()).toEqual(badgeBefore);
  });

  test("a project's main chat has a Put away menu item, and clicking it asks the daemon to close it", async ({ page }) => {
    await mount(page, false, DESKTOP, [MAIN, ...SUBS, OTHER]);
    await head(page, "main").click({ button: "right" });
    const menu = page.locator(".session-ctx-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".smore-item")).toHaveText(["Copy PID", "Hide chat", "Put away"]);
    await expect(menu.locator(".smore-danger")).toHaveCount(0);
    await capture(page, "put-away-menu");
    await menu.locator(".smore-item", { hasText: "Put away" }).click();
    await expect.poll(async () => (await calls(page, "clear_session")).length).toBe(1);
    expect((await calls(page, "clear_session"))[0]!.args).toEqual({ sessionId: "main" });
    // The daemon held it (true): no cancel, and the chat is not reported closed.
    expect(await calls(page, "cancel_turn")).toEqual([]);
    await expect(page.locator(".toast")).toContainText("away");
  });

  test("any other chat still says Close session", async ({ page }) => {
    await mount(page, false, DESKTOP, [MAIN, OTHER]);
    await head(page, "plain").click({ button: "right" });
    await expect(page.locator(".session-ctx-menu .smore-item")).toHaveText(["Copy PID", "Hide chat", "Close session"]);
  });

  test("an already put-away chat's menu has no close item and its Hide is off", async ({ page }) => {
    await mount(page, false, DESKTOP, [AWAY_MAIN, ...SUBS, OTHER]);
    await hiddenHead(page).click();
    await head(page, "main").click({ button: "right" });
    const items = page.locator(".session-ctx-menu .smore-item");
    await expect(items).toHaveText(["Copy PID", "Hide chat"]);
    await expect(items.nth(1)).toHaveClass(/is-disabled/);
  });

  test("Ctrl+W on the main chat puts it away at once, with no confirm dialog", async ({ page }) => {
    await mount(page, false, DESKTOP, [MAIN, ...SUBS, OTHER]);
    await head(page, "main").click();
    await expect(title(page)).toHaveText("CV redesign");
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Control+w");
    await expect.poll(async () => (await calls(page, "clear_session")).length).toBe(1);
    await expect(page.locator(".app-confirm-overlay")).toHaveCount(0);
    expect(await calls(page, "cancel_turn")).toEqual([]);
  });

  test("Ctrl+W on any other chat is still the plain Close prompt", async ({ page }) => {
    await mount(page, false, DESKTOP, [MAIN, OTHER]);
    await head(page, "plain").click();
    await expect(title(page)).toHaveText("Plain chat");
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Control+w");
    await expect(page.getByText("Close this chat?")).toBeVisible();
    await expect(page.locator(".app-confirm-ok")).toHaveText("Close");
  });
});

test.describe("view-harness / put away (phone: close wording)", () => {
  test("a main chat's header menu says Put away on the phone too", async ({ page }) => {
    await mount(page, true, PHONE, [MAIN, ...SUBS, OTHER]);
    await head(page, "main").click();
    await expect(title(page)).toHaveText("CV redesign");
    await page.locator("#session-pane .session-header .more-btn, #session-pane .session-header [aria-label='More']").first().click();
    await expect(page.locator(".smore-item", { hasText: "Put away" })).toBeVisible();
    await expect(page.locator(".smore-item", { hasText: "Close session" })).toHaveCount(0);
    await capture(page, "put-away-phone-menu");
  });
});
