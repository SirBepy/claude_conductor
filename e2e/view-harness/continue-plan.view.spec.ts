// Reviewed 2026-11-21 (scratch main chat, pc-1806 step 7): only a draft in the No project (vault) folder changed (plain by default, its own switch, covered in scratch-main-chat.view.spec.ts); these drafts are in a project folder, so nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/continue-plan.ts, src/views/sessions/continue-plan.css, src/views/sessions/continue-plan-model.ts, src/views/sessions/reopen-main.ts, src/views/sessions/project-main-chats.ts, src/views/sessions/draft-subchats.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/active-session.ts, src/views/sessions/sessions.css, src/views/sessions/project-dashboard/dash-header.ts, src/views/sessions/project-dashboard/dash-actions.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountSessionsList, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot, fakeShot } from "./project-dashboard-fixtures";

// Reopening a put-away main chat and "Continue the plan?" (pc-1806 step 6). A new chat in a project whose
// main chat is put away reopens it (the draft line says so), the message goes in first, and only then the
// part asks what to do with the paused subs. Yes resumes them all; No draws the `after` tree as a checklist
// where ticking a sub ticks what waits for it. The project dashboard has a deliberate "Open main chat" door
// and the read-only banner a Reopen button. The daemon side (staggered resume, wake drain, no Blocked cards)
// is covered by the Rust tests in subchats/put_away/reopen_tests.rs. Desktop only: a reopen is a desktop-pipe
// call, so the phone offers none of these doors.

const CWD = "C:/Projects/cv-site";
const AWAY = "2026-11-21T10:00:00Z";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, project_id: "p-cv", ...over });
const AWAY_MAIN = chat("main", "CV redesign", 101, { hidden_at: AWAY, frozen: true, busy: false, awaiting: "done" });
const subOf = (id: string, name: string, pid: number) =>
  chat(id, name, pid, { subchat_of: "main", frozen: true, busy: false, awaiting: null });
const SUBS = [subOf("sub-api", "API", 102), subOf("sub-web", "Web", 103), subOf("sub-deploy", "Deploy", 104), subOf("sub-docs", "Docs", 105)];

// api <- web <- deploy chain, docs on its own.
const PAUSED = [
  { sub_id: "sub-api", name: "API", prior: "working", needs_continue: true, machine_id: null, after: [] },
  { sub_id: "sub-web", name: "Web", prior: "held", needs_continue: false, machine_id: null, after: ["sub-api"] },
  { sub_id: "sub-deploy", name: "Deploy", prior: "held", needs_continue: false, machine_id: null, after: ["sub-web"] },
  { sub_id: "sub-docs", name: "Docs", prior: "idle", needs_continue: false, machine_id: null, after: [] },
];

const PROJECTS = [{ id: "p-cv", path: CWD, name: "cv-site", default_model: null, default_effort: null, main_chat_id: "main" }];

interface Seed {
  rows: unknown[];
  paused: unknown[];
}

/** A daemon that remembers: a reopen clears `hidden_at` on the main row, `put_away_paused` lists what is
 *  still paused, and `resume_paused` empties it. Installed before the harness mock so it wraps it. */
interface InitArg extends Seed {
  dash: { list: unknown[]; snapshot: unknown; history: unknown; shot: unknown };
}

async function statefulDaemon(page: Page, seed: Seed): Promise<void> {
  await page.addInitScript((s: InitArg) => {
    let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
    const st = { rows: s.rows as Array<Record<string, unknown>>, paused: s.paused as unknown[] };
    (window as unknown as { __cpState: unknown }).__cpState = st;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => tauri,
      set: (v) => {
        const real = v.core.invoke;
        v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
          const answer = (value: unknown): Promise<unknown> => {
            (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
            return Promise.resolve(JSON.parse(JSON.stringify(value)));
          };
          const main = st.rows.find((r) => r.session_id === "main");
          switch (cmd) {
            case "list_instances":
            case "get_active_sessions": return answer(st.rows);
            case "reopen_main_chat":
              if (main) { main.hidden_at = null; main.frozen = false; }
              return answer({ ok: true, state: { hidden: false, paused: st.paused, unreadable: false } });
            case "put_away_paused":
              return answer({ hidden: !!main?.hidden_at, paused: st.paused, unreadable: false });
            case "resume_paused": {
              const end = (args?.end as string[]) ?? [];
              const n = st.paused.length;
              st.paused = [];
              return answer({ ok: true, ended: end.length, resuming: n - end.length });
            }
            case "dashboard_list_targets": return answer(s.dash.list);
            case "dashboard_snapshot": return answer(s.dash.snapshot);
            case "dashboard_history": return answer(s.dash.history);
            case "dashboard_gallery_image": return answer(s.dash.shot);
            default: return real(cmd, args);
          }
        };
        tauri = v;
      },
    });
  }, {
    ...seed,
    dash: {
      list: [
        { target: { kind: "group", id: "g-cv", name: "cv-site", repos: [{ cwd: CWD, name: "cv-site", project_id: null }] }, last_active_ms: 0, live_count: 0, question_count: 0, working_count: 0 },
      ] as unknown[],
      snapshot: null as unknown, history: null as unknown, shot: null as unknown,
    },
  } satisfies InitArg);
}

function baseInvoke(rows: unknown[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: rows,
    get_active_sessions: rows,
    list_projects: PROJECTS,
    list_subchats_on: ["main"],
    start_session: "real-new",
    send_message: null,
    unfreeze_session: null,
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

async function openDraft(page: Page, paused: unknown[] = PAUSED, subs: unknown[] = SUBS): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const rows = [AWAY_MAIN, ...subs];
  await statefulDaemon(page, { rows, paused });
  await mountView(page, { view: "sessions", invoke: baseInvoke(rows) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
      .__launchDraftForTest({ path: "C:/Projects/cv-site", name: "cv-site" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: true });
  });
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
  // The pointers hydrate after boot and redraw the line.
  await expect(route(page).locator(".dmr-line")).toBeVisible();
}

const route = (page: Page) => page.locator("#session-pane .draft-main-route");
const part = (page: Page) => page.locator("#session-pane .continue-plan");
const calls = async (page: Page, cmd: string) => (await invokeCalls(page)).filter((c) => c.cmd === cmd);
const send = async (page: Page, text: string): Promise<void> => {
  await page.locator("#session-pane .session-composer .composer-textarea").fill(text);
  await page.locator("#session-pane .session-composer .composer-send").click();
};

test.describe("view-harness / reopen the main chat and continue the plan", () => {
  test("the draft says it reopens the put-away main chat and how many subs are paused", async ({ page }) => {
    await openDraft(page);
    await expect(route(page).locator(".dmr-line")).toHaveText("Reopens CV redesign: paused, 4 subs");
    await expect(route(page)).toHaveAttribute("data-reopen", "1");
    await expect(page.locator("#session-pane .draft-subchats")).toBeHidden();
    await capture(page.locator("#session-pane"), "continue-plan-draft-reopens");
  });

  test("Plain chat instead is kept: the line flips, and the send starts a chat of its own without reopening", async ({ page }) => {
    await openDraft(page);
    await route(page).locator(".slider").click();
    await expect(route(page).locator(".dmr-line")).toHaveText("A plain chat, not cv-site's main chat");
    await send(page, "a side question");
    await expect.poll(async () => (await calls(page, "start_session")).length).toBe(1);
    expect(await calls(page, "reopen_main_chat")).toEqual([]);
  });

  test("the send reopens first, delivers the message, and only then asks to continue the plan", async ({ page }) => {
    await openDraft(page);
    await send(page, "add a contact form");
    await expect(part(page)).toBeVisible();
    const order = (await invokeCalls(page)).map((c) => c.cmd).filter((c) => c === "reopen_main_chat" || c === "send_message");
    expect(order).toEqual(["reopen_main_chat", "send_message"]);
    expect((await calls(page, "send_message"))[0]!.args).toMatchObject({ sessionId: "main" });
    expect(await calls(page, "start_session")).toEqual([]);
    await expect(part(page).locator(".cpl-line")).toContainText("4 subs were paused when this chat was put away: API, Web, Deploy, and 1 more.");
    await expect(part(page).locator(".cpl-yes")).toHaveText("Yes, resume them");
    // The chat is no longer read-only: the composer takes text.
    await expect(page.locator("#session-pane .put-away-banner")).toHaveCount(0);
    await expect(page.locator("#session-pane .session-composer .composer-textarea")).toBeEnabled();
    await page.waitForTimeout(400);
    // A toast-sized card in one place, not a strip as wide as the composer.
    const box = (await part(page).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(345);
    expect(box.height).toBeLessThan(140);
    await capture(page.locator("#session-pane"), "continue-plan-ask");
  });

  test("Ask me later closes the card, answers nothing, and says how to be asked again", async ({ page }) => {
    await openDraft(page);
    await send(page, "go on");
    await part(page).locator(".cpl-close").click();
    await expect(part(page)).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("The subs stay paused");
    expect(await calls(page, "resume_paused")).toEqual([]);
  });

  test("Yes resumes every paused sub and the part leaves", async ({ page }) => {
    await openDraft(page);
    await send(page, "go on");
    await part(page).locator(".cpl-yes").click();
    await expect.poll(async () => (await calls(page, "resume_paused")).length).toBe(1);
    expect((await calls(page, "resume_paused"))[0]!.args).toEqual({ sessionId: "main", end: [] });
    await expect(part(page)).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("Resuming 4 subs");
  });

  test("No draws the after tree, ticking a sub ticks what waits for it, and an unticked dependent runs without waiting", async ({ page }) => {
    await openDraft(page);
    await send(page, "go on");
    await part(page).locator(".cpl-no").click();
    const rows = part(page).locator(".cpl-row");
    await expect(rows).toHaveText([/API/, /Web/, /Deploy/, /Docs/]);
    const pad = async (i: number) => rows.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(await pad(0)).toBe(0);
    expect(await pad(1)).toBeGreaterThan(await pad(0));
    expect(await pad(2)).toBeGreaterThan(await pad(1));
    await expect(part(page).locator(".cpl-confirm")).toHaveText("Resume all");

    await rows.nth(0).locator("input").check();
    await expect(rows.nth(1).locator("input")).toBeChecked();
    await expect(rows.nth(2).locator("input")).toBeChecked();
    await expect(rows.nth(3).locator("input")).not.toBeChecked();
    await expect(part(page).locator(".cpl-confirm")).toHaveText("Stop 3, resume 1");

    // Deploy can be unticked: it then runs without waiting for Web, and says so.
    await rows.nth(2).locator("input").uncheck();
    await expect(rows.nth(2)).toHaveClass(/is-released/);
    await expect(rows.nth(2).locator(".cpl-note")).toHaveText("runs without waiting");
    await expect(part(page).locator(".cpl-confirm")).toHaveText("Stop 2, resume 2");
    // The note takes its own line under the name, so a name is not cut to make room for it.
    for (const i of [0, 1, 2, 3]) {
      const cut = await rows.nth(i).locator(".cpl-name").evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(cut, `row ${i} name is cut`).toBe(false);
    }
    const nameBox = (await rows.nth(2).locator(".cpl-name").boundingBox())!;
    const noteBox = (await rows.nth(2).locator(".cpl-note").boundingBox())!;
    expect(noteBox.y, "the note sits below the name").toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(500);
    await capture(page.locator("#session-pane"), "continue-plan-checklist");

    await part(page).locator(".cpl-confirm").click();
    await expect.poll(async () => (await calls(page, "resume_paused")).length).toBe(1);
    const args = (await calls(page, "resume_paused"))[0]!.args as { sessionId: string; end: string[] };
    expect(args.sessionId).toBe("main");
    expect([...args.end].sort()).toEqual(["sub-api", "sub-web"]);
    await expect(page.locator(".toast")).toContainText("Stopped 2, resuming 2");
    await expect(part(page)).toHaveCount(0);
  });

  test("a tick patches the rows in place: no row is rebuilt", async ({ page }) => {
    await openDraft(page);
    await send(page, "go on");
    await part(page).locator(".cpl-no").click();
    const first = part(page).locator(".cpl-row").first();
    await first.evaluate((el) => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });
    await first.locator("input").check();
    await expect(first.locator("input")).toBeChecked();
    expect(await first.evaluate((el) => (el as HTMLElement & { __kept?: boolean }).__kept === true)).toBe(true);
  });

  test("Back returns to the question and keeps nothing ticked", async ({ page }) => {
    await openDraft(page);
    await send(page, "go on");
    await part(page).locator(".cpl-no").click();
    await part(page).locator(".cpl-row").first().locator("input").check();
    await part(page).locator(".cpl-back").click();
    await expect(part(page).locator(".cpl-yes")).toBeVisible();
    await expect(part(page).locator(".cpl-list")).toBeHidden();
    await part(page).locator(".cpl-no").click();
    await expect(part(page).locator(".cpl-confirm")).toHaveText("Resume all");
  });

  test("a reopened chat with nothing paused asks nothing", async ({ page }) => {
    // Every sub was finished or gone before the reopen: no sub rows, and the daemon lists none paused.
    await openDraft(page, [], []);
    await expect(route(page).locator(".dmr-line")).toHaveText("Reopens CV redesign");
    await send(page, "hello again");
    await expect.poll(async () => (await calls(page, "send_message")).length).toBe(1);
    await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
    await page.waitForTimeout(500);
    await expect(part(page)).toHaveCount(0);
  });

  test("the read-only banner has a Reopen button that reopens the chat and asks to continue", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const rows = [AWAY_MAIN, ...SUBS];
    await statefulDaemon(page, { rows, paused: PAUSED });
    await mountView(page, { view: "sessions", invoke: baseInvoke(rows) });
    await page.locator("#sessions-list li[data-heads-hidden]").waitFor();
    await page.waitForTimeout(300);
    await page.locator("#sessions-list li[data-heads-hidden]").click();
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const banner = page.locator("#session-pane .put-away-banner");
    await expect(banner).toBeVisible();
    await expect(part(page)).toHaveCount(0);
    await banner.locator(".reopen-btn").click();
    await expect.poll(async () => (await calls(page, "reopen_main_chat")).length).toBe(1);
    expect((await calls(page, "reopen_main_chat"))[0]!.args).toEqual({ sessionId: "main" });
    await expect(page.locator("#session-pane .put-away-banner")).toHaveCount(0);
    await expect(part(page)).toBeVisible();
    // A reopen from the banner delivers no message of its own.
    expect(await calls(page, "send_message")).toEqual([]);
  });

  test("a chat that is not a main chat never asks", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const plain = chat("plain", "Plain chat", 110, { project_id: "p-other", busy: false, awaiting: "done" });
    await statefulDaemon(page, { rows: [plain], paused: PAUSED });
    await mountView(page, { view: "sessions", invoke: { ...baseInvoke([plain]), list_subchats_on: [] } });
    await page.locator('#sessions-list li[data-session-id="plain"]').click();
    await expect(page.locator("#session-pane .session-header .title")).toHaveText("Plain chat");
    await page.waitForTimeout(500);
    expect(await calls(page, "put_away_paused")).toEqual([]);
    await expect(part(page)).toHaveCount(0);
  });
});

// The dashboard's door needs a project (not group) target, so it mounts the dashboard fixtures.
test.describe("view-harness / the project dashboard's Open main chat door", () => {
  const DASH_AWAY = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CONDUCTOR_CWD, project_id: "p-conductor", hidden_at: AWAY, frozen: true, busy: false, awaiting: "done" });
  const DASH_SUB = sessionInstance({ session_id: "sub-api", name: "API", pid: 102, cwd: CONDUCTOR_CWD, project_id: "p-conductor", subchat_of: "main", frozen: true, busy: false, awaiting: null });
  const OTHER = sessionInstance({ session_id: "s-q", name: "Projects dashboard brainstorm", pid: 202, cwd: CONDUCTOR_CWD, project_id: "p-conductor", awaiting: "question" });

  async function openPage(page: Page, rows: unknown[], mainChatId: string | null): Promise<void> {
    await page.setViewportSize({ width: 1032, height: 1000 });
    await page.addInitScript((b: {
      rows: unknown[]; paused: unknown[]; list: unknown; snapshots: Record<string, unknown>; histories: Record<string, unknown>; shots: string[];
    }) => {
      let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
      const st = { rows: b.rows as Array<Record<string, unknown>>, paused: b.paused as unknown[] };
      Object.defineProperty(window, "__TAURI__", {
        configurable: true,
        get: () => tauri,
        set: (v) => {
          const real = v.core.invoke;
          v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
            const answer = (value: unknown): Promise<unknown> => {
              (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
              return Promise.resolve(JSON.parse(JSON.stringify(value)));
            };
            const key = args && typeof args.target === "object" ? (args.target as { id: string }).id : "";
            const main = st.rows.find((r) => r.session_id === "main");
            switch (cmd) {
              case "list_instances":
              case "get_active_sessions": return answer(st.rows);
              case "reopen_main_chat":
                if (main) { main.hidden_at = null; main.frozen = false; }
                return answer({ ok: true, state: { hidden: false, paused: st.paused, unreadable: false } });
              case "put_away_paused": return answer({ hidden: !!main?.hidden_at, paused: st.paused, unreadable: false });
              case "dashboard_list_targets": return answer(b.list);
              case "dashboard_snapshot": return answer(b.snapshots[key]);
              case "dashboard_history": return answer(b.histories[key]);
              case "dashboard_gallery_image": return answer(b.shots[0]);
              default: return real(cmd, args);
            }
          };
          tauri = v;
        },
      });
    }, {
      rows,
      paused: PAUSED.slice(0, 2),
      list: LIST_ROWS,
      snapshots: { "p-conductor": conductorSnapshot() },
      histories: { "p-conductor": conductorHistory() },
      shots: [0, 1].map(fakeShot),
    });
    await mountSessionsList(page, rows as never, {
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      list_projects: [{ id: "p-conductor", path: CONDUCTOR_CWD, name: "claude_usage_in_taskbar", default_model: null, default_effort: null, main_chat_id: mainChatId }],
      list_subchats_on: mainChatId ? ["main"] : [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      context_status: null,
      list_slash_commands: [],
      list_auto_accept: [],
      send_message: null,
    });
    await page.locator('#sessions-list li[data-session-id="s-q"]').click();
    await page.locator("#session-pane .session-header .meta-proj").click();
    await expect(page.locator(".pd-root.is-page")).toBeVisible();
  }

  const door = (page: Page) => page.locator(".pd-qa-host.is-page [data-pd-open-main]");

  test("a put-away main chat gets the door; it reopens the chat, opens it, and asks to continue", async ({ page }) => {
    await openPage(page, [OTHER, DASH_AWAY, DASH_SUB], "main");
    await expect(door(page)).toHaveText("Open main chat");
    await expect(door(page)).toHaveAttribute("title", "Reopens CV redesign: paused, 1 sub");
    await capture(page.locator(".pd-qa-host.is-page"), "continue-plan-dashboard-door");
    await door(page).click();
    await expect.poll(async () => (await calls(page, "reopen_main_chat")).length).toBe(1);
    await expect(page.locator(".pd-root.is-page")).toHaveCount(0);
    await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
    await expect(part(page)).toBeVisible();
  });

  test("a live main chat gets the door too, and opening it reopens nothing", async ({ page }) => {
    const live = { ...DASH_AWAY, hidden_at: null, frozen: false };
    await openPage(page, [OTHER, live], "main");
    await expect(door(page)).toHaveAttribute("title", "Open CV redesign");
    await door(page).click();
    await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
    expect(await calls(page, "reopen_main_chat")).toEqual([]);
  });

  test("a project with no main chat has no door", async ({ page }) => {
    await openPage(page, [OTHER], null);
    await expect(page.locator(".pd-qa-host.is-page [data-pd-new-chat]")).toBeVisible();
    await expect(door(page)).toHaveCount(0);
  });
});
