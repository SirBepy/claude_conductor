import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance, fireEvent } from "./harness";

// Joe, 2026-10-20: holding Ctrl showed the same number (e.g. 9) on several
// rows. reconcileList keeps <li> nodes across renders and updateNode only
// ever added attributes, so a row that fell out of the top 9 kept its old
// data-kbd-hint. Only the first 9 rows may carry a badge, each value once.
//
// asserts: src/views/sessions/sidebar-anim.ts, src/views/sessions/sidebar-entries.ts

const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
const make = (cwdOf: (i: number) => string) =>
  ids.map((id, i) => sessionInstance({ session_id: id, cwd: cwdOf(i) }));

test("only 9 rows carry a unique Ctrl badge, even after the order reshuffles", async ({ page }) => {
  await mountSessionsList(page, make((i) => `C:/Projects/p${String(i).padStart(2, "0")}`));
  const list = page.locator("#sessions-list");
  await page.keyboard.down("Control");
  await expect(list).toHaveClass(/kbd-hint-active/);

  const hints = async () => list.locator("li[data-kbd-hint]").evaluateAll(
    (els) => els.map((e) => e.getAttribute("data-kbd-hint")),
  );
  expect((await hints()).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

  // Reverse the sort order so rows that held badges fall past the 9th.
  await page.evaluate((next) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) =>
      cmd === "list_instances" ? Promise.resolve(next) : orig(cmd, args);
  }, make((i) => `C:/Projects/p${String(99 - i).padStart(2, "0")}`));
  await fireEvent(page, "instances-changed", [null]);

  await expect.poll(async () => (await hints()).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  await page.keyboard.up("Control");
});
