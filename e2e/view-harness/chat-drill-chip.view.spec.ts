// asserts: src/shared/chat/drill-links.ts, src/shared/chat/chat-messages-blocks.css
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// A send_message bubble's `#d:id` link renders as a quiet chip through the real
// chat CSS; click opens the detail popover, and a later bubble without its own
// `details` resolves the same id to the earlier body.

const SHOTS = ".for_bepy/screenshots/37904-134373906274173600";

test("drill chip opens a popover with the detail body", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const { linkifyDrillRefs, handleDrillClick } = await import("/shared/chat/drill-links.ts");
    const msg = (text: string, details?: unknown) => ({ kind: "message", text, id: "t", ts: 1, parentToolUseId: null, details });
    const host = document.createElement("div");
    host.id = "drill-harness";
    host.className = "chat-messages";
    host.style.cssText = "padding:16px;max-width:720px;min-height:360px";
    host.innerHTML =
      renderMessage(msg("Done. There were [23 ignored tickets](#d:ign), and 4 need your call.", [
        { id: "ign", label: "23 ignored tickets", body_md: "- #23 Flaky login\n- #41 **Slow** settings page\n- #55 Typo in footer" },
      ]) as never) +
      renderMessage(msg("Reminder: the [23 ignored tickets](#d:ign) are unchanged.") as never);
    document.body.replaceChildren(host);
    host.addEventListener("click", handleDrillClick);
    linkifyDrillRefs(host, host);
  });
  const chips = page.locator("#drill-harness .drill-chip");
  await expect(chips).toHaveCount(2);
  await chips.nth(1).click();
  await expect(page.locator(".drill-pop")).toContainText("Flaky login");
  await page.screenshot({ path: `${SHOTS}/drill-chip-popover.png` });
});
