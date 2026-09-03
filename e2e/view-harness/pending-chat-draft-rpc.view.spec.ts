import { test, expect, type Page } from "@playwright/test";
import { mountView, invokeCalls, SESSIONS_BASE_INVOKE } from "./harness";

// Reproduces todo 842 group 1: a pending chat's composer/held draft sync must
// not call the daemon's draft RPCs against a placeholder id (the daemon has
// no session for it yet and rejects with -32602 unknown session_id).

const REAL_SESSION_ID = "real-session-1";

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [],
  get_active_sessions: [],
  start_session: REAL_SESSION_ID,
  set_auto_accept: null,
  set_composer_draft: { updated_at: "2026-09-03T00:00:00.000Z" },
  clear_composer_draft: { updated_at: "2026-09-03T00:00:00.000Z" },
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
};

/** Creates a draft via the test seam, same as draft-discard-cancels-schedule's
 *  createDraft, and returns its real (randomly generated) placeholderId. */
async function createDraft(page: Page): Promise<string> {
  await mountView(page, { view: "sessions", invoke: BASE_INVOKE });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "high" });
  });
  await page.locator(".session-composer .composer-textarea").waitFor();
  const id = await page.locator("#sessions-list li[data-placeholder-id]").getAttribute("data-placeholder-id");
  if (!id) throw new Error("draft row never rendered a placeholder id");
  return id;
}

/** Simulates the daemon's real -32602 rejection for the 3 draft RPCs when
 *  called with a still-pending session id, so the test proves the FIX skips
 *  the call rather than just happening to pass a lenient mock. Real ids fall
 *  through to the harness's own mocked responses. */
async function installUnknownSessionIdGuard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __ccInvokeCalls: Array<{ cmd: string; args?: unknown }>;
    };
    const orig = w.__TAURI__.core.invoke;
    const draftCmds = new Set(["set_composer_draft", "clear_composer_draft", "get_session_drafts"]);
    w.__TAURI__.core.invoke = (cmd, args) => {
      const sid = (args as { sessionId?: unknown } | undefined)?.sessionId;
      if (draftCmds.has(cmd) && typeof sid === "string" && sid.startsWith("pending-")) {
        w.__ccInvokeCalls.push({ cmd, args });
        return Promise.reject(new Error("rpc error: code=-32602 message=unknown session_id"));
      }
      return orig(cmd, args);
    };
  });
}

test.describe("view-harness / pending chat draft RPCs", () => {
  test("skip while pending, resume once the session is promoted", async ({ page }) => {
    const consoleWarnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") consoleWarnings.push(msg.text());
    });

    const placeholderId = await createDraft(page);
    await installUnknownSessionIdGuard(page);

    const textarea = page.locator(".session-composer .composer-textarea");
    await textarea.fill("draft while pending");
    await page.waitForTimeout(700); // past the 500ms composer-sync debounce

    let calls = await invokeCalls(page);
    expect(calls.filter((c) => c.cmd === "set_composer_draft")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "get_session_drafts")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "clear_composer_draft")).toHaveLength(0);
    expect(consoleWarnings.some((w) => w.includes("unknown session_id"))).toBe(false);

    // Promote: sending the first message starts the real session and rebinds
    // the composer onto it (Composer.setSessionId's isRename branch).
    await textarea.fill("first message");
    await page.locator(".session-composer .composer-send").click();
    await page.waitForFunction(() => {
      const w = window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> };
      return w.__ccInvokeCalls.some((c) => c.cmd === "start_session");
    });
    await page.waitForTimeout(150); // let the resolved promise chain settle

    await page.locator(".session-composer .composer-textarea").fill("draft after promotion");
    await page.waitForTimeout(700);

    calls = await invokeCalls(page);
    const draftPushes = calls.filter((c) => c.cmd === "set_composer_draft");
    expect(draftPushes.length).toBeGreaterThan(0);
    for (const c of draftPushes) {
      expect((c.args as { sessionId: string }).sessionId).toBe(REAL_SESSION_ID);
    }
    // Sanity: the placeholder id itself never got a draft RPC at any point.
    expect(calls.some((c) => (c.args as { sessionId?: string } | undefined)?.sessionId === placeholderId
      && (c.cmd === "set_composer_draft" || c.cmd === "get_session_drafts" || c.cmd === "clear_composer_draft"))).toBe(false);
  });
});
