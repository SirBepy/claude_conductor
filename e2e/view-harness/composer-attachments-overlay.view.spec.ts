// Reviewed 2026-11-19 (pc-1789, the lightbox steps through a group of images with arrows, buttons and a swipe): only the image click handler changed; the "N attachments" count assertions fail intermittently on HEAD as well (an identical-bytes duplicate chip drops itself after upload), unchanged by this commit.
// asserts: src/shared/chat/composer.css, src/shared/chat/composer-attachments.ts
import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE } from "./harness";
import { conductorHistory, conductorSnapshot } from "./project-dashboard-fixtures";

// Attached images used to take a row of the composer, which shrank the pane and
// cut the dashboard off at the row's top edge with dead dark space around the
// thumbnails (pc-1743). The row now floats over the bottom of the content: it
// leaves the composer's height alone, lets clicks through between thumbnails, and
// the content scrolls clear of it with its own bottom padding.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const box = (page: Page) => page.locator("#session-pane .session-composer .composer-textarea");
const row = (page: Page) => page.locator("#session-pane .session-composer > .composer-attachments");
const attach = (page: Page, n: number) =>
  page.locator("#session-pane .composer-file-input").setInputFiles(
    Array.from({ length: n }, (_, i) => ({ name: `shot${i}.png`, mimeType: "image/png", buffer: PNG })),
  );

async function mountDraft(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [],
      dashboard_list_targets: [], dashboard_snapshot: conductorSnapshot(), dashboard_history: conductorHistory(),
      paste_attachment: "C:/tmp/pasted.png",
    },
  });
  await page.waitForFunction(() => {
    document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
    const pane = document.querySelector<HTMLElement>("#session-pane");
    return !!pane && pane.offsetParent !== null;
  });
  await page.evaluate(async () => {
    const flow = await import("/views/sessions/pending-flow.ts");
    const pane = document.querySelector<HTMLElement>("#session-pane")!;
    await flow.launchNewSession(
      pane,
      { path: "C:/Projects/alpha", name: "Alpha" },
      { model: "claude-opus-5", effort: "high", accountId: null, characterId: null, autoAccept: true },
    );
  });
  await box(page).waitFor();
}

// A busy turn shows the one-line thinking strip above the composer. The thumbnails
// used to drop back into the composer's row then; they float above the strip.
test("attached thumbnails float above the thinking strip on a busy turn, never over it", async ({ page }) => {
  await mountDraft(page, 1032);
  const strip = page.locator("#session-pane .composer-shell > .session-thinking");
  await strip.evaluate((el) => el.removeAttribute("hidden"));
  await attach(page, 2);
  await expect(row(page).locator(".attachment")).toHaveCount(2);

  expect(await row(page).evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  const s = (await strip.boundingBox())!;
  const r = (await row(page).boundingBox())!;
  expect(s.height).toBeGreaterThan(0);
  expect(r.y + r.height).toBeLessThanOrEqual(s.y + 1);
  await capture(page, "composer-attachments-above-thinking-strip");

  // The opened detail block stacks there as well, so the row goes back into the composer.
  await strip.evaluate((el) => el.classList.add("is-open"));
  expect(await row(page).evaluate((el) => getComputedStyle(el).position)).toBe("static");
});

for (const [label, width] of [["desktop", 1032], ["phone width", 390]] as const) {
  test(`attached thumbnails float over the content and take no height from the pane, ${label}`, async ({ page }) => {
    await mountDraft(page, width);
    const shell = page.locator("#session-pane .composer-shell");
    const before = (await shell.boundingBox())!;
    await attach(page, 3);
    await expect(row(page).locator(".attachment")).toHaveCount(3);

    const css = await row(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      const thumb = getComputedStyle(el.querySelector(".attachment")!);
      return { position: cs.position, rowEvents: cs.pointerEvents, thumbEvents: thumb.pointerEvents };
    });
    expect(css).toEqual({ position: "absolute", rowEvents: "none", thumbEvents: "auto" });

    // The composer is as tall as it was before the attachments.
    const after = (await shell.boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThan(2);
    // The row sits right above the composer, not inside it.
    const r = (await row(page).boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(after.y + 14);
    await capture(page, `composer-attachments-overlay-${label.replace(" ", "-")}`);
  });
}
