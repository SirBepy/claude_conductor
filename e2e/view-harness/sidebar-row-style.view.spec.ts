// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-16 (chat heads, pc-1769): a row is a 44px head; the title lines and the notch are gone (hover card and aria-label carry the title), and the head menu has no Freeze item (freezing is invisible now).
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/chat-heads.css
// Reviewed 2026-11-09: the sidebar right-click menu is a flat Copy PID / Freeze / Hide / Close list (chat-menu.ts buildRowMenuBlock); the right-click test asserts it.
import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView } from "./harness";

// Drives the REAL sidebar, not markup strings: a "square" portrait can be
// 46x59 while every screenshot still looks plausible, so the asserts below
// measure rendered boxes.
//
// Todo 604: Classic deleted, Portrait won. This spec now covers Portrait
// only - the old Classic-vs-Portrait comparison tests are gone.

// Both rows need an assigned character, or the head falls back to a bare
// placeholder face and there is no portrait to measure. A 1x1 transparent PNG
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
  test("a head carries no title text, names itself for a screen reader, and has no 3-dot button", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator("#sessions-list li[data-session-id]").first();

    await expect(row).toHaveClass(/chat-head/);
    // The title and project name are the hover card's and the aria-label's, never text on the head.
    await expect(row).not.toContainText("Session card round six chips");
    await expect(row).toHaveAttribute("aria-label", "Session card round six chips, claude_usage_in_taskbar");
    // The menu is right-click, so the button must be gone entirely.
    await expect(row.locator(".session-row-menu-btn")).toHaveCount(0);
  });

  test("model battery reflects the family's rank, Fable above Opus", async ({ page }) => {
    await mountSessions(page);
    const rows = page.locator("#sessions-list li[data-session-id]");
    await expect(rows.nth(0).locator(".chat-head-battery i")).toHaveClass(/ph-battery-high/);
    await expect(rows.nth(1).locator(".chat-head-battery i")).toHaveClass(/ph-battery-medium/);
  });

  test("the face is a circle with no ring over it, and the badge and battery sit level in the bottom corners", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator("#sessions-list li[data-session-id]").first();

    const box = await row.evaluate((li) => {
      const rect = (sel: string) => li.querySelector(sel)!.getBoundingClientRect();
      const mid = (sel: string) => {
        const r = rect(sel);
        return { x: Math.round((r.left + r.width / 2) * 100) / 100, y: Math.round((r.top + r.height / 2) * 100) / 100 };
      };
      const face = rect(".chat-head-face");
      const portrait = li.querySelector(".chat-head-portrait")!;
      return {
        w: Math.round(face.width), h: Math.round(face.height),
        portraitRadius: getComputedStyle(portrait).borderRadius,
        rings: li.querySelectorAll(".avatar-ring").length,
        faceMid: mid(".chat-head-face"), badge: mid(".chat-head-badge"), battery: mid(".chat-head-battery"),
      };
    });

    // Circle, not square-with-corners: the face is a bounding-box square and the picture resolves full-round.
    expect(box.w).toBe(box.h);
    expect(box.portraitRadius).toBe("50%");
    // A head draws no status ring over its face.
    expect(box.rings).toBe(0);
    // The two corner marks sit at the same height (the bottom edge) on opposite sides of the face's centre.
    expect(box.badge.y).toBe(box.battery.y);
    expect(box.badge.y).toBeGreaterThan(box.faceMid.y);
    expect(box.badge.x).toBeLessThan(box.faceMid.x);
    expect(box.battery.x).toBeGreaterThan(box.faceMid.x);
  });

  test("a head has no status dot and no left-edge stripe", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator("#sessions-list li[data-session-id]").first();
    await row.evaluate((li) => li.classList.add("needs-attention", "is-rate-limited"));

    // No dot and no ring: the one number in the corner is the status signal.
    await expect(row.locator(".avatar-status-dot")).toHaveCount(0);

    // needs-attention/rate-limited no longer paint a left-edge box-shadow/::before
    // on portrait rows.
    const stripes = await row.evaluate((li) => {
      const s = getComputedStyle(li);
      const before = getComputedStyle(li, "::before");
      return { boxShadow: s.boxShadow, beforeContent: before.content };
    });
    // A head keeps its resting box-shadow layers (the open chat ring, all zero-width at rest);
    // what must not exist is a painted stripe, so every length in it is 0.
    expect([...stripes.boxShadow.matchAll(/-?\d+(?:\.\d+)?px/g)].every((m) => parseFloat(m[0]) === 0)).toBe(true);
    // No ::before is generated at all ("none" or "normal" depending on the engine).
    expect(["none", "normal"]).toContain(stripes.beforeContent);
  });

  test("right-click opens the flat three-item head menu, with no Freeze item", async ({ page }) => {
    await mountSessions(page);
    await page.locator("#sessions-list li[data-session-id]").first().click({ button: "right" });
    await expect(page.locator(".session-ctx-menu")).toBeVisible();
    await expect(page.locator(".session-ctx-menu .smore-item")).toHaveText(["Copy PID", "Hide chat", "Close session"]);
  });
});
