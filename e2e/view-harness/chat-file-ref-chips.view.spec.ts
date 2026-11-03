// Reviewed 2026-10-28: a chip outside the chat's repo now opens the app's Files window instead of VS Code (covered in code-mode.view.spec.ts and tests/file-refs.test.mjs); this spec asserts the chips' look, which is unchanged. Passed after the change.
// Reviewed 2026-10-26: a chip click now opens Code mode instead of the editor (covered in code-mode.view.spec.ts); this spec only asserts how chips render, which did not change.
// asserts: src/shared/chat/file-refs.ts, src/shared/chat/file-ref-match.ts, src/shared/chat/chat-messages-blocks.css
import { test, expect } from "@playwright/test";
import { invokeCalls, mountView } from "./harness";

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

// Joe's report: a chip for C:\Users\tecno\.claude\settings.json opened
// C:\Users\tecno.claude\settings.json in the Files window, "file not found".
test("clicking a chip for a dot-folder path written in prose opens that exact path", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [], open_file_window: null } });
  await page.evaluate(async () => {
    await import("/views/sessions/sessions.ts");
    const { linkifyFilePaths, handleFileRefClick } = await import("/shared/chat/file-refs.ts");
    const { renderMarkdown } = await import("/shared/chat/chat-transforms.ts");
    const host = document.createElement("div");
    host.id = "file-ref-harness";
    host.className = "chat-messages";
    const msg = document.createElement("div");
    msg.className = "msg assistant";
    msg.innerHTML = renderMarkdown("So the only route is the file. Open C:\\Users\\tecno\\.claude\\settings.json, find line 8.");
    host.appendChild(msg);
    document.body.replaceChildren(host);
    linkifyFilePaths(host);
    host.addEventListener("click", handleFileRefClick);
  });
  await page.locator("#file-ref-harness .file-ref", { hasText: "settings.json" }).click();
  const opens = async () => (await invokeCalls(page)).filter((c) => c.cmd === "open_file_window");
  await expect.poll(async () => (await opens()).length).toBe(1);
  expect((await opens())[0]!.args).toEqual({ path: "C:\\Users\\tecno\\.claude\\settings.json", line: null });
});
