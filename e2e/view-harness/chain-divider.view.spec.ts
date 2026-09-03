import { test, expect, type Page } from "@playwright/test";
import { mountView, capture } from "./harness";
import type { RenderedMessage } from "../../src/shared/chat/chat-transforms";

// The /respawn chain boundary through the real chat-messages CSS cascade. The
// rules are real spans, not ::before/::after, because .msg[data-ts]:hover::after
// is already the shared hover-timestamp label - this shot is what proves the
// two don't collide.

const ROWS = [
  { kind: "assistant", content: [{ type: "text", text: "Handed the daemon half over. Closing out now." }], ts: 0 },
  { kind: "system", text: "Previous chat", chainDivider: true, ts: 0 },
  { kind: "user", content: [{ type: "text", text: "We're continuing the respawn seam work." }], ts: 0 },
] satisfies RenderedMessage[];

async function mountChain(page: Page, width = 720) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(
    async ({ rows, width }) => {
      await import("/views/sessions/sessions.ts");
      const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
      const host = document.createElement("div");
      host.id = "chain-harness";
      host.className = "session-messages";
      host.style.cssText = `padding:16px;width:${width}px;max-width:${width}px`;
      host.innerHTML = rows.map((m) => renderMessage(m)).join("");
      // buildMessageEl stamps this on every row; the divider must survive it.
      host.querySelectorAll<HTMLElement>(".msg").forEach((el) => { el.dataset.ts = "10:42"; });
      document.body.replaceChildren(host);
    },
    { rows: ROWS, width },
  );
  return page.locator("#chain-harness");
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("the chain divider renders as a labelled rule between two transcripts", async ({ page }) => {
    const host = await mountChain(page);
    const divider = host.locator(".msg.system.chain-divider");
    await expect(divider).toHaveCount(1);
    await expect(divider).toHaveText("Previous chat");

    // Both rules must actually draw - a flex child with no width is the
    // failure this asserts against, and it is invisible in a screenshot.
    const rules = divider.locator(".chain-rule");
    await expect(rules).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const box = (await rules.nth(i).boundingBox())!;
      expect(box.width).toBeGreaterThan(40);
      expect(box.height).toBeGreaterThan(0);
    }

    // Centered: the two rules take equal space either side of the label.
    const [left, right] = [(await rules.nth(0).boundingBox())!, (await rules.nth(1).boundingBox())!];
    expect(Math.abs(left.width - right.width)).toBeLessThan(2);

    await capture(host, "chain-divider");
  });

  test("hovering the divider shows no timestamp label", async ({ page }) => {
    await mountChain(page);
    await page.hover("#chain-harness .msg.system.chain-divider");
    const content = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("#chain-harness .msg.system.chain-divider")!;
      return getComputedStyle(el, "::after").content;
    });
    expect(content).toBe("none");
  });
});
