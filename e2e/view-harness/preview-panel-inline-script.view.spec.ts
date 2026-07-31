import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for a bug where a pushed preview's inline <script> never ran in
// the panel's iframe (srcdoc inherits+intersects the parent app's CSP; fixed
// by loading a data: URL instead, which gets a fresh, un-inherited CSP).
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="stage"></div>
<script>document.getElementById("stage").innerHTML = "<p>rendered</p>";</script>
</body></html>`;

test("preview panel iframe executes a pushed snapshot's inline script", async ({ page }) => {
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "fixture", title: "Fixture", source: "terminal",
          session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
        },
      ],
      get_preview: {
        id: "snap-1", slug: "fixture", title: "Fixture", html: FIXTURE_HTML,
        source: "terminal", session_id: "sess-1", version: 1, created_at: new Date().toISOString(),
      },
    },
  });

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/preview-panel.ts");
    const root = document.createElement("div");
    root.id = "preview-panel-host";
    document.body.appendChild(root);
    const controller = mod.renderPreview(root, { mode: "panel" });
    controller.setSessionScope("sess-1");
    controller.open("snap-1");
  });

  const frame = page.frameLocator("#preview-panel-host iframe.pv-iframe");
  await expect(frame.locator("#stage p")).toHaveText("rendered");
});
