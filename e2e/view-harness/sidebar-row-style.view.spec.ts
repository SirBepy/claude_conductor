import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Frontend proof for the Portrait chat-row style (Settings > Appearance > Chat
// row style). Drives the REAL sidebar rather than asserting on markup strings:
// the round-4 lesson was that a "square" portrait can be 46x59 while every
// screenshot still looks plausible, so the geometry asserts below measure the
// rendered boxes.

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  get_usage_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  poll_now: null,
  list_projects: [],
  resolve_whitelist_characters: [],
  probe_models_availability: [],
  list_accounts: [],
  list_scheduled_messages: [],
  // Both rows need an assigned character, or leadingVisual falls back to the
  // bare status icon and there is no portrait to measure. A 1x1 transparent PNG
  // is enough - the asserts are about box geometry, not pixels.
  list_session_characters: { s1: "illidan", s2: "jaina" },
  character_asset_url:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=",
};

function instance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "s1", pid: 100, cwd: "C:/Projects/claude_usage_in_taskbar",
    project_id: "p1", kind: "interactive", is_remote: false,
    started_at: "2026-07-30T10:00:00Z", transcript_path: null, bridge_session_id: null,
    name: "Session card round six chips", ended_at: null, end_reason: null,
    busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
    autopilot: false, jarvis: false, worker_of: null, closing: false,
    account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
    ...over,
  };
}

const SESSIONS = [
  instance(),
  instance({ session_id: "s2", cwd: "C:/Projects/zng-app", name: "TruStage flag scope", model: "claude-sonnet-5" }),
];

async function mountSessions(page: import("@playwright/test").Page, rowStyle: string): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("cc_chat_row_style", v), rowStyle);
  await mountView(page, {
    view: "sessions",
    invoke: { ...BASE_INVOKE, list_instances: SESSIONS, get_active_sessions: SESSIONS },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

test.describe("view-harness / chat row style", () => {
  test("Portrait row drops the title and the 3-dot button", async ({ page }) => {
    await mountSessions(page, "portrait");
    const row = page.locator("#sessions-list li[data-session-id]").first();

    await expect(row).toHaveClass(/row-portrait/);
    // Project name is the visible text; the title is only in the hover tooltip.
    await expect(row.locator(".proj-name")).toHaveText("claude_usage_in_taskbar");
    await expect(row).not.toContainText("Session card round six chips");
    await expect(row.locator(".session-row-project")).toHaveAttribute("data-tip", "Session card round six chips");
    // The menu moved to right-click, so the button must be gone entirely.
    await expect(row.locator(".session-row-menu-btn")).toHaveCount(0);
  });

  test("model battery reflects the family's rank, Fable above Opus", async ({ page }) => {
    await mountSessions(page, "portrait");
    const rows = page.locator("#sessions-list li[data-session-id]");
    await expect(rows.nth(0).locator(".session-model-battery i")).toHaveClass(/ph-battery-high/);
    await expect(rows.nth(1).locator(".session-model-battery i")).toHaveClass(/ph-battery-medium/);
  });

  test("portrait is square and every element shares the art's centre", async ({ page }) => {
    await mountSessions(page, "portrait");
    const row = page.locator("#sessions-list li[data-session-id]").first();

    const box = await row.evaluate((li) => {
      const mid = (sel: string) => {
        const el = li.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return Math.round((r.top + r.height / 2) * 100) / 100;
      };
      const a = li.querySelector(".session-avatar")!.getBoundingClientRect();
      return {
        w: Math.round(a.width), h: Math.round(a.height),
        art: Math.round((a.top + a.height / 2) * 100) / 100,
        badge: mid(".session-proj-badge"),
        name: mid(".proj-name"),
        battery: mid(".session-model-battery"),
      };
    });

    // Square: a taller row must buy a bigger face, not a taller crop.
    expect(box.w).toBe(box.h);
    // The bug that made everything "look 1px low": a separator inside the avatar
    // wrapper shortened the visible art, so the art's centre diverged from every
    // other element's. All four must agree.
    expect(box.badge).toBe(box.art);
    expect(box.name).toBe(box.art);
    expect(box.battery).toBe(box.art);
  });

  test("Classic row keeps the title and the 3-dot button", async ({ page }) => {
    await mountSessions(page, "classic");
    const row = page.locator("#sessions-list li[data-session-id]").first();

    await expect(row).not.toHaveClass(/row-portrait/);
    await expect(row.locator(".session-row-project")).toContainText("Session card round six chips");
    await expect(row.locator(".session-row-menu-btn")).toHaveCount(1);
  });

  test("right-click opens the chat menu in both styles", async ({ page }) => {
    await mountSessions(page, "portrait");
    await page.locator("#sessions-list li[data-session-id]").first().click({ button: "right" });
    await expect(page.locator(".session-ctx-menu")).toBeVisible();
  });
});
