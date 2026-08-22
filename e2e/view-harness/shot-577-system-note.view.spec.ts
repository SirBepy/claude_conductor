import { test, expect, type Page } from "@playwright/test";
import { mountView, capture } from "./harness";
import type { RenderedMessage } from "../../src/shared/chat/chat-transforms";

// Todo 577: shots of the long-system-note collapse (commit d50103e2), plus the
// short-note non-regression, through the real chat-messages CSS cascade.

const LONG_NOTE = [
  "[repo-coordination-channel] relayed 4 messages while this session was auto-continued:",
  "session-b (claude_usage_in_taskbar): claiming todo 612, touching src-tauri/src/daemon/pump.rs and stt.rs - do not run cargo, shared target-dir lock is held until roughly 14:20.",
  "session-c (worktree wt-android): bootstrap done, running the aarch64 apk build; will post again when adb install finishes.",
  "session-d: asked whether the usage chip should stay remote-only; answered yes, no desktop quota UI.",
  "session-e: reminder that master already carries the AUQ pagination fix, rebase before pushing.",
].join("\n");

const ROWS = [
  { kind: "system", text: LONG_NOTE, ts: 0 },
  { kind: "system", text: "Continuing session...", ts: 0 },
] satisfies RenderedMessage[];

async function mountNotes(page: Page) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (rows) => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const host = document.createElement("div");
    host.id = "note-harness";
    host.className = "chat-messages";
    host.style.cssText = "padding:16px;max-width:720px";
    host.innerHTML = rows.map((m) => renderMessage(m)).join("");
    document.body.replaceChildren(host);
  }, ROWS);
  return page.locator("#note-harness");
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("a long system note collapses to one summary line and expands intact", async ({ page }) => {
    const host = await mountNotes(page);

    const long = host.locator("details.msg.system.system-long");
    await expect(long).toHaveCount(1);
    await expect(long).not.toHaveAttribute("open", /.*/);
    const summary = long.locator("summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("repo-coordination-channel");
    await expect(long.locator(".system-note-full")).not.toBeVisible();

    const closedBox = (await long.boundingBox())!;
    expect(closedBox.height).toBeLessThan(60);
    await capture(long, "system-note-collapsed");

    await page.click("#note-harness details.msg.system.system-long > summary");
    await expect(long).toHaveAttribute("open", /.*/);
    const full = long.locator(".system-note-full");
    await expect(full).toBeVisible();
    await expect(full).toContainText("adb install");
    await expect(full).toContainText("rebase before pushing");
    expect((await long.boundingBox())!.height).toBeGreaterThan(closedBox.height);
    await capture(long, "system-note-expanded");

    const short = host.locator(".msg.system").filter({ hasText: "Continuing session" });
    await expect(short).toHaveCount(1);
    await expect(short).toBeVisible();
    await expect(short).toHaveJSProperty("tagName", "DIV");
    await expect(short).toHaveCSS("font-style", "italic");
    await capture(short, "system-note-short-unchanged");
  });
});
