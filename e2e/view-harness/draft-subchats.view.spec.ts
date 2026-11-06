// asserts: src/views/sessions/draft-subchats.ts, src/views/sessions/pending-pane.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/project-dashboard/dashboard.ts, src/views/sessions/project-dashboard/draft-dashboard.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountSessionsList, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot, fakeShot } from "./project-dashboard-fixtures";

// A new-chat draft carries the "Use subchats" choice: the switch (a row above the
// message box, or a card in the settings rail when the draft has one) moves the
// chip to Opus, and the first start_session RPC carries the flag so the first
// spawn is already a main chat.

const REAL = "real-main";
const CWD = "C:/Projects/alpha";

async function openDraft(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_subchats_on: [],
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
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string; accountId: string }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1" });
  });
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

const row = (page: Page) => page.locator("#session-pane .draft-subchats");
const sw = (page: Page) => row(page).locator(".slider");
const modelText = (page: Page) => page.locator("#session-pane .session-header .meta-cfg-model-text");

// A project's draft on a wide window has the dashboard's settings rail, and the
// switch is a "This chat" card under the settings there instead of a row.
test.describe("view-harness / Use subchats on a new-chat draft with a settings rail", () => {
  test("the switch is a This chat card in the rail, and the row above the message box is gone", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 1000 });
    type Backend = { list: unknown; snapshots: Record<string, unknown>; histories: Record<string, unknown>; shots: string[] };
    await page.addInitScript((b: Backend) => {
      let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
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
    }, { list: LIST_ROWS, snapshots: { "p-conductor": conductorSnapshot() }, histories: { "p-conductor": conductorHistory() }, shots: [0, 1].map(fakeShot) });
    await mountSessionsList(page, [sessionInstance({ session_id: "s-w", pid: 201, name: "Loop todos: cycle 3", cwd: CONDUCTOR_CWD, busy: true, awaiting: "working" })], {
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      list_projects: [{ id: "p-conductor", path: CONDUCTOR_CWD, name: "claude_usage_in_taskbar", default_model: "haiku", default_effort: null }],
      list_accounts: [],
      get_settings: { theme: "void", defaultModel: "sonnet", defaultEffort: "high" },
      update_project: null,
      start_session: REAL,
      set_auto_accept: null,
      list_subchats_on: [],
    });
    await page.evaluate(() => {
      (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: unknown }> }).__ccInvokeCalls ??= [];
    });
    await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
    await page.evaluate((p) => (window as unknown as { __launchDraftForTest: (p: unknown, c: unknown) => void })
      .__launchDraftForTest({ path: p, name: "claude_usage_in_taskbar" }, { model: "sonnet", effort: "low", accountId: "acc1" }), CONDUCTOR_CWD);

    const card = page.locator(".pd-rail .view-project-settings .draft-subchats-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".ps-group-title")).toHaveText(/This chat/i);
    await expect(page.locator("#session-pane .draft-subchats")).toHaveCount(0);

    // The rail fades in after the dashboard's own entrance; a click mid-fade never settles.
    await expect(page.locator(".pd-rail")).toHaveCSS("opacity", "1", { timeout: 15_000 });
    await card.locator(".slider").click();
    await expect(card.locator("input")).toBeChecked();
    await expect(page.locator("#session-pane .session-header .meta-cfg-model-text")).toHaveText(/Opus/);
    await capture(page.locator(".pd-rail"), "draft-subchats-rail-card");
  });
});

for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / Use subchats on a new-chat draft (${label})`, () => {
    test("the switch sits right above the message box, off by default", async ({ page }) => {
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
