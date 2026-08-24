import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView } from "./harness";

// Drives the REAL sidebar, not markup strings: a "square" portrait can be
// 46x59 while every screenshot still looks plausible, so the asserts below
// measure rendered boxes.
//
// Todo 604: Classic deleted, Portrait won. This spec now covers Portrait
// only - the old Classic-vs-Portrait comparison tests are gone.

// Both rows need an assigned character, or leadingVisual falls back to the
// bare status icon and there is no portrait to measure. A 1x1 transparent PNG
// is enough - the asserts are about box geometry, not pixels.
const CHARACTER_INVOKE = {
  list_session_characters: { s1: "illidan", s2: "jaina" },
  character_asset_url:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=",
};

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({
    cwd: "C:/Projects/claude_usage_in_taskbar", name: "Session card round six chips", ...over,
  });
}

const SESSIONS = [
  instance(),
  instance({ session_id: "s2", cwd: "C:/Projects/zng-app", name: "TruStage flag scope", model: "claude-sonnet-5" }),
];

async function mountSessions(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, ...CHARACTER_INVOKE, list_instances: SESSIONS, get_active_sessions: SESSIONS },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

test.describe("view-harness / chat row style", () => {
  test("Portrait row drops the title and the 3-dot button", async ({ page }) => {
    await mountSessions(page);
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
    await mountSessions(page);
    const rows = page.locator("#sessions-list li[data-session-id]");
    await expect(rows.nth(0).locator(".session-model-battery i")).toHaveClass(/ph-battery-high/);
    await expect(rows.nth(1).locator(".session-model-battery i")).toHaveClass(/ph-battery-medium/);
  });

  test("portrait avatar is a circle, notched for the badge, and every element shares the art's centre", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator("#sessions-list li[data-session-id]").first();

    const box = await row.evaluate((li) => {
      const mid = (sel: string) => {
        const el = li.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return Math.round((r.top + r.height / 2) * 100) / 100;
      };
      const avatarEl = li.querySelector(".session-avatar")!;
      const a = avatarEl.getBoundingClientRect();
      const style = getComputedStyle(avatarEl);
      return {
        w: Math.round(a.width), h: Math.round(a.height),
        borderRadius: style.borderRadius,
        maskImage: style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image"),
        art: Math.round((a.top + a.height / 2) * 100) / 100,
        badge: mid(".session-proj-badge"),
        name: mid(".proj-name"),
        battery: mid(".session-model-battery"),
      };
    });

    // Circle, not square-with-corners: a taller row must buy a bigger face
    // (still a bounding-box square), and border-radius must resolve full-round.
    expect(box.w).toBe(box.h);
    expect(box.borderRadius).toBe("50%");
    // Notch: a real mask-image, not the unset default.
    expect(box.maskImage).not.toBe("none");
    // The bug that made everything "look 1px low": a separator inside the avatar
    // wrapper shortened the visible art, so the art's centre diverged from every
    // other element's. All four must agree.
    expect(box.badge).toBe(box.art);
    expect(box.name).toBe(box.art);
    expect(box.battery).toBe(box.art);
  });

  test("portrait status dot renders bottom-left, replacing the left-edge stripe", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator("#sessions-list li[data-session-id]").first();
    await row.evaluate((li) => li.classList.add("needs-attention", "is-rate-limited"));

    const dot = row.locator(".avatar-status-dot");
    await expect(dot).toBeVisible();
    const dotBox = await dot.evaluate((el) => el.getBoundingClientRect());
    const avatarBox = await row.locator(".session-avatar").evaluate((el) => el.getBoundingClientRect());
    expect(dotBox.left).toBeLessThan(avatarBox.left + avatarBox.width / 2);
    expect(dotBox.bottom).toBeGreaterThan(avatarBox.top + avatarBox.height / 2);

    // The dot replaces the stripe: needs-attention/rate-limited no longer paint
    // a left-edge box-shadow/::before on portrait rows.
    const stripes = await row.evaluate((li) => {
      const s = getComputedStyle(li);
      const before = getComputedStyle(li, "::before");
      return { boxShadow: s.boxShadow, beforeDisplay: before.display };
    });
    expect(stripes.boxShadow).toBe("none");
    expect(stripes.beforeDisplay).toBe("none");
  });

  test("right-click opens the chat menu", async ({ page }) => {
    await mountSessions(page);
    await page.locator("#sessions-list li[data-session-id]").first().click({ button: "right" });
    await expect(page.locator(".session-ctx-menu")).toBeVisible();
  });
});
