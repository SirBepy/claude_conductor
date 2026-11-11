// Reviewed 2026-11-11: the Undo hold on sends and card answers is gone (a send or answer goes out at once); nothing this spec asserts depends on it, and it passes.
// Reviewed 2026-11-11 (phone keyboard): pending-pane.ts no longer focuses the composer on open at phone width; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: dashboard.ts gained the Due card in its half-width list, absent unless a todo is due; this spec seeds no due todo, so its contract is unchanged and it passes.
// asserts: src/views/sessions/draft-subchats.ts, src/views/sessions/pending-pane.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/project-dashboard/dashboard.ts, src/views/sessions/project-dashboard/draft-dashboard.ts, src/views/sessions/project-dashboard/project-config.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountSessionsList, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot, fakeShot } from "./project-dashboard-fixtures";

// A new-chat draft carries the "Use subchats" choice: the switch (a row above the
// message box, or a card in the settings rail when the draft has one) moves the
// chip to Opus, and the first start_session RPC carries the flag so the first
// spawn is already a main chat.

const REAL = "real-main";
const CWD = "C:/Projects/alpha";

async function openDraft(page: Page, size: { width: number; height: number }, subchatsOn = false): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_subchats_on: [],
      // A group's dashboard has no settings rail, so the switch is the row above the
      // message box: the case this block covers (the phone, a group, a rail that never loads).
      dashboard_list_targets: [{
        target: { kind: "group", id: "g-alpha", name: "alpha", repos: [{ cwd: CWD, name: "alpha", project_id: null }] },
        last_active_ms: 0, live_count: 0, question_count: 0, working_count: 0,
      }],
      start_session: REAL,
      set_auto_accept: null,
      set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      context_status: null,
      list_slash_commands: [],
      send_message: null,
      list_auto_accept: [],
    },
  });
  await page.evaluate(({ real, row }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
      __rows: unknown[];
      __ccInvokeCalls: Array<{ cmd: string; args?: unknown }>;
    };
    w.__rows = [];
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "list_instances" || cmd === "get_active_sessions") return Promise.resolve(w.__rows);
      if (cmd === "start_session") {
        w.__ccInvokeCalls.push({ cmd, args });
        w.__rows = [row];
        return Promise.resolve(real);
      }
      return orig(cmd, args);
    };
  }, { real: REAL, row: sessionInstance({ session_id: REAL, name: "New chat", cwd: CWD, pid: 200, model: "opus", effort: "high", busy: false, awaiting: "done" }) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate((on) => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string; accountId: string; subchatsOn: boolean }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: on });
  }, subchatsOn);
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

const row = (page: Page) => page.locator("#session-pane .draft-subchats");
const sw = (page: Page) => row(page).locator(".slider");
const modelText = (page: Page) => page.locator("#session-pane .session-header .meta-cfg-model-text");

// The path a repoint test moves the project to; its dashboard snapshot is keyed by the
// path itself because no project or group row in the list names it.
const MOVED_CWD = "C:/Projects/claude_usage_in_taskbar_moved";
const railCard = (page: Page) => page.locator(".pd-rail .view-project-settings .draft-subchats-card");

type Core = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

// A project's draft on a wide window has the dashboard's settings rail, and the
// switch is a "This chat" card under the settings there instead of a row.
async function openRailDraft(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1700, height: 1000 });
  type Backend = { list: unknown; snapshots: Record<string, unknown>; histories: Record<string, unknown>; shots: string[] };
  await page.addInitScript((b: Backend) => {
    let tauri: { core: Core } | undefined;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => tauri,
      set: (v) => {
        const real = v.core.invoke;
        v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
          const key = args && typeof args.target === "object" ? (args.target as { id: string }).id : "";
          switch (cmd) {
            case "dashboard_list_targets": return Promise.resolve(b.list);
            case "dashboard_snapshot": return Promise.resolve(b.snapshots[key]);
            case "dashboard_history": return Promise.resolve(b.histories[key]);
            case "dashboard_gallery_image": return Promise.resolve(b.shots[0]);
            default: return real(cmd, args);
          }
        };
        tauri = v;
      },
    });
  }, {
    list: LIST_ROWS,
    snapshots: { "p-conductor": conductorSnapshot(), [MOVED_CWD]: conductorSnapshot() },
    histories: { "p-conductor": conductorHistory(), [MOVED_CWD]: conductorHistory() },
    shots: [0, 1].map(fakeShot),
  });
  await mountSessionsList(page, [sessionInstance({ session_id: "s-w", pid: 201, name: "Loop todos: cycle 3", cwd: CONDUCTOR_CWD, busy: true, awaiting: "working" })], {
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    list_projects: [{ id: "p-conductor", path: CONDUCTOR_CWD, name: "claude_usage_in_taskbar", default_model: "haiku", default_effort: null }],
    list_accounts: [],
    get_settings: { theme: "void", defaultModel: "sonnet", defaultEffort: "high" },
    update_project: null,
    start_session: REAL,
    set_auto_accept: null,
    list_subchats_on: [],
    check_paths_exist: { [MOVED_CWD]: true },
  });
  await page.evaluate(() => {
    (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: unknown }> }).__ccInvokeCalls ??= [];
  });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate((p) => (window as unknown as { __launchDraftForTest: (p: unknown, c: unknown) => void })
    .__launchDraftForTest({ path: p, name: "claude_usage_in_taskbar" }, { model: "sonnet", effort: "low", accountId: "acc1" }), CONDUCTOR_CWD);
  await expect(railCard(page)).toBeVisible();
  // The rail fades in after the dashboard's own entrance; a click mid-fade never settles.
  await expect(page.locator(".pd-rail")).toHaveCSS("opacity", "1", { timeout: 15_000 });
}

test.describe("view-harness / Use subchats on a new-chat draft with a settings rail", () => {
  test("the switch is a This chat card in the rail, and the row above the message box is gone", async ({ page }) => {
    await openRailDraft(page);
    const card = railCard(page);
    await expect(card.locator(".ps-group-title")).toHaveText(/This chat/i);
    await expect(page.locator("#session-pane .draft-subchats")).toHaveCount(0);

    await card.locator(".slider").click();
    await expect(card.locator("input")).toBeChecked();
    await expect(modelText(page)).toHaveText(/Opus/);
    await capture(page.locator(".pd-rail"), "draft-subchats-rail-card");
  });

  test("the row above the message box is never painted while the rail is still loading", async ({ page }) => {
    // Sampled every frame from before the draft opens: the row is mounted ahead of the
    // rail card that retires it, and one painted frame in between reads as a flash.
    await page.addInitScript(() => {
      const w = window as unknown as { __rowPainted: boolean };
      w.__rowPainted = false;
      const tick = (): void => {
        const el = document.querySelector<HTMLElement>("#session-pane .draft-subchats");
        if (el && getComputedStyle(el).display !== "none") w.__rowPainted = true;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await openRailDraft(page);
    expect(await page.evaluate(() => (window as unknown as { __rowPainted: boolean }).__rowPainted)).toBe(false);
  });

  test("a failed first send leaves a working switch with the flag intact", async ({ page }) => {
    await openRailDraft(page);
    await railCard(page).locator(".slider").click();
    await expect(modelText(page)).toHaveText(/Opus/);
    // The send takes the dashboard (and its card) down before the spawn answers, so a
    // rejected spawn must hand the draft a switch again.
    await page.evaluate(() => {
      const core = (window as unknown as { __TAURI__: { core: Core } }).__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) => (cmd === "start_session" ? Promise.reject(new Error("spawn refused")) : orig(cmd, args));
    });
    await page.locator("#session-pane .session-composer .composer-textarea").fill("build the site");
    await page.locator("#session-pane .session-composer .composer-send").click();
    await expect(page.locator(".toast").filter({ hasText: /Failed to start session/ }).first()).toBeVisible();

    await expect(row(page)).toBeVisible();
    await expect(row(page).locator("input")).toBeChecked();
    await expect(row(page).locator("input")).toBeEnabled();
    await expect(modelText(page)).toHaveText(/Opus/);
    // It still flips, and flipping off puts back the model it replaced.
    await sw(page).click();
    await expect(row(page).locator("input")).not.toBeChecked();
    await expect(modelText(page)).toHaveText(/Sonnet/);
  });

  test("a folder repoint rebuilds the card with the choice kept", async ({ page }) => {
    await openRailDraft(page);
    await railCard(page).locator(".slider").click();
    await expect(railCard(page).locator("input")).toBeChecked();

    // A draft's dashboard has no header kebab; its project menu is the right-click one.
    await page.locator(".pd-draft .pd-row").first().click({ button: "right" });
    await page.locator(".session-more-menu .smore-item", { hasText: "Folder mapping..." }).click();
    await page.locator("#projectDetailPath").click();
    await page.locator("#projectDetailPathInput").fill(MOVED_CWD);
    await page.locator("#projectDetailPathInput").press("Enter");

    // The rebuilt rail has its settings in, so a missing card is the card's doing.
    await expect(page.locator(".pd-rail .view-project-settings")).toBeVisible();
    await expect(railCard(page)).toHaveCount(1);
    await expect(railCard(page).locator("input")).toBeChecked();
    await expect(page.locator("#session-pane .draft-subchats")).toHaveCount(0);
  });
});

for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / Use subchats on a new-chat draft (${label})`, () => {
    test("the switch sits right above the message box, off when the draft opens without it", async ({ page }) => {
      await openDraft(page, size);
      await expect(row(page)).toBeVisible();
      await expect(row(page).locator("input")).not.toBeChecked();
      const rowBox = (await row(page).boundingBox())!;
      const boxTop = (await page.locator("#session-pane .composer-shell").boundingBox())!.y;
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(boxTop + 1);
    });

    test("switching it on moves the chip to Opus, and the first send carries the flag", async ({ page }) => {
      await openDraft(page, size);
      await expect(modelText(page)).toHaveText(/Sonnet/);
      await sw(page).click();
      await expect(row(page).locator("input")).toBeChecked();
      await expect(modelText(page)).toHaveText(/Opus/);
      await capture(page.locator("#session-pane"), `draft-subchats-on-${label}`);

      await page.locator("#session-pane .session-composer .composer-textarea").fill("build the site");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: true, model: "opus", effort: "high" });
      // The row is gone once the draft became the chat.
      await expect(row(page)).toHaveCount(0);
    });

    test("a draft that opens with it on (the default) shows it on with the chip on Opus, and the first send carries the flag", async ({ page }) => {
      await openDraft(page, size, true);
      await expect(row(page).locator("input")).toBeChecked();
      await expect(modelText(page)).toHaveText(/Opus/);
      await page.locator("#session-pane .session-composer .composer-textarea").fill("build the site");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: true, model: "opus", effort: "high" });
    });

    test("switching the default off for one chat puts the project's model back and starts an ordinary chat", async ({ page }) => {
      await openDraft(page, size, true);
      await sw(page).click();
      await expect(row(page).locator("input")).not.toBeChecked();
      await expect(modelText(page)).toHaveText(/Sonnet/);
      await page.locator("#session-pane .session-composer .composer-textarea").fill("quick question");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
    });

    test("left off, the first send starts an ordinary chat", async ({ page }) => {
      await openDraft(page, size);
      await page.locator("#session-pane .session-composer .composer-textarea").fill("quick question");
      await page.locator("#session-pane .session-composer .composer-send").click();
      await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
      const args = await page.evaluate(() =>
        (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__ccInvokeCalls.find((c) => c.cmd === "start_session")!.args);
      expect(args).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
    });
  });
}
