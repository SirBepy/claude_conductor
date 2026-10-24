// Reviewed 2026-10-25 (in-place statusline editing): pending-pane-mount.ts now passes layoutEditable: true to the statusbar; this spec asserts empty-state copy only, so its contract is unaffected.
// Reviewed 2026-10-23 (peer account picker): pending-flow.ts now passes the picker's machine id on to the model/effort modal; this spec asserts empty-state copy only and starts no chat on a peer, so its contract is unaffected.
// Reviewed 2026-10-22: pending-pane-mount.ts no longer wires a header Code button (it moved to the FAB menu); this spec asserts empty-state copy only, so its contract is unaffected.
// asserts: src/views/sessions/sidebar-entries.ts, src/views/sessions/pending-pane-mount.ts
//
// Reviewed against pending-pane-mount.ts's new skeleton placeholders
// (statusbar + .session-messages, seeded to kill the blank-flash gap before
// the real statusbar/renderer mount): both tests here `await` the whole
// mount chain before asserting, same as before, so they only ever observe
// the final state - the skeletons are long gone by then. Ran this file
// after that change - still passes.
//
// Reviewed again against the mobile Chats overhaul's sidebar-entries.ts
// gating (project rail / Hidden row skip inline rendering on the phone
// transport) - this file's empty-state block runs before and independent of
// that gate. Ran this file after that change - still passes.
import { test, expect, type Page } from "@playwright/test";
import { mountView, mountSessionsList, SESSIONS_BASE_INVOKE, capture } from "./harness";

// Todo 1078: the phone's two empty states ("No active sessions" in the
// sidebar list, and the new-chat draft's "Type a message below..." hint)
// should read as deliberate, reusing the app's own .v-empty idiom (icon +
// title line), not a one-off italic row or a void pane.

const PHONE = { width: 390, height: 780 };

test("the empty chats list centers a v-empty card on phone, pointing at +", async ({ page }) => {
  await page.setViewportSize(PHONE);
  // is_daemon_connected:true is required for sidebar-entries.ts to paint the
  // empty-state row at all - unmocked, sessions-initial-load.ts's catch
  // leaves state.daemonConnected null and the sidebar stays blank by design.
  await mountSessionsList(page, [], { is_daemon_connected: true });

  const row = page.locator("li.sessions-empty-row");
  await expect(row).toBeVisible();
  const empty = row.locator(".v-empty");
  await expect(empty).toBeVisible();
  await expect(empty.locator(".v-empty-icon")).toBeVisible();
  await expect(empty.locator(".v-empty-title")).toHaveText("No active sessions");
  // "No active sessions" must survive unchanged - tests/sidebar-setup-stalled
  // .test.mjs's textContent assertion depends on it staying exactly this string.
  await expect(row).toContainText("No active sessions");
  // Points at the + affordance (the phone FAB / desktop's kebab "New chat").
  await expect(empty.locator(".v-empty-hint")).toContainText("+");

  await capture(page.locator(".sessions-sidebar"), "phone-empty-states-sidebar");
});

async function mountNewChatDraft(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [] },
  });
  // Phone shows one pane at a time (sessions-mobile.css); the chat pane
  // starts hidden until `data-mobile-pane="chat"` is set, same as the real
  // app's launch-new-session flow does via the FAB before mounting.
  await page.evaluate(() => {
    document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
  });
  await page.locator("#session-pane").waitFor();

  await page.evaluate(async () => {
    const flow = await import("/views/sessions/pending-flow.ts");
    const pane = document.querySelector<HTMLElement>("#session-pane")!;
    await flow.launchNewSession(
      pane,
      { path: "C:/Projects/alpha", name: "Alpha" },
      { model: "claude-opus-5", effort: "high", accountId: null, characterId: null, autoAccept: true },
    );
  });
}

test("the new-chat draft's pending hint is visible on phone and uses the v-empty card", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountNewChatDraft(page);

  const hint = page.locator(".session-pending-hint");
  // ChatRenderer.attach() clears .session-messages, so only a real browser
  // driving the real renderer proves the hint survives to paint.
  await expect(hint).toBeVisible();
  const box = await hint.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // The hint card IS a .v-empty (not a wrapper around one) - same idiom as
  // the sidebar's empty row, applied directly to the existing hint element.
  await expect(hint).toHaveClass(/\bv-empty\b/);
  await expect(hint.locator(".v-empty-icon")).toBeVisible();
  await expect(hint.locator(".v-empty-hint")).toContainText("Alpha");

  await capture(page.locator(".session-pane"), "phone-empty-states-pending-pane");
});
