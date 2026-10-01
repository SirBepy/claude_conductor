import { test, expect, type Page } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// The "Hidden (N)" group sits on the sidebar's bottom edge while there's spare
// height, and is just the last thing in the scroll when there isn't - it never
// becomes a fixed footer eating into the chat rows (Joe, 2026-10-01).

const HIDDEN_ID = "hidden-1";

function sessions(visible: number) {
  const rows = Array.from({ length: visible }, (_, i) =>
    sessionInstance({ session_id: `s${i + 1}`, pid: 100 + i, name: `Chat ${i + 1}`, cwd: `C:/Projects/p${i + 1}` }),
  );
  rows.push(sessionInstance({ session_id: HIDDEN_ID, pid: 999, name: "Hidden chat", cwd: "C:/Projects/old" }));
  return rows;
}

async function seedHidden(page: Page): Promise<void> {
  await page.addInitScript((id) => localStorage.setItem("cc_hidden_sessions", JSON.stringify([id])), HIDDEN_ID);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>("#sessions-list")!;
    const header = list.querySelector<HTMLElement>("li.session-group-hidden-toggle")!;
    const rows = [...list.querySelectorAll<HTMLElement>("li[data-session-id]")];
    return {
      listBottom: list.getBoundingClientRect().bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      overflow: list.scrollHeight - list.clientHeight,
      rowHeights: rows.map((r) => r.getBoundingClientRect().height),
      isLast: list.lastElementChild === header,
    };
  });
}

test.describe("view-harness / sidebar Hidden group pinned to the bottom", () => {
  test("tall window: Hidden sits on the bottom edge, below Closing", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await seedHidden(page);
    await mountSessionsList(page, sessions(2));
    await expect(page.locator("#sessions-list li.session-group-hidden-toggle")).toContainText("Hidden (1)");

    const m = await measure(page);
    expect(m.overflow).toBe(0);
    expect(Math.abs(m.listBottom - m.headerBottom)).toBeLessThanOrEqual(1);
    expect(m.isLast).toBe(true);
  });

  test("short window: rows keep their height and Hidden scrolls in last", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 360 });
    await seedHidden(page);
    await mountSessionsList(page, sessions(10));
    await expect(page.locator("#sessions-list li.session-group-hidden-toggle")).toBeAttached();

    const before = await measure(page);
    expect(before.overflow).toBeGreaterThan(0);
    // The list is a column flex container: rows must overflow into the scroll, never squash.
    const tallest = Math.max(...before.rowHeights);
    for (const h of before.rowHeights) expect(h).toBeGreaterThanOrEqual(tallest - 1);
    expect(before.headerBottom).toBeGreaterThan(before.listBottom);

    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>("#sessions-list")!;
      list.scrollTop = list.scrollHeight;
    });
    const after = await measure(page);
    expect(Math.abs(after.listBottom - after.headerBottom)).toBeLessThanOrEqual(1);
  });
});
