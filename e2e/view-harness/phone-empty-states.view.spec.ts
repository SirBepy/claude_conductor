// Reviewed 2026-11-16 (chat heads, pc-1769): the empty list is the + head; the old "No active sessions" row and its hint pointing at the FAB are gone with the sidebar.
// Reviewed 2026-11-14 (pc-1740, the sidebar project filter rail and the phone Filter by project submenu are removed): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-14 (pc-1744, the palette's per-project New chat in rows and their startNewSessionInProject/startNewChatInProject helpers are removed): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-13 (suggestion rows hide while the box holds text or an attachment: composer-typing.ts, draft chip row `data-typing`): nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (project main chat): the sidebar lists one Main chats row per project; this spec has no project pointer, so the empty states and groups it asserts are unchanged, and it passes.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-11 (phone keyboard): pending-flow.ts changed comments only; it passes.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-08: pending-flow.ts gained startNewSessionInProject (the palette's New chat in <project>); the empty-state copy this spec asserts is unchanged and it passed.
// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// Reviewed 2026-11-05: sidebar-entries.ts now builds a chat's sub summary from "has subs" instead of the mode alone; no row here has subs, so the empty states are unchanged and this spec passes.
// Reviewed 2026-11-05 (hidden subs): sidebar-entries.ts now drops a row with subchat_of from the list; this spec asserts the empty-state copy of a list with no rows at all, so its contract is unaffected and it passed after the change.
// Reviewed 2026-11-01: pending-pane-mount.ts now builds the working bar through the shared thinkingBarHtml(); this spec asserts empty-state copy only and passes.
// Reviewed 2026-10-29: a draft's header now opens on the project name with "New chat" under it, and draft-dashboard.ts places the project's settings rail (desktop only; the phone gets none); this spec asserts empty-state copy only, so its contract is unaffected. Passed after the change.
// Reviewed 2026-10-25 (in-place statusline editing): pending-pane-mount.ts now passes layoutEditable: true to the statusbar; this spec asserts empty-state copy only, so its contract is unaffected.
// Reviewed 2026-10-23 (peer account picker): pending-flow.ts now passes the picker's machine id on to the model/effort modal; this spec asserts empty-state copy only and starts no chat on a peer, so its contract is unaffected.
// Reviewed 2026-10-22: pending-pane-mount.ts no longer wires a header Code button (it moved to the FAB menu); this spec asserts empty-state copy only, so its contract is unaffected.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/pending-pane-mount.ts, src/views/sessions/project-dashboard/draft-dashboard.ts
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
import { conductorHistory, conductorSnapshot } from "./project-dashboard-fixtures";

// Todo 1078: the phone's two empty states ("No active sessions" in the
// sidebar list, and the new-chat draft's "Type a message below..." hint)
// should read as deliberate, reusing the app's own .v-empty idiom (icon +
// title line), not a one-off italic row or a void pane.

const PHONE = { width: 390, height: 780 };

test("the empty chats list on phone is the + head alone, never a wall of nothing", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountSessionsList(page, [], { is_daemon_connected: true });

  // With no chats the stack is the one `+` head (the empty state: nothing to open, one way forward).
  const plus = page.locator("#sessions-list li#sessionsFab");
  await expect(plus).toBeVisible();
  await expect(plus).toHaveAttribute("aria-label", /^New chat/);
  await expect(page.locator("#sessions-list li")).toHaveCount(1);
  await expect(page.locator("li.sessions-empty-row")).toHaveCount(0);

  await capture(page.locator(".chat-heads"), "phone-empty-states-heads");
});

async function mountNewChatDraft(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [],
      dashboard_list_targets: [], dashboard_snapshot: conductorSnapshot(), dashboard_history: conductorHistory(),
    },
  });
  // Phone shows one pane at a time (sessions-mobile.css); the chat pane
  // starts hidden until `data-mobile-pane="chat"` is set, same as the real
  // app's launch-new-session flow does via the FAB before mounting.
  // Re-applied until the pane shows: the view's own initial load can still be
  // settling and put the phone back on the list right after a one-shot set.
  await page.waitForFunction(() => {
    document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
    const pane = document.querySelector<HTMLElement>("#session-pane");
    return !!pane && pane.offsetParent !== null;
  });

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

test("the new-chat draft shows its project's dashboard on phone, one column, chips above the message box", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountNewChatDraft(page);

  // ChatRenderer.attach() clears .session-messages, so only a real browser
  // driving the real renderer proves the dashboard survives to paint.
  const root = page.locator(".session-messages .pd-root.is-draft");
  await expect(root.locator(".pd-reports")).toBeVisible();
  await expect(root.locator('[data-pd-card="chats"]')).toBeVisible();
  // The 900px rule stacks the half-width cards into the first column.
  await expect(root.locator(".pd-col").nth(1).locator("[data-pd-card]")).toHaveCount(0);
  await expect(page.locator(".pd-qa-host.is-draft .pd-chip").first()).toBeVisible();
  // The phone has no PC to open a project's config on, so the draft has no menu button either.
  await expect(root.locator("[data-pd-kebab]")).toHaveCount(0);

  await capture(page.locator(".session-pane"), "phone-empty-states-pending-pane");
});
