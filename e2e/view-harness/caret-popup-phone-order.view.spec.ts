import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// asserts: src/shared/chat/caret-popup/popup.css
// On a phone the "/" popup's best match sits at the bottom, next to the input
// and the thumb; desktop keeps it on top. Also the first row a phone sees
// without scrolling, even when the list overflows the popup's max-height.

const ITEMS = Array.from({ length: 12 }, (_, i) => `cmd${i}`);

async function openPopup(page: Page): Promise<void> {
  await mountView(page);
  await page.evaluate(async (items) => {
    await import("/shared/chat/caret-popup/popup.css");
    const { CaretSuggestPopup } = await import("/shared/chat/caret-popup/popup.ts");
    const anchor = document.createElement("div");
    anchor.style.cssText = "position:fixed;left:0;right:0;bottom:20px;";
    const ta = document.createElement("textarea");
    anchor.appendChild(ta);
    document.body.appendChild(anchor);
    const popup = new CaretSuggestPopup({
      anchor,
      textarea: ta,
      providers: [{
        triggerChar: "/",
        shouldTrigger: ({ textBefore }: { textBefore: string }) => textBefore.startsWith("/"),
        query: () => items,
        renderRow: (item: unknown, selected: boolean) => {
          const row = document.createElement("div");
          row.className = `row${selected ? " selected" : ""}`;
          row.dataset.item = String(item);
          row.textContent = `/${String(item)}`;
          return row;
        },
        onPick: () => {},
      }],
    });
    ta.value = "/c";
    ta.setSelectionRange(2, 2);
    popup.handleInput();
  }, ITEMS);
  await expect(page.locator(".caret-popup .row").first()).toBeVisible();
}

async function rowTops(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector<HTMLElement>(".caret-popup")!;
    const pr = popup.getBoundingClientRect();
    const first = popup.querySelector<HTMLElement>("[data-item='cmd0']")!.getBoundingClientRect();
    const second = popup.querySelector<HTMLElement>("[data-item='cmd1']")!.getBoundingClientRect();
    return { popupTop: pr.top, popupBottom: pr.bottom, firstTop: first.top, firstBottom: first.bottom, secondTop: second.top };
  });
}

test.describe("view-harness / caret popup best match next to the input", () => {
  test("phone: best match is the bottom row, visible without scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openPopup(page);
    const m = await rowTops(page);
    expect(m.firstTop).toBeGreaterThan(m.secondTop);
    expect(m.firstBottom).toBeLessThanOrEqual(m.popupBottom + 1);
    expect(m.popupBottom - m.firstBottom).toBeLessThan(4);
  });

  test("desktop: best match stays the top row", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openPopup(page);
    const m = await rowTops(page);
    expect(m.firstTop).toBeLessThan(m.secondTop);
    expect(m.firstTop - m.popupTop).toBeLessThan(4);
  });
});
