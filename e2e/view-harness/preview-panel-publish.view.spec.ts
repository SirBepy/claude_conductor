import { test, expect } from "@playwright/test";
import { mountSessionsLayout, mountView, invokeCalls, capture } from "./harness";

// "Publish to claude.ai" lives in the preview panel's More options menu: a
// snapshot whose link is behind its version offers "Update on claude.ai",
// clicking it sends the preview id to the daemon, and the toast hands Joe the
// link to share. Mount pattern copied from
// preview-panel-reply-composer.view.spec.ts.

const LINK = { url: "https://claude.ai/artifact/RF7sSgiE3L4UG83rp6Q4GD", version: 3, account: "Joe", published_at: "now" };

test("the More options menu publishes the shown snapshot and toasts the link", async ({ page }) => {
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
  // mountSessionsLayout pins its view at z-index 9999 (harness.ts), above the
  // app's toast stack (z 3000) and the menu, which the real app never does.
  await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".view-sessions");
    if (view) view.style.zIndex = "1";
  });

  const root = page.locator('.pw-window[data-active="preview"]');
  await expect(root.locator(".pv-head [data-publish]")).toHaveCount(0);
  await root.locator('.pv-head [data-act="more"]').click();
  const item = page.locator(".smore-item[data-publish]");
  await expect(item).toHaveText("Update on claude.ai");
  await page.waitForTimeout(250);
  await capture(page, "preview-publish-menu");

  await item.click();
  await expect(page.locator(".toast-msg").last()).toContainText("claude.ai/artifact/RF7sSgiE3L4UG83rp6Q4GD");
  const call = (await invokeCalls(page)).find((c) => c.cmd === "publish_to_claude_ai");
  expect(call?.args).toEqual({ id: "snap-1" });

  // Now current: the menu offers a copy, not another upload.
  await root.locator('.pv-head [data-act="more"]').click();
  await expect(page.locator(".smore-item[data-publish]")).toHaveText("Copy claude.ai link");
});
