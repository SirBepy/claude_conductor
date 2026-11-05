// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: subchat-view.ts exports backToMain for Ctrl+W (no behaviour change to the back arrow); this spec's back-arrow tests pass unchanged.
// Reviewed 2026-11-05: main-chat.ts's progress text says paused or rate limited for a frozen or rate-limited sub instead of working; this spec's subs are neither, so its contract holds and it passes.
// Reviewed 2026-11-05: sub-list.ts and main-chat.ts gained a "queued" kind (a sub held for the writer slot); this spec has no queued sub, so its rows are unchanged, and it passed after the change. The queued row is covered in subchat-writer-slot.view.spec.ts.
// asserts: src/views/sessions/sub-list.ts, src/views/sessions/subchat-view.ts, src/views/sessions/active-session.ts, src/views/sessions/session-header.ts, src/views/sessions/state.ts, src/views/sessions/sessions-wiring.ts, src/views/sessions/sidebar-entries.ts, src/views/sessions/main-chat.ts
import { test, expect, type Page } from "@playwright/test";
import {
  assistantMsg, capture, fireEvent, invokeCalls, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance, userMsg,
} from "./harness";

// Subchats step 7: a main chat's header counts its subs and lists them; a row
// opens the sub in place with a back arrow; Joe types to it, running or finished;
// "Move to sidebar" turns it into an ordinary chat. Drives the real sessions view
// at desktop and phone width, and the phone transport for the remote path.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, ...over });

const PLAN = [
  { text: "Read", status: "done" }, { text: "Write", status: "done" }, { text: "Render", status: "active" },
  { text: "Verify", status: "pending" }, { text: "Polish", status: "pending" }, { text: "Ship", status: "pending" },
] as const;

const MAIN = chat("main", "CV redesign", 101);
const FOOTER = sub("sub-footer", "Footer", 102, { progress: { plan: [...PLAN] as never, state_since: null } });
const HEADER = sub("sub-header", "Header", 103, { subchat_finished: true, awaiting: "done" });
const PLAIN = chat("plain", "Plain chat", 110);

const q = (n: number) => ({ question: `Question ${n}?`, header: `Q${n}`, options: [{ label: "Yes" }, { label: "No" }] });
const askFrom = (subId: string, n: number) => ({
  id: `prompt-${subId}`, session_id: subId, display_session_id: "main", seq: 1,
  questions: Array.from({ length: n }, (_, i) => q(i + 1)),
});

/** A long transcript for the main chat (so it scrolls) and a short one per sub. */
function history(sessionId: string): unknown {
  const events: unknown[] = [];
  if (sessionId === "main") {
    for (let i = 0; i < 40; i++) {
      events.push(userMsg(`main ask ${i}`));
      events.push(assistantMsg(`main reply ${i}`));
    }
  } else {
    events.push(userMsg(`brief for ${sessionId}`));
    events.push(assistantMsg(`${sessionId} says hello`));
  }
  return { events, oldest_seq: 0, newest_seq: events.length, has_more: false };
}

function invokeFor(sessions: unknown[], on: string[] = ["main"], pending: unknown[] = []) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: on,
    list_pending_prompts: pending.map((p) => ({ id: (p as { id: string }).id, event: "question-requested", durable: true, payload: p })),
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: history("main"),
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_slash_commands: [],
    send_message: null,
    move_sub_to_sidebar: null,
    open_file_window: null,
    list_auto_accept: [],
    confirm_question_rendered: null,
    respond_question: false,
  };
}

/** Per-session transcripts, and a stand-in daemon for "Move to sidebar": once the
 *  command is invoked, the listings stop reporting that row as a sub. */
async function installBackend(page: Page): Promise<void> {
  await page.evaluate((hist) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const orig = tauri.core.invoke;
    const moved = new Set<string>();
    (window as unknown as { __moved: Set<string> }).__moved = moved;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "load_history_page") return Promise.resolve((hist as Record<string, unknown>)[args?.sessionId] ?? (hist as Record<string, unknown>).other);
      if (cmd === "move_sub_to_sidebar") moved.add(args.sessionId);
      if (cmd === "list_instances" || cmd === "get_active_sessions") {
        return orig(cmd, args).then((list: any[]) =>
          list.map((s) => (moved.has(s.session_id) ? { ...s, subchat_of: null, subchat_finished: false } : s)));
      }
      return orig(cmd, args);
    };
  }, { main: history("main"), "sub-footer": history("sub-footer"), "sub-header": history("sub-header"), other: history("other") });
}

async function mount(page: Page, size: { width: number; height: number }, sessions: unknown[], pending: unknown[] = []): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "sessions", invoke: invokeFor(sessions, ["main"], pending) });
  await installBackend(page);
  await page.locator("#sessions-list li").first().waitFor();
  await page.waitForTimeout(250);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const title = (page: Page) => page.locator("#session-pane .session-header .title");
const countBtn = (page: Page) => page.locator("#session-pane .session-header .sub-count-btn");
const backBtn = (page: Page) => page.locator("#session-pane .session-header .sub-back-btn");
const moveBtn = (page: Page) => page.locator("#session-pane .session-header .sub-move-btn");
const listRow = (page: Page, id: string) => page.locator(`.sub-list-popover .sub-row[data-sub-id="${id}"]`);

async function openChat(page: Page, id: string): Promise<void> {
  // The phone shows the list or the chat, never both: go back to the list first.
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await row(page, id).click();
  await expect(title(page)).toHaveText(id === "main" ? "CV redesign" : id === "plain" ? "Plain chat" : /./);
  // Attached, not visible: an open question card replaces the chat box.
  await page.locator(".session-composer .cc-typing-input").waitFor({ state: "attached" });
}

async function openList(page: Page): Promise<void> {
  await countBtn(page).click();
  await page.locator(".sub-list-popover").waitFor();
}

async function openSubFromList(page: Page, id: string): Promise<void> {
  await openList(page);
  await listRow(page, id).click();
  await expect(backBtn(page)).toBeVisible();
}

const sends = async (page: Page) => (await invokeCalls(page)).filter((c) => c.cmd === "send_message");

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / sub list (${label})`, () => {
    test("no count icon until the chat has a sub", async ({ page }) => {
      await mount(page, size, [MAIN, PLAIN]);
      await openChat(page, "main");
      await expect(countBtn(page)).toHaveCount(0);
      await openChat(page, "plain");
      await expect(countBtn(page)).toHaveCount(0);
    });

    test("the count appears with a sub and follows the number of subs", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER, PLAIN]);
      await openChat(page, "main");
      await expect(countBtn(page)).toHaveText("2");
      await capture(page.locator("#session-pane .session-header"), `sub-count-header-${label}`);
      // A chat that is not their parent shows nothing.
      await openChat(page, "plain");
      await expect(countBtn(page)).toHaveCount(0);
    });

    test("the list shows running and finished subs with their status and progress", async ({ page }) => {
      // The phone's question sheet covers the header that holds the count, so an asking sub
      // is checked on the desktop only; the sidebar spec covers asking subs at phone width.
      const asking = label === "desktop";
      await mount(
        page, size,
        [MAIN, FOOTER, HEADER, ...(asking ? [sub("sub-contact", "Contact", 104)] : [])],
        asking ? [askFrom("sub-contact", 2)] : [],
      );
      await openChat(page, "main");
      await openList(page);
      const heads = await page.locator(".sub-list-popover .sub-list-head").allTextContents();
      expect(heads).toEqual(["Running", "Finished"]);
      await expect(listRow(page, "sub-footer")).toHaveAttribute("data-kind", "working");
      await expect(listRow(page, "sub-footer").locator(".sub-status")).toHaveText("step 3 of 6");
      await expect(listRow(page, "sub-header")).toHaveAttribute("data-kind", "finished");
      await expect(listRow(page, "sub-header").locator(".sub-status")).toHaveText("finished");
      const order = await page.locator(".sub-list-popover .sub-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subId));
      if (asking) {
        await expect(listRow(page, "sub-contact")).toHaveAttribute("data-kind", "asking");
        // Asking is not done, so it sits with the running ones, ahead of the working one.
        expect(order).toEqual(["sub-contact", "sub-footer", "sub-header"]);
      } else {
        expect(order).toEqual(["sub-footer", "sub-header"]);
      }
      await capture(page, `sub-list-open-${label}`);
    });

    test("a sub held behind another is listed as waiting, with no way to move it before it has started", async ({ page }) => {
      const queued = sub("sub-queued", "Footer links", 106, {
        progress: { plan: null, state_since: null, waiting_for: "waiting for Header" },
      });
      await mount(page, size, [MAIN, FOOTER, HEADER, queued]);
      await openChat(page, "main");
      await expect(countBtn(page)).toHaveText("3");
      await openList(page);
      const heads = await page.locator(".sub-list-popover .sub-list-head").allTextContents();
      expect(heads, "queued sits with the running ones, not under Finished").toEqual(["Running", "Finished"]);
      await expect(listRow(page, "sub-queued")).toHaveAttribute("data-kind", "queued");
      await expect(listRow(page, "sub-queued").locator(".sub-status")).toHaveText("waiting for Header");
      await expect(listRow(page, "sub-queued").locator("[data-move]")).toHaveCount(0);
      await expect(listRow(page, "sub-footer").locator("[data-move]")).toHaveCount(1);
      const order = await page.locator(".sub-list-popover .sub-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subId));
      expect(order).toEqual(["sub-footer", "sub-queued", "sub-header"]);
      // The ring is the working yellow, not the glowing or arc one a running sub gets.
      const dot = listRow(page, "sub-queued").locator(".sub-dot .avatar-ring circle");
      await expect(dot.first()).toHaveAttribute("data-tone", "working");
      await expect(dot.first()).not.toHaveClass(/is-glow/);
      await capture(page, `sub-list-queued-${label}`);
      // Reading it in place says it is waiting.
      await listRow(page, "sub-queued").click();
      await expect(backBtn(page)).toBeVisible();
      await expect(page.locator("#session-pane .session-header .meta-proj")).toHaveText("Subchat of CV redesign, waiting for Header");
    });

    test("a row opens the sub in place with a back arrow, and the sidebar keeps the main chat selected", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER, PLAIN]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-footer");
      await expect(title(page)).toHaveText("Footer");
      await expect(page.locator("#session-pane .session-header .meta-proj")).toHaveText("Subchat of CV redesign");
      await expect(moveBtn(page)).toBeVisible();
      // The pane is the sub's own chat view: its transcript, its composer.
      await expect(page.locator("#session-pane .session-messages")).toContainText("sub-footer says hello");
      await expect(page.locator(".session-composer .cc-typing-input")).toBeVisible();
      // "Everything stays in the main chat": the main row is the selected one, and the sub has none.
      await expect(page.locator("#sessions-list li.active")).toHaveCount(1);
      await expect(row(page, "main")).toHaveClass(/active/);
      await expect(row(page, "sub-footer")).toHaveCount(0);
      await capture(page, `sub-open-in-place-${label}`);
    });

    test("a finished sub says so in its header", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-header");
      await expect(page.locator("#session-pane .session-header .meta-proj")).toHaveText("Subchat of CV redesign, finished, can continue");
    });

    test("typing to a running sub sends to that sub, not the main chat", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-footer");
      await page.locator(".session-composer .cc-typing-input").fill("make it smaller");
      await page.locator(".session-composer .composer-send").click();
      await expect.poll(async () => (await sends(page)).length).toBe(1);
      expect((await sends(page))[0]!.args).toMatchObject({ sessionId: "sub-footer" });
      // Its reply bubble lands in the sub's own transcript.
      await expect(page.locator("#session-pane .session-messages")).toContainText("make it smaller");
    });

    test("typing to a finished sub sends to that sub and never unfreezes or starts a chat of its own", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-header");
      await page.locator(".session-composer .cc-typing-input").fill("one more tweak");
      await page.locator(".session-composer .composer-send").click();
      await expect.poll(async () => (await sends(page)).length).toBe(1);
      expect((await sends(page))[0]!.args).toMatchObject({ sessionId: "sub-header" });
      // The daemon wakes it through continue_sub; the client must not do its own resume.
      const cmds = (await invokeCalls(page)).map((c) => c.cmd);
      expect(cmds).not.toContain("unfreeze_session");
      expect(cmds).not.toContain("start_session");
    });

    test("back restores the main chat with the same transcript node and the scroll kept", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await page.locator("#session-pane .session-messages .msg").first().waitFor();
      await page.waitForTimeout(600);
      const parked = await page.locator("#session-pane .session-messages").evaluate((el) => {
        (el as HTMLElement).dataset.brand = "main-transcript";
        el.scrollTop = 120;
        return el.scrollTop;
      });
      expect(parked).toBeGreaterThan(0);
      await page.waitForTimeout(150);

      await openSubFromList(page, "sub-footer");
      await expect(page.locator("#session-pane .session-messages")).not.toHaveAttribute("data-brand", "main-transcript");
      await backBtn(page).click();
      await expect(title(page)).toHaveText("CV redesign");
      await expect(backBtn(page)).toHaveCount(0);
      // The retained pane, not a rebuild: the branded node is back, painted, and unscrolled-to-bottom.
      const messages = page.locator("#session-pane .session-messages");
      await expect(messages).toHaveAttribute("data-brand", "main-transcript");
      expect(Number(await messages.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
      await expect.poll(async () => messages.evaluate((el) => el.scrollTop)).toBeCloseTo(parked, -1);
    });

    test("going back from a sub leaves the main chat pinned to the bottom when it was", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER]);
      await openChat(page, "main");
      await page.locator("#session-pane .session-messages .msg").first().waitFor();
      await page.waitForTimeout(600);
      await openSubFromList(page, "sub-footer");
      await backBtn(page).click();
      await expect(title(page)).toHaveText("CV redesign");
      await expect.poll(async () => page.locator("#session-pane .session-messages").evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(64);
    });

    test("Ctrl+1 from a sub lands on the main chat, not a stranded sub", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, PLAIN]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-footer");
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("Control+2");
      await expect(title(page)).toHaveText("Plain chat");
      await expect(backBtn(page)).toHaveCount(0);
      await expect(countBtn(page)).toHaveCount(0);
      await page.keyboard.press("Control+1");
      await expect(title(page)).toHaveText("CV redesign");
      await expect(countBtn(page)).toHaveText("1");
    });

    test("Move to sidebar from the header gives the sub a sidebar row and takes it off the list", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-header");
      await moveBtn(page).click();
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "move_sub_to_sidebar").length).toBe(1);
      expect((await invokeCalls(page)).find((c) => c.cmd === "move_sub_to_sidebar")!.args).toMatchObject({ sessionId: "sub-header" });
      // It is an ordinary chat now: its own row, selected, and no sub chrome.
      await expect(row(page, "sub-header")).toHaveCount(1);
      await expect(row(page, "sub-header")).toHaveClass(/active/);
      await expect(backBtn(page)).toHaveCount(0);
      await expect(moveBtn(page)).toHaveCount(0);
      await expect(title(page)).toHaveText("Header");
      // And it left the main chat's list: one sub remains.
      await openChat(page, "main");
      await expect(countBtn(page)).toHaveText("1");
      await openList(page);
      await expect(listRow(page, "sub-header")).toHaveCount(0);
      await expect(listRow(page, "sub-footer")).toHaveCount(1);
    });

    test("Move to sidebar from a list row moves that sub without leaving the main chat", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await openList(page);
      await listRow(page, "sub-footer").locator("[data-move]").click();
      await expect(row(page, "sub-footer")).toHaveCount(1);
      await expect(title(page)).toHaveText("CV redesign");
      await expect(countBtn(page)).toHaveText("1");
    });

    test("the last sub leaving takes the count icon away", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER]);
      await openChat(page, "main");
      await openList(page);
      await listRow(page, "sub-footer").locator("[data-move]").click();
      await expect(row(page, "sub-footer")).toHaveCount(1);
      await expect(countBtn(page)).toHaveCount(0);
    });

    test("a question the sub raises shows as a normal card while it is read in place", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-footer");
      await fireEvent(page, "question-requested", [askFrom("sub-footer", 2)]);
      await expect(page.locator("#prompt-card-host .prompt-card")).toBeVisible();
      await expect(page.locator("#prompt-card-host .prompt-card")).toContainText("Question 1?");
    });

    test("a card parked for the main chat's window comes up when a sub is opened", async ({ page }) => {
      test.skip(label === "phone", "the phone's question sheet covers the header that holds the list");
      await mount(page, size, [MAIN, FOOTER], [askFrom("sub-footer", 2)]);
      await openChat(page, "main");
      await openSubFromList(page, "sub-footer");
      await expect(page.locator("#prompt-card-host .prompt-card")).toBeVisible();
      await expect(page.locator("#prompt-card-host .prompt-card")).toContainText("Question 1?");
    });

    test("a daemon card's Open it opens that sub in the main chat's window", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, HEADER]);
      await openChat(page, "main");
      await fireEvent(page, "subchat-open-requested", [{ display_session_id: "main", sub_id: "sub-header" }]);
      await expect(title(page)).toHaveText("Header");
      await expect(backBtn(page)).toBeVisible();
    });

    test("an Open it for another chat's window is left alone", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER, PLAIN]);
      await openChat(page, "plain");
      await fireEvent(page, "subchat-open-requested", [{ display_session_id: "main", sub_id: "sub-footer" }]);
      await page.waitForTimeout(200);
      await expect(title(page)).toHaveText("Plain chat");
    });

    test("the checkup card's Open the log opens the file viewer for the main chat's window", async ({ page }) => {
      await mount(page, size, [MAIN, FOOTER]);
      await openChat(page, "main");
      await fireEvent(page, "subchat-log-open-requested", [{ display_session_id: "main", path: "C:/data/subchats/main.decisions.md" }]);
      await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "open_file_window").length).toBe(1);
      const call = (await invokeCalls(page)).find((c) => c.cmd === "open_file_window")!;
      expect(String((call.args as { path: string }).path).replace(/\\/g, "/")).toBe("C:/data/subchats/main.decisions.md");
    });
  });
}

test.describe("view-harness / sub list (phone transport)", () => {
  test("the phone reads a sub in place, replies to it over REST, and moves it over the RPC", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const sent: string[] = [];
    await page.route("**/api/sessions/*/send", async (route) => {
      sent.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!));
      await route.fulfill({ status: 200, body: "" });
    });
    const rpcMethods: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/rpc")) rpcMethods.push((r.postDataJSON() as { method: string }).method);
    });
    await mountViewPhone(page, { view: "sessions", invoke: invokeFor([MAIN, FOOTER, HEADER]) });
    await page.locator("#sessions-list li[data-session-id='main']").click();
    await expect(title(page)).toHaveText("CV redesign");
    await expect(countBtn(page)).toHaveText("2");
    await openSubFromList(page, "sub-header");
    await expect(title(page)).toHaveText("Header");
    // The sub's own arrow replaces the list-back on the phone.
    await expect(page.locator(".session-header .sub-back-btn")).toBeVisible();
    await expect(page.locator(".session-header #sessionsBackBtn")).toBeHidden();

    await page.locator(".session-composer .cc-typing-input").fill("hello sub");
    await page.locator(".session-composer .composer-send").click();
    await expect.poll(() => sent).toEqual(["sub-header"]);

    await capture(page, "sub-open-in-place-phone-transport");
    await moveBtn(page).click();
    await expect.poll(() => rpcMethods).toContain("move_sub_to_sidebar");
  });
});
