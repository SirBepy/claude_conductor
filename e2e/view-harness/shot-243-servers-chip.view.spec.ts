import { expect, test, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import type { ServerInfo } from "../../src/types/ipc.generated";

// todo 243: the `servers` chip was committed but never driven at runtime.
// Its cwd comes from the session's spawn dir, so `list_project_servers` is the
// only mock that decides count / hidden.

const DESKTOP = { width: 1400, height: 900 };
const SESSIONS = [sessionInstance({ cwd: "C:/Projects/alpha" })];
const ROW = ["model", "servers", "effort"];

const ONE_SERVER: ServerInfo[] = [{ id: "alpha:dev", name: "dev", port: 4420 }];

async function mountWithServers(page: Page, servers: ServerInfo[]): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_project_servers: servers,
      open_external: null,
      get_settings: { theme: "void", statuslineRows: [ROW], statuslineRowsMobile: [ROW] },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-row").first().waitFor();
}

/** Inlined rather than added to harness.ts (other agents own that file). */
async function dismissRowTooltip(page: Page): Promise<void> {
  await page.mouse.move(1200, 700);
  await expect(page.locator(".cc-row-tip")).toBeHidden();
  await page.waitForTimeout(400);
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("chip shows the live count and its popover lists the port", async ({ page }) => {
    await mountWithServers(page, ONE_SERVER);

    const chip = page.locator("#session-pane .sb-servers-btn");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1 live");
    // sb-chip-in runs 180ms; shooting inside it yields a half-faded row.
    await page.waitForTimeout(400);
    await dismissRowTooltip(page);
    await capture(page.locator("#session-pane .session-statusbar"), "servers-chip-count");

    await chip.click();
    const popover = page.locator(".sb-servers-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Running servers (1)");
    const row = popover.locator(".sb-servers-row");
    await expect(row).toContainText("dev");
    await expect(row).toContainText(":4420");
    await capture(popover, "servers-chip-popover");

    await row.click();
    await expect.poll(async () =>
      (await invokeCalls(page)).filter((c) => c.cmd === "open_external"),
    ).toEqual([{ cmd: "open_external", args: { url: "http://127.0.0.1:4420" } }]);
  });

  test("chip is absent when no server is running", async ({ page }) => {
    await mountWithServers(page, []);

    const row = page.locator("#session-pane .sb-row").first();
    await expect(row.locator(".sb-model-btn")).toBeVisible();
    // The skeleton clears first, so an absent chip means "resolved to zero".
    await expect(row.locator(".sb-skeleton[data-skeleton='servers']")).toHaveCount(0);
    await expect(row.locator(".sb-servers")).toHaveCount(0);
    await dismissRowTooltip(page);
    await capture(page.locator("#session-pane .session-statusbar"), "servers-chip-hidden");
  });
});
