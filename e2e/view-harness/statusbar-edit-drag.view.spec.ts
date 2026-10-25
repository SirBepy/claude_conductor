// asserts: src/views/sessions/statusbar-edit.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, invokeCalls } from "./harness";

// jsdom has no layout, so tests/statusbar-edit-mode.test.mjs cannot cover the
// drag hit-test (elementFromPoint + chip midpoints). This drives it with the
// real pointer in a real browser and checks both the DOM and the saved layout.

const SESSIONS = [sessionInstance()];
const ROWS = [["clock", "duration", "turns"], ["messages"]];

async function enterEditMode(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      set_session_effort: null,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      get_settings: { theme: "void", statuslineRows: ROWS, statuslineRowsMobile: ROWS },
      save_settings: null,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-row").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#session-pane .sb-row").first().click({ button: "right", position: { x: 4, y: 4 } });
  await page.locator("#session-pane .sb-edit-chip").first().waitFor();
}

const domOrder = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#session-pane .sb-edit-row")]
      .map((r) => [...r.querySelectorAll<HTMLElement>(".sb-edit-chip")].map((c) => c.dataset.type)),
  );

async function lastSavedRows(page: Page): Promise<unknown> {
  const saves = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings");
  return (saves.at(-1)?.args as { updated?: { statuslineRows?: unknown } } | undefined)?.updated?.statuslineRows;
}

/** Real pointer drag from the centre of one chip to a point inside another. */
async function drag(page: Page, from: string, to: { x: number; y: number }): Promise<void> {
  const box = (await page.locator(`#session-pane .sb-edit-chip[data-type="${from}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("view-harness / statusbar edit drag", () => {
  test("dragging chip A past chip B reorders within the row and saves", async ({ page }) => {
    await enterEditMode(page);
    expect(await domOrder(page)).toEqual([["clock", "duration", "turns"], ["messages"]]);

    // Drop on the right half of "turns" => after it.
    const turns = (await page.locator('#session-pane .sb-edit-chip[data-type="turns"]').boundingBox())!;
    await drag(page, "clock", { x: turns.x + turns.width - 3, y: turns.y + turns.height / 2 });

    await expect.poll(() => domOrder(page)).toEqual([["duration", "turns", "clock"], ["messages"]]);
    await expect.poll(() => lastSavedRows(page)).toEqual([["duration", "turns", "clock"], ["messages"]]);
  });

  test("dragging a chip into the second row moves it and saves", async ({ page }) => {
    await enterEditMode(page);
    const msg = (await page.locator('#session-pane .sb-edit-chip[data-type="messages"]').boundingBox())!;
    // Left half of "messages" => before it, in row 1.
    await drag(page, "duration", { x: msg.x + 3, y: msg.y + msg.height / 2 });

    await expect.poll(() => domOrder(page)).toEqual([["clock", "turns"], ["duration", "messages"]]);
    await expect.poll(() => lastSavedRows(page)).toEqual([["clock", "turns"], ["duration", "messages"]]);
  });

  test("a sub-threshold press-and-release is a click, not a drag", async ({ page }) => {
    await enterEditMode(page);
    const box = (await page.locator('#session-pane .sb-edit-chip[data-type="duration"]').boundingBox())!;
    const before = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings").length;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
    await page.mouse.up();
    expect(await domOrder(page)).toEqual([["clock", "duration", "turns"], ["messages"]]);
    expect((await invokeCalls(page)).filter((c) => c.cmd === "save_settings").length).toBe(before);
  });
});
