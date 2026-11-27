// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/sessions-dom-wiring.ts, src/shared/mobile/voice-entry.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, expectSeparated, mountSessionsList, sessionInstance } from "./harness";

// Voice notes R6 entry A (docs/architecture/voice-notes.md): a mic head under the + head that opens the
// Android app's bundled recorder. It exists only where the native `ConductorVoice` bridge has
// `openRecorder`, so this spec fakes the bridge before the page boots, as the phone's WebView would.

const PHONE = { width: 390, height: 780 };
const chats = [
  sessionInstance({ session_id: "s-1", name: "First chat", pid: 101, cwd: "C:/Projects/rodge" }),
  sessionInstance({ session_id: "s-2", name: "Second chat", pid: 102, cwd: "C:/Projects/rodge" }),
];

async function fakeBridge(page: Page, opts: { withOpen?: boolean } = {}): Promise<void> {
  await page.addInitScript((withOpen) => {
    const w = window as unknown as Record<string, unknown>;
    w.__voice = { status: "idle", opened: [] as string[], locked: false };
    const v = w.__voice as { status: string; opened: string[]; locked: boolean };
    const bridge: Record<string, unknown> = {
      state: () => JSON.stringify({ bridgeVersion: 2, supported: true, status: v.status }),
    };
    if (withOpen) {
      bridge.openRecorder = (view: string) => {
        if (v.locked) return JSON.stringify({ ok: false, result: "locked" });
        v.opened.push(view);
        return JSON.stringify({ ok: true, result: "opened" });
      };
    }
    w.ConductorVoice = bridge;
  }, opts.withOpen ?? true);
}

test("the mic head sits under the + head and opens the recorder in one tap", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await fakeBridge(page);
  await mountSessionsList(page, chats, { is_daemon_connected: true });

  const plus = page.locator("#sessions-list li#sessionsFab");
  const mic = page.locator("#sessions-list li.chat-head-voice");
  await expect(mic).toBeVisible();
  await expect(mic).toHaveAttribute("aria-label", "Record a voice note");
  // Under +, never on top of it, a chat head or the corner the fab dial owns.
  await expectSeparated(plus, mic);
  const plusBox = (await plus.boundingBox())!;
  const micBox = (await mic.boundingBox())!;
  expect(micBox.y).toBeGreaterThan(plusBox.y + plusBox.height - 1);
  expect(micBox.x).toBeLessThan(PHONE.width / 2);
  await capture(page.locator(".chat-heads"), "voice-mic-head-idle");

  await mic.click();
  expect(await page.evaluate(() => (window as unknown as { __voice: { opened: string[] } }).__voice.opened)).toEqual(["recorder"]);
  // Opening the recorder leaves the stack as it was: no new chat started.
  await expect(page.locator("#sessions-list li.chat-head-voice")).toHaveCount(1);
});

test("a live recording lights the head, including one started from the tile", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await fakeBridge(page);
  await mountSessionsList(page, chats, { is_daemon_connected: true });
  const mic = page.locator("#sessions-list li.chat-head-voice");
  await expect(mic).not.toHaveClass(/is-recording/);

  // The native side flips the state and calls the page hook, as RecorderState's listener does.
  await page.evaluate(() => {
    const w = window as unknown as { __voice: { status: string }; __ccVoiceChanged: () => void };
    w.__voice.status = "recording";
    w.__ccVoiceChanged();
  });
  await expect(mic).toHaveClass(/is-recording/);
  await expect(mic).toHaveAttribute("aria-label", /recording/);
  await capture(page.locator(".chat-heads"), "voice-mic-head-recording");

  await page.evaluate(() => {
    const w = window as unknown as { __voice: { status: string }; __ccVoiceChanged: () => void };
    w.__voice.status = "idle";
    w.__ccVoiceChanged();
  });
  await expect(mic).not.toHaveClass(/is-recording/);
});

test("with no chats the + head and the mic head are the whole stack", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await fakeBridge(page);
  await mountSessionsList(page, [], { is_daemon_connected: true });
  await expect(page.locator("#sessions-list li")).toHaveCount(2);
  await expect(page.locator("#sessions-list li.chat-head-voice")).toBeVisible();
  await expectSeparated(page.locator("#sessions-list li#sessionsFab"), page.locator("#sessions-list li.chat-head-voice"));
  await capture(page.locator(".chat-heads"), "voice-mic-head-empty");
});

test("no mic head without the app's bridge or on an older bridge", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountSessionsList(page, chats, { is_daemon_connected: true });
  await expect(page.locator("#sessions-list li.chat-head-voice")).toHaveCount(0);

  const older = await page.context().newPage();
  await older.setViewportSize(PHONE);
  await fakeBridge(older, { withOpen: false });
  await mountSessionsList(older, chats, { is_daemon_connected: true });
  await expect(older.locator("#sessions-list li.chat-head-voice")).toHaveCount(0);
});
