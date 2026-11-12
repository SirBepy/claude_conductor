// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome; a sub card's Close calls closeChat): nothing this spec asserts changed. It passes.
// asserts: src/views/sessions/draft-subchats.ts, src/views/sessions/project-main-chats.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/sidebar-entries.ts, src/views/sessions/sessions-wiring.ts, src/views/sessions/sessions-initial-load.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A project knows its main chat (D1): a new chat in a project that has a live main
// chat shows "Goes to <title>, <project>'s main chat" where Use subchats sits, with a
// Plain chat instead switch; sending goes to that main chat. The sidebar's Main chats
// group lists one row per project.

const CWD = "C:/Projects/alpha";
const OTHER_CWD = "C:/Projects/beta";

const MAIN = sessionInstance({ session_id: "main-1", name: "CV redesign", pid: 101, cwd: CWD, project_id: "p-alpha", busy: false, awaiting: "done" });
const OLDER_MAIN = sessionInstance({ session_id: "main-0", name: "Older main", pid: 100, cwd: CWD, project_id: "p-alpha", busy: false, awaiting: "done" });
const BETA_MAIN = sessionInstance({ session_id: "beta-main", name: "Beta work", pid: 102, cwd: OTHER_CWD, project_id: "p-beta", busy: false, awaiting: "done" });
const PLAIN = sessionInstance({ session_id: "plain", name: "Plain chat", pid: 103, cwd: CWD, project_id: "p-alpha", busy: false, awaiting: "done" });

const PROJECTS = [
  { id: "p-alpha", path: CWD, name: "alpha", default_model: null, default_effort: null, main_chat_id: "main-1" },
  { id: "p-beta", path: OTHER_CWD, name: "beta", default_model: null, default_effort: null, main_chat_id: "beta-main" },
];

function invoke(sessions: unknown[], on: string[], projects: unknown[] = PROJECTS) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: on,
    list_projects: projects,
    // A group's dashboard has no settings rail, so the slot is the row above the box.
    dashboard_list_targets: [{
      target: { kind: "group", id: "g-alpha", name: "alpha", repos: [{ cwd: CWD, name: "alpha", project_id: null }] },
      last_active_ms: 0, live_count: 0, question_count: 0, working_count: 0,
    }],
    start_session: "real-new",
    send_message: null,
    set_auto_accept: null,
    set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
    clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    context_status: null,
    list_slash_commands: [],
    list_auto_accept: [],
  };
}

async function openDraft(page: Page, sessions: unknown[], on: string[], projects?: unknown[]): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { view: "sessions", invoke: invoke(sessions, on, projects) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: true });
  });
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

const route = (page: Page) => page.locator("#session-pane .draft-main-route");
const useRow = (page: Page) => page.locator("#session-pane .draft-subchats");
const plainSwitch = (page: Page) => route(page).locator(".slider");
const send = async (page: Page, text: string): Promise<void> => {
  await page.locator("#session-pane .session-composer .composer-textarea").fill(text);
  await page.locator("#session-pane .session-composer .composer-send").click();
};

test.describe("view-harness / a new chat goes to the project's main chat", () => {
  test("the draft shows where it goes in place of Use subchats", async ({ page }) => {
    await openDraft(page, [MAIN, PLAIN], ["main-1"]);
    await expect(route(page)).toBeVisible();
    await expect(route(page).locator(".dmr-line")).toHaveText("Goes to CV redesign, alpha's main chat");
    await expect(route(page).locator("input")).not.toBeChecked();
    await expect(useRow(page)).toBeHidden();
    await capture(page.locator("#session-pane"), "draft-goes-to-main-chat");
  });

  test("sending goes to the main chat, starts nothing, and opens that chat", async ({ page }) => {
    await openDraft(page, [MAIN, PLAIN], ["main-1"]);
    await send(page, "add a contact form");
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(true);
    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "start_session")).toBe(false);
    const sent = calls.find((c) => c.cmd === "send_message")!.args as { sessionId: string };
    expect(sent.sessionId).toBe("main-1");
    // The draft is gone and the main chat is the open pane.
    await expect(page.locator("#session-pane .draft-main-route")).toHaveCount(0);
    await expect(page.locator('#sessions-list li[data-session-id="main-1"]')).toHaveClass(/active/);
  });

  test("a frozen main chat is woken before the message goes to it", async ({ page }) => {
    await openDraft(page, [{ ...MAIN, frozen: true }, PLAIN], ["main-1"]);
    await page.evaluate(() => {
      const w = window as unknown as { __ccInvokeCalls: unknown[]; __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
      const core = w.__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) => {
        if (cmd !== "unfreeze_session") return orig(cmd, args);
        w.__ccInvokeCalls.push({ cmd, args });
        return Promise.resolve(null);
      };
    });
    await send(page, "wake up and add a footer");
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(true);
    const cmds = (await invokeCalls(page)).map((c) => c.cmd);
    expect(cmds.indexOf("unfreeze_session")).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf("unfreeze_session")).toBeLessThan(cmds.indexOf("send_message"));
  });

  test("Plain chat instead starts a chat of its own with the mode off", async ({ page }) => {
    await openDraft(page, [MAIN, PLAIN], ["main-1"]);
    await plainSwitch(page).click();
    await expect(route(page).locator("input")).toBeChecked();
    await expect(route(page).locator(".dmr-line")).toHaveText("A plain chat, not alpha's main chat");
    await capture(page.locator("#session-pane"), "draft-plain-chat-instead");
    await send(page, "quick question");
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "start_session")).toBe(true);
    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "send_message")).toBe(false);
    expect(calls.find((c) => c.cmd === "start_session")!.args).toMatchObject({ subchatsOn: false });
  });

  test("a project with no main chat keeps the Use subchats switch and starts its own chat", async ({ page }) => {
    await openDraft(page, [PLAIN], [], [{ ...PROJECTS[0], main_chat_id: null }]);
    await expect(useRow(page)).toBeVisible();
    await expect(route(page)).toBeHidden();
    await send(page, "build the site");
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "start_session")).toBe(true);
    expect((await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(false);
  });

  test("a draft opened with its own message (a card chat, /pickup) starts a fresh chat, not a message to the main chat", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, { view: "sessions", invoke: invoke([MAIN, PLAIN], ["main-1"]) });
    await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
    await page.evaluate(() => {
      (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
        .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: true, autoAccept: false, initialMessage: "/pickup" });
    });
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "start_session")).toBe(true);
    expect((await invokeCalls(page)).some((c) => c.cmd === "send_message")).toBe(false);
  });

  test("a pointer to a chat that closed is ignored", async ({ page }) => {
    const closed = { ...MAIN, ended_at: "2026-11-12T10:00:00Z" };
    await openDraft(page, [closed, PLAIN], ["main-1"]);
    await expect(useRow(page)).toBeVisible();
    await expect(route(page)).toBeHidden();
  });
});

test.describe("view-harness / Main chats lists one row per project", () => {
  const headerTexts = (page: Page) => page.locator("#sessions-list li.session-group-header").allTextContents();
  const groupOf = (page: Page, id: string) => page.evaluate((sid) => {
    let cur = document.querySelector(`#sessions-list li[data-session-id="${sid}"]`)?.previousElementSibling ?? null;
    while (cur && !cur.classList.contains("session-group-header")) cur = cur.previousElementSibling;
    return cur?.textContent?.trim() ?? null;
  }, id);

  test("only the chat a project points at sits in Main chats; a second mode-on chat in it does not", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, { view: "sessions", invoke: invoke([MAIN, OLDER_MAIN, BETA_MAIN, PLAIN], ["main-1", "main-0", "beta-main"]) });
    await page.locator("#sessions-list li").first().waitFor();
    // The pointers hydrate after boot and redraw the list.
    await expect.poll(() => groupOf(page, "main-0")).not.toBe("Main chats");
    expect((await headerTexts(page))[0]).toContain("Main chats");
    expect(await groupOf(page, "main-1")).toBe("Main chats");
    expect(await groupOf(page, "beta-main")).toBe("Main chats");
    const inGroup = await page.locator("#sessions-list li[data-session-id]").evaluateAll((els) => {
      const out: string[] = [];
      for (const el of els) {
        let cur = el.previousElementSibling;
        while (cur && !cur.classList.contains("session-group-header")) cur = cur.previousElementSibling;
        if (cur?.textContent?.includes("Main chats")) out.push((el as HTMLElement).dataset.sessionId!);
      }
      return out;
    });
    expect(inGroup.sort()).toEqual(["beta-main", "main-1"]);
    await capture(page.locator("#sessions-list"), "main-chats-one-row-per-project");
  });

  test("with no pointers loaded, every mode-on chat still lists as before", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, { view: "sessions", invoke: invoke([MAIN, OLDER_MAIN, PLAIN], ["main-1", "main-0"], []) });
    await page.locator("#sessions-list li").first().waitFor();
    await page.waitForTimeout(300);
    expect(await groupOf(page, "main-1")).toBe("Main chats");
    expect(await groupOf(page, "main-0")).toBe("Main chats");
  });
});
