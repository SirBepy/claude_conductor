// Reviewed 2026-10-25 (project dashboard moved into new-chat drafts and a page opened from the chat header's project name; the Projects tab, Projects page and project page are gone): this spec drives none of those surfaces and passed after the change, so its contract is unaffected.
import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView, invokeCalls, sessionInstance } from "./harness";

// Preview panel reply composer (ai_todo composer-unification, task 5): a
// compact composer docked at the bottom of the panel sends a user message to
// whichever session pushed the currently-viewed snapshot, auto-tagged with a
// reference to it. Mirrors preview-panel-inline-script.view.spec.ts's mount
// pattern (the pane's Preview window, no full sessions-view boot), but also
// seeds src/views/sessions/state.ts's `state.sessions` directly - the send
// path resolves the owning session's `cwd` from there, same as the main
// composer's send_message call.

async function openPreview(page: Page, opts: { header?: boolean } = {}): Promise<void> {
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "fixture", title: "Login flow", source: "chat",
          session_id: "sess-1", version: 3, created_at: new Date().toISOString(),
        },
      ],
      get_preview: {
        id: "snap-1", slug: "fixture", title: "Login flow", html: "<p>hi</p>",
        source: "chat", session_id: "sess-1", version: 3, created_at: new Date().toISOString(),
      },
      send_message: "ok",
    },
  });

  await page.evaluate(async (session) => {
    const stateMod = await import("/views/sessions/state.ts");
    stateMod.state.sessions.push(session);
  }, sessionInstance({ session_id: "sess-1", cwd: "/fake/project" }));
  await mountSessionsLayout(page, opts);
  await page.evaluate(() => (window as unknown as { __preview: { open(id: string): void } }).__preview.open("snap-1"));
}

test("the reply bar is hidden on desktop, where the chat's own composer is beside the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPreview(page);
  await expect(page.locator('.sp-panel[data-active="preview"] .pv-canvas')).toBeVisible();
  await expect(page.locator('.sp-panel[data-active="preview"] .pv-composer')).toBeHidden();
});

test("typing in the preview reply composer and pressing Enter sends a tagged message to the owning session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openPreview(page, { header: true });

  // A phone-width mount gets the pane windows' full-screen cover, not the
  // desktop split's `.sp-panel` (fab-dial.ts usesSplit), so no panel scope.
  const input = page.locator(".pv-composer-input");
  await expect(input).toBeVisible();
  await input.fill("looks off on mobile");
  // Phone-width composers treat Enter as a newline (composer-core/core.ts), so send via the arrow.
  await page.locator(".pv-composer-send").click();

  await expect(input).toHaveValue("");

  const calls = await invokeCalls(page);
  const sendCall = calls.find((c) => c.cmd === "send_message");
  expect(sendCall).toBeTruthy();
  const args = sendCall!.args as { sessionId: string; cwd: string; blocks: Array<{ type: string; text: string }> };
  expect(args.sessionId).toBe("sess-1");
  expect(args.cwd).toBe("/fake/project");
  expect(args.blocks[0]?.text).toContain("[re: preview v3 - Login flow]");
  expect(args.blocks[0]?.text).toContain("looks off on mobile");
});
