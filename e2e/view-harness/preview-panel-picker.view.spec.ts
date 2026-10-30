import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView, fireEvent, capture } from "./harness";

// asserts: src/views/sessions/preview-panel.ts, src/views/sessions/preview-panel-history.ts, src/views/sessions/preview-panel.css

// The header's two pickers: the preview name and its version are plain
// dropdown triggers (no chip), each with a small down triangle in its
// bottom-right corner. A push only moves the view while the latest page of the
// preview being pushed is in view; otherwise a dot marks the picker that
// reaches it.

const PANEL = '.sp-panel[data-active="preview"]';
const NOW = new Date().toISOString();

const meta = (id: string, version: number, versions: Array<{ version: number; created_at: string }> = []) => ({
  id, slug: id, title: id, source: "chat", session_id: "sess-1", version, created_at: NOW, versions,
});

async function openPreview(page: Page, list: ReturnType<typeof meta>[]): Promise<void> {
  await mountView(page, {
    invoke: {
      list_previews: list,
      // A static map cannot vary by version; the panel's own state drives the labels.
      get_preview: { ...list[0], html: "<p>page</p>", versions: undefined },
      render_preview_doc: "about:blank",
    },
  });
  await mountSessionsLayout(page);
  // The harness pins .view-sessions at z-index 9999, above the body-level
  // popovers (500) that sit over the whole app in the real window.
  await page.addStyleTag({ content: ".sb-popover { z-index: 20000 !important; }" });
  await page.evaluate(() => (window as unknown as { __preview: { open(id?: string): void } }).__preview.open());
  await expect(page.locator(`${PANEL} .pv-name`)).not.toHaveText("No previews yet");
}

const VERSIONS = [{ version: 2, created_at: NOW }, { version: 1, created_at: NOW }];

test.describe("view-harness / preview pickers", () => {
  test("name and version are chipless triggers with a corner triangle", async ({ page }) => {
    await openPreview(page, [meta("plan", 3, VERSIONS), meta("other", 1)]);
    for (const sel of [".pv-pick-name", ".pv-pick-ver"]) {
      const info = await page.locator(`${PANEL} ${sel}`).evaluate((btn) => {
        const cs = getComputedStyle(btn);
        const tri = btn.querySelector<HTMLElement>(".pv-tri")!.getBoundingClientRect();
        const box = btn.getBoundingClientRect();
        return {
          border: cs.borderTopWidth, bg: cs.backgroundColor,
          triRight: box.right - tri.right, triBottom: box.bottom - tri.bottom, triW: tri.width, boxH: box.height,
        };
      });
      expect(info.border).toBe("0px");
      expect(info.bg).toBe("rgba(0, 0, 0, 0)");
      // In the bottom-right corner: hugging the right edge, in the lower half.
      expect(info.triRight).toBeLessThanOrEqual(6);
      expect(info.triBottom).toBeLessThanOrEqual(info.boxH / 2);
      expect(info.triW).toBeGreaterThan(0);
    }
    await expect(page.locator(`${PANEL} .pv-ver`)).toHaveText("Latest");
    await capture(page.locator(`${PANEL} .pv-head`), "preview-picker-header");
  });

  test("a lone preview with no versions shows a plain name and no version picker", async ({ page }) => {
    await openPreview(page, [meta("plan", 1)]);
    await expect(page.locator(`${PANEL} .pv-pick-ver`)).toBeHidden();
    await expect(page.locator(`${PANEL} .pv-pick-name .pv-tri`)).toBeHidden();
  });

  test("the version list opens under the trigger and picking an older one shows its label", async ({ page }) => {
    await openPreview(page, [meta("plan", 3, VERSIONS)]);
    await page.locator(`${PANEL} .pv-pick-ver`).click();
    const rows = page.locator(".pv-history-popover .pv-snap-title");
    await expect(rows).toHaveText(["Latest", "v2", "v1"]);
    await capture(page.locator(".pv-history-popover"), "preview-picker-versions");
    await rows.nth(1).click();
    await expect(page.locator(`${PANEL} .pv-ver`)).toHaveText("v2");
  });

  test("a push while an older version is in view leaves it and dots the version picker", async ({ page }) => {
    await openPreview(page, [meta("plan", 3, VERSIONS)]);
    await page.locator(`${PANEL} .pv-pick-ver`).click();
    await page.locator(".pv-history-popover .pv-snap-title", { hasText: "v1" }).click();
    await expect(page.locator(`${PANEL} .pv-ver`)).toHaveText("v1");

    await fireEvent(page, "preview", [{ snapshot: meta("plan", 4, [{ version: 3, created_at: NOW }, ...VERSIONS]) }]);
    await expect(page.locator(`${PANEL} .pv-pick-ver`)).toHaveAttribute("data-new", "");
    await expect(page.locator(`${PANEL} .pv-ver`)).toHaveText("v1");
    const dot = await page.locator(`${PANEL} .pv-pick-ver`).evaluate((el) => getComputedStyle(el, "::after").width);
    expect(dot).toBe("6px");
  });
});
