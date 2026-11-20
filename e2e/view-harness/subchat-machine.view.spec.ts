// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// Reviewed 2026-11-17 (chat heads replace the sidemenu, pc-1769): what this spec asserts holds with the heads in place of the chat list (at most it clicks a chat to open it), and it passes in the full view-harness run after the change.
// asserts: src/views/sessions/sub-list.ts, src/views/sessions/sub-machine.ts, src/views/sessions/main-chat.ts, src/views/sessions/sub-list.css
import { test, expect, type Page } from "@playwright/test";
import { assistantMsg, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// Cross-machine subchats, step 7: a sub that runs on a paired machine is a mirrored
// row the home recorded as its own (`subchat_of` kept, `machine` set). The main chat's
// header list shows which machine it runs on, and says so when that machine is offline.
// Drives the real sessions view with a Windows-hosted main chat and two subs.

const CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: true, awaiting: null, ...over });

const MAIN = chat("main", "CV redesign", 101);
const LOCAL = sub("sub-local", "Footer", 102);
const mac = (online: boolean) => ({ id: "mac-1", label: "Mac mini", online });

function invokeFor(sessions: unknown[]) {
  const events = [userMsg("hello"), assistantMsg("hi")];
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    list_pending_prompts: [],
    get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_slash_commands: [],
    list_auto_accept: [],
    list_subchat_cards: [],
  };
}

async function open(page: Page, sessions: unknown[]): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { view: "sessions", invoke: invokeFor(sessions) });
  await page.locator("#sessions-list li").first().waitFor();
  await page.locator('#sessions-list li[data-session-id="main"]').click();
  await page.locator("#session-pane .session-header .sub-count-btn").click();
  await page.locator(".sub-list-popover").waitFor();
}

test("a sub on a paired machine shows the machine on its row, and a local sub shows none", async ({ page }) => {
  await open(page, [MAIN, LOCAL, sub("sub-visit", "Port", 103, { machine: mac(true) })]);
  const visiting = page.locator('.sub-list-popover .sub-row[data-sub-id="sub-visit"]');
  await expect(visiting.locator(".sub-machine")).toHaveText("Mac mini");
  await expect(visiting.locator(".sub-machine")).toHaveAttribute("title", "on Mac mini");
  await expect(visiting.locator(".sub-status")).toHaveText("working");
  await expect(page.locator('.sub-list-popover .sub-row[data-sub-id="sub-local"] .sub-machine')).toHaveCount(0);
  await page.locator(".sub-list-popover").screenshot({ path: test.info().outputPath("visiting-sub-list.png") });
});

test("an offline machine says so on the row instead of a guessed state", async ({ page }) => {
  await open(page, [MAIN, sub("sub-visit", "Port", 103, { machine: mac(false) }), sub("sub-done", "Header", 104, { machine: mac(false), subchat_finished: true, awaiting: "done", progress: { plan: null, state_since: new Date().toISOString() } })]);
  const away = page.locator('.sub-list-popover .sub-row[data-sub-id="sub-visit"]');
  await expect(away.locator(".sub-status")).toHaveText("Mac mini offline");
  await expect(away.locator(".sub-machine")).toHaveClass(/sub-machine--offline/);
  await expect(away.locator(".sub-machine")).toHaveAttribute("title", "on Mac mini (offline)");
  // A finished sub's result does not change when its machine goes away.
  await expect(page.locator('.sub-list-popover .sub-row[data-sub-id="sub-done"] .sub-status')).toHaveText("finished");
});
