import { test, expect } from "@playwright/test";
// asserts: src/views/sessions/active-session-takeover.ts, src/shared/change-account-modal.ts
import { invokeCalls, mountSessionsList, sessionInstance } from "./harness";

// Todo 959: with ONE account registered, "Take Over" on a manual (external)
// session must skip the "Take over as which account?" picker. That picker
// renders a sole account as an inert chip, so as a gate it had nothing to
// click and Enter did nothing - the takeover could never happen.

const MANUAL = sessionInstance({ session_id: "ext-1", pid: 4242, name: "Terminal chat", kind: "external" });
const SOLE = { id: "acc-1", label: "personal", icon: "user", colour: "#8b5cf6" };

test("Take Over with a single account goes straight to takeover_manual, no account picker", async ({ page }) => {
  await mountSessionsList(page, [MANUAL], {
    list_accounts: [SOLE],
    takeover_manual: null,
    load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    list_slash_commands: [],
    get_git_dirty: null,
  });
  // The "Remote" segment, where kind:external lands, starts collapsed.
  await page.locator('li[data-seg-toggle="7"]').click();
  await page.locator(`#sessions-list li[data-session-id="ext-1"]`).click();

  await page.locator("#session-pane .takeover-btn").click();
  await page.locator(".app-confirm-ok").click();

  await expect
    .poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "takeover_manual").map((c) => c.args))
    .toEqual([{ manualPid: 4242, accountId: "acc-1" }]);
  await expect(page.locator(".cam-modal-card")).toHaveCount(0);
});
