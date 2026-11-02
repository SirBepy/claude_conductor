// asserts: src/views/sessions/split-panels/split.ts, src/views/sessions/split-panels/memory.ts, src/views/sessions/fab-dial.ts, src/shared/app-rail.ts, src/shared/global-panel.ts, src/shared/navigation.ts, src/router.ts, src/views/dashboard/dashboard.ts, src/views/schedule/schedule.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, mountView } from "./harness";
import { expectIconButtonsCentred } from "./icon-centering";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The chat pane's panels on desktop (Joe, 2026-10-25): a split
// beside the chat with a draggable divider, and a narrow icon strip on the far
// right (Preview / Drafts / Todos / Ask) swapping which one fills it. Real
// pointer input on the real strip and FAB, not internal state.

const VIEWER = "sess-A";
const STRIP_W = 44;

const DRAFT = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  topic: "Deploy slip",
  brief: "",
  receipts: [],
  variants: [
    {
      recipient: "Bruno",
      handle_n: 2,
      current: 1,
      versions: [
        {
          n: 1,
          body: "Hey Bruno, quick heads up.\n\nThe backfill is slower than we estimated, so it misses Wednesday's freeze.",
          author: "ai",
          note: "",
          created_at: "2026-10-01T08:00:00Z",
        },
      ],
    },
  ],
  state: "needs-you",
  origin_session_id: VIEWER,
  origin_label: "deploy",
  created_at: "2026-10-01T08:00:00Z",
  // Fresh relative to the run: a draft untouched for a week stops counting
  // as open, and both the strip's count and the card clicks below need it open.
  updated_at: new Date().toISOString(),
  seen_by_origin: true,
};

/** A full-bleed pane with a chat column we can measure, and the real FAB. */
async function mountPane(
  page: Page,
  invoke: Record<string, unknown> = {},
  width = 1280,
  chatsWindow = false,
  view?: string,
): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mountView(page, { view, invoke: { list_slash_commands: [], list_previews: [], ...invoke } });
  await page.evaluate(
    async ({ draft, viewer, chatsWindow }) => {
      localStorage.clear();
      if (chatsWindow) document.body.classList.add("chats-window-mode");
      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) =>
        cmd === "list_message_drafts" ? Promise.resolve({ drafts: [draft] }) : passthrough(cmd, args);

      const pane = document.createElement("main");
      pane.className = "session-pane";
      pane.style.cssText = "position:fixed;inset:0;z-index:1;box-sizing:border-box";
      pane.innerHTML = `<div id="chat-col" style="flex:1"></div>`;
      document.body.appendChild(pane);
      const pv = await import("/views/sessions/preview-panel.ts");
      const mod = await import("/views/sessions/fab-dial.ts");
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, onCode: () => {}, mountPreview: pv.mountPreviewTab });
      fab.setSessionScope(viewer, "/proj");
      (window as any).__fab = fab;
    },
    { draft: DRAFT, viewer: VIEWER, chatsWindow },
  );
}

const panel = (page: Page) => page.locator(".sp-panel");
const tab = (page: Page, k: string) => page.locator(`.sp-tab[data-sp-k="${k}"]`);
const chatWidth = (page: Page) => page.locator("#chat-col").evaluate((el) => el.getBoundingClientRect().width);

test("at rest only the strip shows, Code then Preview / Drafts / Todos / Backlog / Ask top to bottom, and the chat keeps the rest", async ({ page }) => {
  await mountPane(page);
  await expect(panel(page)).toBeHidden();
  const keys = await page.locator(".sp-tab").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spK ?? "code"));
  expect(keys).toEqual(["code", "preview", "drafts", "todos", "backlog", "ask"]);
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W);
});

test("Drafts' open count shows quietly on its icon before it is opened", async ({ page }) => {
  await mountPane(page);
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveText("1");
  await expect(tab(page, "todos").locator(".sp-count")).toHaveCount(0);
});

test("a chat switch clears the previous chat's Drafts count until the new one's fetch lands", async ({ page }) => {
  await mountPane(page);
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveText("1");
  await page.evaluate(() => {
    // The next chat's fetch never resolves, so only the switch itself can clear the count.
    const tauri = (window as any).__TAURI__;
    const passthrough = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) =>
      cmd === "list_message_drafts" ? new Promise(() => {}) : passthrough(cmd, args);
    (window as any).__fab.setSessionScope("sess-B", "/proj");
  });
  await expect(tab(page, "drafts").locator(".sp-count")).toHaveCount(0);
});

test("a strip icon fills the split beside the chat; the same icon or the X closes it", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "true");

  const p = (await panel(page).boundingBox())!;
  const chat = await chatWidth(page);
  // Half and half by default: the chat ends where the divider starts.
  expect(Math.round(p.x + p.width)).toBe(1280 - STRIP_W);
  expect(Math.abs(chat - p.width)).toBeLessThanOrEqual(1);
  expect(Math.round(chat + 6 + p.width + STRIP_W)).toBe(1280);
  await expectIconButtonsCentred(page);

  await tab(page, "drafts").click();
  await expect(panel(page)).toBeHidden();
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W);

  await tab(page, "todos").click();
  await panel(page).locator('[data-sp-act="close"]').click();
  await expect(panel(page)).toBeHidden();
});

test("another icon swaps the panel in place, one at a time", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await tab(page, "todos").click();
  await expect(panel(page)).toHaveAttribute("data-active", "todos");
  await expect(page.locator(".sp-pane:visible")).toHaveCount(1);
  await expect(page.locator('.sp-pane[data-panel="todos"]')).toBeVisible();
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "false");
});

test("dragging the divider resizes the split, and the width holds across a close and reopen", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  const before = await chatWidth(page);
  const div = (await page.locator(".sp-divider").boundingBox())!;
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(div.x - 150, div.y + 200, { steps: 8 });
  await page.mouse.up();
  const after = await chatWidth(page);
  expect(Math.round(before - after)).toBeGreaterThan(140);

  await tab(page, "drafts").click();
  await tab(page, "drafts").click();
  expect(Math.round(await chatWidth(page))).toBe(Math.round(after));
});

test("the divider stops where the chat would drop under its minimum", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  const div = (await page.locator(".sp-divider").boundingBox())!;
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(40, div.y + 200, { steps: 8 });
  await page.mouse.up();
  expect(Math.round(await chatWidth(page))).toBe(420);
});

test("each chat keeps its own panel, and closing it forgets it there", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await expect(panel(page)).toBeHidden();
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe(`${STRIP_W}px`);

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");
  await expect(panel(page)).toBeVisible();

  await tab(page, "drafts").click();
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-B", "/proj"));
  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(panel(page)).toBeHidden();
});

test("no chat, no strip and no width taken", async ({ page }) => {
  await mountPane(page);
  await page.evaluate(() => (window as any).__fab.setSessionScope(null, null));
  await expect(page.locator(".sp-strip")).toHaveCount(0);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");
});

test("too narrow for a split, the panel covers the chat instead of squeezing it", async ({ page }) => {
  // Above the phone breakpoint (768px), so the desktop split is mounted.
  await mountPane(page, {}, 780);
  await tab(page, "drafts").click();
  await expect(panel(page)).toHaveAttribute("data-overlay", "");
  await expect(page.locator(".sp-divider")).toBeHidden();
  expect(Math.round(await chatWidth(page))).toBe(780 - STRIP_W);
  const p = (await panel(page).boundingBox())!;
  expect(Math.round(p.x)).toBe(0);
});

test("Escape closes the split", async ({ page }) => {
  await mountPane(page);
  await tab(page, "todos").click();
  await page.mouse.click(200, 400);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
});

const SNAP_NOW = new Date().toISOString();
const SNAP_HTML = "<p id='hello'>hi from the snapshot</p>";
const PREVIEW_MOCKS = {
  list_previews: [{ id: "snap-1", slug: "s", title: "S", source: "terminal", session_id: VIEWER, version: 2, created_at: SNAP_NOW }],
  get_preview: { id: "snap-1", slug: "s", title: "S", html: SNAP_HTML, source: "terminal", session_id: VIEWER, version: 2, created_at: SNAP_NOW },
  render_preview_doc: "data:text/html;charset=utf-8," + encodeURIComponent(SNAP_HTML),
};

test("opening Preview from the strip loads the chat's latest snapshot, under one header row", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "preview").click();
  // The body fetches only when it comes into view, so an open that never
  // told it so left the panel blank.
  await expect(panel(page).locator("iframe.pv-iframe")).toHaveCount(1);
  // The split's close/pop-out sit in Preview's own head row, not a second one above it.
  const head = (await panel(page).locator(".pv-head").boundingBox())!;
  const close = (await panel(page).locator('[data-sp-act="close"]').boundingBox())!;
  const popout = panel(page).locator('[data-sp-act="popout"]');
  await expect(popout).toBeVisible();
  expect(close.y).toBeGreaterThanOrEqual(head.y);
  expect(close.y + close.height).toBeLessThanOrEqual(head.y + head.height);
  const kebab = (await panel(page).locator('.pv-head [data-act="more"]').boundingBox())!;
  expect(kebab.x + kebab.width).toBeLessThanOrEqual((await popout.boundingBox())!.x);
});

test("a push while another panel fills the split leaves that panel and dots Preview's icon", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(0);
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");

  // Shown once, the dot is spent.
  await tab(page, "preview").click();
  await expect(panel(page)).toHaveAttribute("data-active", "preview");
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(0);
});

const scopeTo = (page: Page, sid: string) =>
  page.evaluate((s) => (window as any).__fab.setSessionScope(s, "/proj"), sid);

test("a Preview pushed behind Drafts stays pending across chat switches", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);

  for (let i = 0; i < 2; i++) {
    await scopeTo(page, "sess-B");
    await scopeTo(page, VIEWER);
    await expect(panel(page)).toHaveAttribute("data-active", "drafts");
    await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
  }
});

test("a Preview pushed behind Drafts stays pending after switching to another panel and chat", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await tab(page, "todos").click();
  await expect(panel(page)).toHaveAttribute("data-active", "todos");

  await scopeTo(page, "sess-B");
  await scopeTo(page, VIEWER);
  await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
});

test("a Preview pushed to a background chat is still pending on the second return to it", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await tab(page, "drafts").click();
  await scopeTo(page, "sess-B");
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);

  for (let i = 0; i < 2; i++) {
    await scopeTo(page, VIEWER);
    await expect(tab(page, "preview").locator(".sp-dot")).toHaveCount(1);
    await scopeTo(page, "sess-B");
  }
});

test("a push with the split closed opens Preview in it", async ({ page }) => {
  await mountPane(page, PREVIEW_MOCKS);
  await fireEvent(page, "preview", [{ snapshot: { ...PREVIEW_MOCKS.list_previews[0], id: "snap-2", version: 3 } }]);
  await expect(panel(page)).toHaveAttribute("data-active", "preview");
  await expect(panel(page)).toBeVisible();
});

test("Revise opens its preset menu over the draft editor", async ({ page }) => {
  await mountPane(page);
  await tab(page, "drafts").click();
  await page.locator(".dr-card").click();
  await page.locator("[data-revise]").click();

  const items = page.locator("[data-revise-preset]");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toBeVisible();
  await expect(page.locator(".dr-rv-scope")).toHaveText("Whole draft");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/split-panels-revise.png` });
});

test("in the Chats window the strip ends in a GLOBAL group: Jarvis on the boundary, then Dashboard / Schedule / Settings", async ({ page }) => {
  await mountPane(page, {}, 1280, true);
  const group = page.locator(".sp-strip .sp-global");
  await expect(group.locator("[data-rail-jarvis]")).toHaveCount(1);
  const go = await group.locator("[data-rail-go]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.railGo));
  expect(go).toEqual(["dashboard", "schedule", "settings"]);
  // Chat tools stay on top and the group is pushed to the strip's bottom edge.
  const geo = await page.evaluate(() => {
    const strip = document.querySelector(".sp-strip")!.getBoundingClientRect();
    const group = document.querySelector(".sp-global")!.getBoundingClientRect();
    const lastTab = [...document.querySelectorAll(".sp-strip > .sp-tab")].pop()!.getBoundingClientRect();
    return { stripBottom: strip.bottom, groupBottom: group.bottom, groupTop: group.top, lastTabBottom: lastTab.bottom };
  });
  expect(geo.groupTop).toBeGreaterThan(geo.lastTabBottom);
  expect(Math.round(geo.groupBottom)).toBeGreaterThanOrEqual(Math.round(geo.stripBottom) - 12);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/rail-global-group.png` });
});

test("in the Chats window with no chat open, the standalone rail carries the GLOBAL group", async ({ page }) => {
  await mountPane(page, {}, 1280, true);
  await page.evaluate(async () => {
    (await import("/shared/navigation.ts")).setActiveView("sessions");
    const rail = await import("/shared/app-rail.ts");
    rail.mountAppRail();
    // The strip announced itself before this rail existed (boot mounts the rail first).
    rail.announceSplitStrip(true);
  });
  const solo = page.locator("#app-rail");
  await expect(solo).toBeHidden();

  // The last chat closes: the strip leaves with the FAB host.
  await page.evaluate(() => (window as any).__fab.setSessionScope(null, null));
  await expect(solo).toBeVisible();
  await expect(solo.locator('[data-rail-go="dashboard"]')).toBeVisible();

  await page.evaluate(() => (window as any).__fab.setSessionScope("sess-A", "/proj"));
  await expect(solo).toBeHidden();
});

test("outside the Chats window the strip has no global group", async ({ page }) => {
  await mountPane(page);
  await expect(page.locator(".sp-global")).toHaveCount(0);
});

// ── Dashboard and Schedule in the side panel (Joe, 2026-11-02) ──────────────
// The GLOBAL group's Dashboard and Schedule open beside the chat in the same
// split as the chat tools, at their own remembered width, instead of replacing
// the whole window. The real views render inside, so these mock their commands.

const GLOBAL_MOCKS = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_accounts: [],
  get_usage_map: {},
  get_auth_state_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  list_instances: [],
  poll_now: null,
  schedule_list: [],
  schedule_list_external: [],
};

const globalTab = (page: Page, view: string) => page.locator(`.sp-strip:not(#app-rail) [data-rail-go="${view}"]`);

/** The Chats window with a chat open on a blank router view, so no second
 *  full-screen dashboard competes with the panel's, and the standalone rail
 *  mounted the way boot does. */
async function mountChatsWindow(page: Page, mocks: Record<string, unknown> = GLOBAL_MOCKS): Promise<void> {
  await mountPane(page, mocks, 1280, true, "blank");
  await page.evaluate(async () => {
    (await import("/shared/navigation.ts")).setActiveView("sessions");
    const rail = await import("/shared/app-rail.ts");
    rail.mountAppRail();
    // The strip announced itself before this rail existed (boot mounts the rail first).
    rail.announceSplitStrip(true);
  });
}

test("Dashboard in the GLOBAL group opens the real dashboard in a 400px panel; the same icon closes it", async ({ page }) => {
  await mountChatsWindow(page);
  await globalTab(page, "dashboard").click();

  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-active", "dashboard");
  await expect(panel(page).locator(".sp-title")).toHaveText("Dashboard");
  await expect(panel(page).locator(".view-dashboard")).toHaveCount(1);
  await expect(globalTab(page, "dashboard")).toHaveAttribute("aria-pressed", "true");
  await expect(globalTab(page, "dashboard")).toHaveClass(/is-on/);

  const p = (await panel(page).boundingBox())!;
  expect(Math.abs(p.width - 400)).toBeLessThanOrEqual(2);
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W - 6 - Math.round(p.width));

  // The view's own title row would repeat the panel's header; its kebab stays.
  await expect(panel(page).locator(".view-header h2")).toBeHidden();
  await expect(panel(page).locator(".view-header .burger")).toBeHidden();
  await expect(panel(page).locator("#dashMoreBtn")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/global-panel-dashboard-with-chat.png` });

  await globalTab(page, "dashboard").click();
  await expect(panel(page)).toBeHidden();
  await expect(panel(page).locator(".view-dashboard")).toHaveCount(0);
  expect(Math.round(await chatWidth(page))).toBe(1280 - STRIP_W);
});

test("Schedule opens in the same panel, without its own title row or Chats button", async ({ page }) => {
  await mountChatsWindow(page);
  await globalTab(page, "schedule").click();
  await expect(panel(page)).toHaveAttribute("data-active", "schedule");
  await expect(panel(page).locator(".sp-title")).toHaveText("Schedule");
  await expect(panel(page).locator(".view-schedule")).toHaveCount(1);
  await expect(panel(page).locator(".view-header")).toBeHidden();

  // Swapping to Dashboard tears Schedule down: one panel at a time.
  await globalTab(page, "dashboard").click();
  await expect(panel(page)).toHaveAttribute("data-active", "dashboard");
  await expect(panel(page).locator(".view-schedule")).toHaveCount(0);
  await expect(globalTab(page, "schedule")).toHaveAttribute("aria-pressed", "false");
});

test("a global panel stays open across chat switches and is never written into a chat's remembered panel", async ({ page }) => {
  await mountChatsWindow(page);
  await globalTab(page, "dashboard").click();
  await expect(panel(page)).toBeVisible();

  await scopeTo(page, "sess-B");
  await expect(panel(page)).toHaveAttribute("data-active", "dashboard");
  await expect(panel(page).locator(".view-dashboard")).toHaveCount(1);
  await expect(globalTab(page, "dashboard")).toHaveAttribute("aria-pressed", "true");

  const stored = await page.evaluate(() => localStorage.getItem("cc.split.active"));
  expect(stored ?? "").not.toMatch(/dashboard|schedule/);
});

test("a chat tool replaces the global panel, and closing a global panel brings back the chat's own", async ({ page }) => {
  await mountChatsWindow(page);
  await tab(page, "drafts").click();
  await globalTab(page, "dashboard").click();
  await expect(panel(page)).toHaveAttribute("data-active", "dashboard");
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "false");

  await tab(page, "todos").click();
  await expect(panel(page)).toHaveAttribute("data-active", "todos");
  await expect(globalTab(page, "dashboard")).toHaveAttribute("aria-pressed", "false");
  await expect(panel(page).locator(".view-dashboard")).toHaveCount(0);

  await tab(page, "drafts").click();
  await globalTab(page, "schedule").click();
  await panel(page).locator('[data-sp-act="close"]').click();
  await expect(panel(page)).toHaveAttribute("data-active", "drafts");
  await expect(tab(page, "drafts")).toHaveAttribute("aria-pressed", "true");
});

test("with no chat open the panel is still reachable, and the standalone rail and the strip never both show or both vanish", async ({ page }) => {
  await mountChatsWindow(page);
  const solo = page.locator("#app-rail");
  const strips = page.locator(".sp-strip:not(#app-rail)");
  await expect(solo).toBeHidden();

  await page.evaluate(() => (window as any).__fab.setSessionScope(null, null));
  await expect(solo).toBeVisible();
  await expect(strips).toHaveCount(0);

  // The standalone rail's own Dashboard opens the panel.
  await solo.locator('[data-rail-go="dashboard"]').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".view-dashboard")).toHaveCount(1);
  await expect(solo).toBeHidden();
  await expect(strips).toHaveCount(1);
  // No chat, so no chat tools: only the way to close it or switch screens.
  await expect(page.locator(".sp-strip .sp-tab[data-sp-k]")).toHaveCount(0);
  await expect(globalTab(page, "dashboard")).toHaveAttribute("aria-pressed", "true");
  const p = (await panel(page).boundingBox())!;
  expect(Math.abs(p.width - 400)).toBeLessThanOrEqual(2);
  expect(Math.round(p.x + p.width)).toBe(1280 - STRIP_W);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/global-panel-dashboard-no-chat.png` });

  await globalTab(page, "schedule").click();
  await expect(panel(page)).toHaveAttribute("data-active", "schedule");

  await globalTab(page, "schedule").click();
  await expect(panel(page)).toBeHidden();
  await expect(solo).toBeVisible();
  await expect(strips).toHaveCount(0);
  expect(await page.locator(".session-pane").evaluate((el) => getComputedStyle(el).paddingRight)).toBe("0px");
});

test("a global panel keeps its own width, apart from the chat panels' shared fraction", async ({ page }) => {
  await mountChatsWindow(page);
  await globalTab(page, "dashboard").click();
  const div = (await page.locator(".sp-divider").boundingBox())!;
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(div.x - 100, div.y + 200, { steps: 8 });
  await page.mouse.up();
  const widened = (await panel(page).boundingBox())!.width;
  expect(Math.abs(widened - 500)).toBeLessThanOrEqual(3);

  // The chat panels still open at half and half.
  await tab(page, "drafts").click();
  const draftsW = (await panel(page).boundingBox())!.width;
  expect(Math.abs(draftsW - (1280 - STRIP_W - 6) / 2)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => localStorage.getItem("cc.split.fraction"))).toBeNull();

  // And the dashboard comes back at the width he left it.
  await globalTab(page, "dashboard").click();
  expect(Math.abs((await panel(page).boundingBox())!.width - widened)).toBeLessThanOrEqual(2);
});

test("the tray's route into the dashboard opens the panel instead of replacing the window", async ({ page }) => {
  await mountChatsWindow(page);
  await page.evaluate(() => (window as any).navigateTo("dashboard"));
  await expect(panel(page)).toHaveAttribute("data-active", "dashboard");
  await expect(page.locator("#app .view-dashboard")).toHaveCount(0);
  expect(await page.evaluate(async () => (await import("/shared/navigation.ts")).getActiveView())).toBe("sessions");
});

test("the dashboard's account cards stack in the 400px panel, with no ring past its card's edge", async ({ page }) => {
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const snap = (five: number, seven: number) => ({
    captured_at: new Date().toISOString(),
    five_hour: { utilization: five, resets_at: at(2) },
    seven_day: { utilization: seven, resets_at: at(48) },
  });
  await mountChatsWindow(page, {
    ...GLOBAL_MOCKS,
    list_accounts: [
      { id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" },
      { id: "acc-2", label: "Work", icon: "user", colour: "#f59e0b" },
    ],
    get_usage_map: { "acc-1": snap(40, 20), "acc-2": snap(15, 60) },
  });
  await globalTab(page, "dashboard").click();
  await expect(panel(page).locator(".dash-acard .dash-ring").first()).toBeVisible();

  const cards = await panel(page).locator(".dash-acard").evaluateAll((els) =>
    els.map((el) => {
      const c = el.getBoundingClientRect();
      return {
        top: c.top,
        overflow: Math.max(...[...el.querySelectorAll(".dash-ring")].map((r) => r.getBoundingClientRect().right - c.right)),
      };
    }),
  );
  expect(cards).toHaveLength(2);
  expect(cards[1]!.top).toBeGreaterThan(cards[0]!.top);
  for (const c of cards) expect(c.overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/dashboard-panel-stacked-cards.png` });
});
