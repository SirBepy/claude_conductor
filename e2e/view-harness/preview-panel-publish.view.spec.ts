import { test, expect } from "@playwright/test";
import { mountSessionsLayout, mountView, invokeCalls, capture } from "./harness";

// "Publish to claude.ai" in the preview panel header: a snapshot
// whose link is behind its version shows the upload icon, clicking it sends
// the preview id to the daemon, and the toast hands Joe the link to share.
// Mount pattern copied from preview-panel-reply-composer.view.spec.ts.

const LINK = { url: "https://claude.ai/artifact/RF7sSgiE3L4UG83rp6Q4GD", version: 3, account: "Joe", published_at: "now" };

test("the preview header publishes the shown snapshot and toasts the link", async ({ page }) => {
  const stale = { ...LINK, version: 2 };
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "handover-report", title: "Handover report", source: "chat",
          session_id: "sess-1", version: 3, created_at: new Date().toISOString(), published: stale,
        },
      ],
      get_preview: {
        id: "snap-1", slug: "handover-report", title: "Handover report",
        html: "<main style='padding:24px;font-family:system-ui'><h1>Handover</h1><p>State of the app.</p></main>",
        source: "chat", session_id: "sess-1", version: 3, created_at: new Date().toISOString(), published: stale,
      },
      publish_to_claude_ai: LINK,
      render_preview_doc: "data:text/html,<body style='background:#15151e;color:#e0e0e0;font-family:system-ui;padding:24px'><h1>Handover</h1><p>State of the app.</p></body>",
    },
  });
  await mountSessionsLayout(page);
  await page.evaluate(() => (window as unknown as { __preview: { open(id: string): void } }).__preview.open("snap-1"));

  const root = page.locator('.pw-window[data-active="preview"]');
  const btn = root.locator(".pv-head [data-publish]");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("data-publish-state", "stale");
  await capture(root.locator(".pv-head"), "preview-publish-button-stale");

  await btn.click();
  await expect(page.locator(".toast-msg").first()).toContainText("claude.ai/artifact/RF7sSgiE3L4UG83rp6Q4GD");
  await expect(btn).toHaveAttribute("data-publish-state", "current");
  await expect(page.locator(".toast.show").first()).toBeVisible();
  // .toast fades in over 180ms (toast.css); toBeVisible ignores opacity.
  await page.waitForTimeout(300);
  // mountSessionsLayout pins its view at z-index 9999 (harness.ts), above the
  // app's toast stack (z 3000), which the real app never does; lower it so
  // the shot shows the toast Joe actually sees.
  await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".view-sessions");
    if (view) view.style.zIndex = "1";
  });
  await capture(page, "preview-publish-after-click");

  const call = (await invokeCalls(page)).find((c) => c.cmd === "publish_to_claude_ai");
  expect(call?.args).toEqual({ params: { target: "preview", id: "snap-1" } });
});
