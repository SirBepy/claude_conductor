// asserts: src/shared/chat/file-refs.ts, src/shared/chat/chat-messages-blocks.css
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Paths in an assistant message render as quiet chips through the real chat CSS.

const SHOTS = ".for_bepy/screenshots/37904-134373906274173600";

test("absolute paths in an assistant message render as file chips", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { linkifyFilePaths } = await import("/shared/chat/file-refs.ts");
    const host = document.createElement("div");
    host.id = "file-ref-harness";
    host.className = "chat-messages";
    host.style.cssText = "padding:16px;max-width:720px";
    host.innerHTML =
      `<div class="msg assistant"><p>Changed <code>C:\\Users\\tecno\\proj\\src\\app.ts:42</code> and ` +
      `/home/joe/project/src/lib.rs, plus C:/Users/tecno/proj/README.md.</p></div>`;
    document.body.replaceChildren(host);
    linkifyFilePaths(host);
  });
  const chips = page.locator("#file-ref-harness .file-ref");
  await expect(chips).toHaveCount(3);
  await expect(chips.first()).toHaveAttribute("title", "C:\\Users\\tecno\\proj\\src\\app.ts:42");
  await page.locator("#file-ref-harness").screenshot({ path: `${SHOTS}/file-ref-chips.png` });
});
