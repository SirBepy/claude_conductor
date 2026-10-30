// asserts: src/shared/chat/drill-links.ts, src/shared/chat/chat-messages-blocks.css
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// A send_message bubble's `#d:id` link renders as a quiet chip through the real
// chat CSS; click opens the detail card directly above that bubble (fixed
// height, header with a close button), a later bubble without its own
// `details` resolves the same id to the earlier body, and the chat scrolls so
// the whole card is visible.

const SHOTS = shotDir();

const LONG_BODY = Array.from({ length: 40 }, (_, i) => `- row ${i + 1} of the detail`).join("\n");

// `filler` bubbles above the chip's message put it at a chosen depth in a real
// scroller (fixed height, overflow auto), which is what the placement logic reads.
async function mountChat(page: Page, opts: { filler: number; scrollToBottom?: boolean }): Promise<void> {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async ({ filler, scrollToBottom, body }) => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const { linkifyDrillRefs, handleDrillClick } = await import("/shared/chat/drill-links.ts");
    const msg = (text: string, details?: unknown) => ({ kind: "message", text, id: "t", ts: 1, parentToolUseId: null, details });
    const host = document.createElement("div");
    host.id = "drill-harness";
    host.className = "chat-messages";
    host.style.cssText = "position:relative;height:560px;width:760px;overflow-y:auto;padding:16px";
    const pad = Array.from({ length: filler }, (_, i) => renderMessage(msg(`Earlier reply number ${i + 1}.`) as never)).join("");
    host.innerHTML =
      pad +
      renderMessage(msg("Done. There were [23 ignored tickets](#d:ign), and 4 need your call.", [{ id: "ign", label: "23 ignored tickets", body_md: body }]) as never) +
      renderMessage(msg("Reminder: the [23 ignored tickets](#d:ign) are unchanged.") as never);
    document.body.replaceChildren(host);
    host.addEventListener("click", handleDrillClick);
    linkifyDrillRefs(host, host);
    if (scrollToBottom) host.scrollTop = host.scrollHeight;
  }, { filler: opts.filler, scrollToBottom: opts.scrollToBottom ?? false, body: LONG_BODY });
}

test("drill chip opens a fixed-size card above its bubble, with a header", async ({ page }) => {
  await mountChat(page, { filler: 6, scrollToBottom: true });
  await page.locator("#drill-harness .drill-chip").nth(1).click();
  const card = page.locator(".drill-pop");
  await expect(card).toContainText("row 1 of the detail");
  await expect(card.locator(".drill-pop-title")).toHaveText("23 ignored tickets");
  const m = await card.evaluate((el) => {
    const bubble = el.closest(".msg")!;
    const host = document.getElementById("drill-harness")!;
    const body = el.querySelector(".drill-pop-body")!;
    const c = el.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return {
      h: Math.round(c.height),
      w: Math.round(c.width),
      gap: Math.round(b.top - c.bottom),
      left: Math.round(c.left - b.left),
      inHost: c.top >= h.top && c.bottom <= h.bottom && c.left >= h.left && c.right <= h.right,
      bodyScrolls: body.scrollHeight > body.clientHeight + 2,
      nextToChat: bubble.parentElement === host,
    };
  });
  expect(m.h).toBe(340);
  expect(m.w).toBe(560);
  // 8px off the bubble's padding box, so 7px off its 1px border.
  expect(m.gap).toBe(7);
  expect(m.inHost).toBe(true);
  expect(m.bodyScrolls).toBe(true);
  expect(m.nextToChat).toBe(true);
  await page.screenshot({ path: `${SHOTS}/drill-card-above.png` });
});

test("a later bubble's chip resolves the earlier definition, and toggles/closes the card", async ({ page }) => {
  await mountChat(page, { filler: 8, scrollToBottom: true });
  const chips = page.locator("#drill-harness .drill-chip");
  await expect(chips).toHaveCount(2);
  await chips.nth(1).click();
  await expect(page.locator(".drill-pop")).toContainText("row 1 of the detail");
  await expect(chips.nth(1)).toHaveAttribute("aria-expanded", "true");
  // Same chip again folds it.
  await chips.nth(1).click();
  await expect(page.locator(".drill-pop")).toHaveCount(0);
  await expect(chips.nth(1)).toHaveAttribute("aria-expanded", "false");
  // The header's close button.
  await chips.nth(0).click();
  await page.locator(".drill-pop-close").click();
  await expect(page.locator(".drill-pop")).toHaveCount(0);
  // Esc closes it when focus is in the card, and only one card is ever open.
  await chips.nth(0).click();
  await chips.nth(1).click();
  await expect(page.locator(".drill-pop")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".drill-pop")).toHaveCount(0);
});

test("the chat scrolls so a card that would sit above the viewport is fully visible", async ({ page }) => {
  await mountChat(page, { filler: 10 });
  // Put the chip's bubble at the very top edge of the scroller: no room above it on screen.
  await page.evaluate(() => {
    const host = document.getElementById("drill-harness")!;
    const bubble = host.querySelectorAll(".msg")[10]!;
    host.scrollTop = (bubble as HTMLElement).offsetTop - 4;
  });
  await page.locator("#drill-harness .drill-chip").first().click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.getElementById("drill-harness")!.getBoundingClientRect();
        const c = document.querySelector(".drill-pop")!.getBoundingClientRect();
        return c.top >= host.top && c.bottom <= host.bottom;
      }),
    )
    .toBe(true);
});

test("a card with less than its height of chat above it opens below the bubble", async ({ page }) => {
  await mountChat(page, { filler: 0 });
  await page.locator("#drill-harness .drill-chip").first().click();
  const card = page.locator(".drill-pop");
  await expect(card).toHaveClass(/below/);
  const m = await card.evaluate((el) => {
    const b = el.closest(".msg")!.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    return Math.round(c.top - b.bottom);
  });
  expect(m).toBe(7);
});

// The card is a child of the bubble, so the copy button must not copy its text.
test("copying a bubble leaves an open detail card out", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mountChat(page, { filler: 0 });
  await page.evaluate(async () => {
    const { handleCopyClick } = await import("/shared/chat/chat-click-handlers.ts");
    document.getElementById("drill-harness")!.addEventListener("click", handleCopyClick);
  });
  await page.locator("#drill-harness .drill-chip").first().click();
  await expect(page.locator(".drill-pop")).toHaveCount(1);
  await page.locator("#drill-harness .msg-copy-btn").first().click({ force: true });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("23 ignored tickets");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).not.toContain("row 1 of the detail");
});

// The card sits inside .msg, but the markdown styling still has to reach its
// body: list padding, numbered markers and code pills match the bubble's.
test("drill card body gets the bubble's markdown styling", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const { linkifyDrillRefs, handleDrillClick } = await import("/shared/chat/drill-links.ts");
    const body =
      "1. Open the page, go to the **Extraction** tab.\n" +
      "2. Every item gets keep / fix / drop.\n" +
      '3. Claude imports it: `pnpm eval label-import --set building-gold-v1 --kind extraction --file "<csv>"`\n' +
      "4. Then `pnpm eval report` scores every model.";
    const host = document.createElement("div");
    host.id = "drill-harness";
    host.className = "chat-messages";
    host.style.cssText = "position:relative;height:620px;width:760px;overflow-y:auto;padding:16px;padding-top:360px";
    host.innerHTML = renderMessage({
      kind: "message", text: "How to check: [steps](#d:how). Dane and Joe label the gold set first, then the report reruns.", id: "t", ts: 1, parentToolUseId: null,
      details: [{ id: "how", label: "How to check", body_md: body }],
    } as never);
    document.body.replaceChildren(host);
    host.addEventListener("click", handleDrillClick);
    linkifyDrillRefs(host, host);
  });
  await page.locator("#drill-harness .drill-chip").click();
  const pop = page.locator(".drill-pop");
  await expect(pop.locator("ol > li")).toHaveCount(4);
  const m = await pop.evaluate((el) => {
    const ol = el.querySelector("ol")!;
    const code = el.querySelector("li code")!;
    const body = el.querySelector(".drill-pop-body")!;
    return {
      olPad: parseFloat(getComputedStyle(ol).paddingLeft),
      popLeft: el.getBoundingClientRect().left,
      olLeft: ol.getBoundingClientRect().left,
      codeBorder: getComputedStyle(code).borderTopStyle,
      overflowsX: body.scrollWidth > body.clientWidth,
    };
  });
  expect(m.olPad).toBeGreaterThanOrEqual(18);
  expect(m.olLeft).toBeGreaterThan(m.popLeft);
  expect(m.codeBorder).toBe("solid");
  expect(m.overflowsX).toBe(false);
  await page.screenshot({ path: `${SHOTS}/drill-card-markdown.png` });
});
