// BILLED UI regression for ai_todo 65: reopening a chat must not duplicate or
// reorder messages. Reproduces Joe's exact flow - send a turn, switch to
// another chat, switch back - and asserts the message rows are unchanged.
//
// Spawns a real `claude` turn (tiny, subscription-billed). Run explicitly:
//   npm run test:e2e:chat

async function msgCounts() {
  return browser.execute(() => ({
    user: document.querySelectorAll(".msg.user").length,
    assistant: document.querySelectorAll(".msg.assistant").length,
  }));
}

async function startNewChatPickingFirstProject() {
  // New chat now lives in the view-header "more options" overflow menu.
  const moreBtn = await $("#viewMoreBtn");
  await moreBtn.waitForClickable({ timeout: 15000 });
  await moreBtn.click();
  const newBtn = await $("#newSessionBtn");
  await newBtn.waitForClickable({ timeout: 15000 });
  await newBtn.click();
  // 1. Project picker -> pick the first project.
  const row = await $(".project-picker-row");
  await row.waitForExist({ timeout: 10000 });
  await row.click();

  // openModelEffortModal awaits several IPC calls (get_settings, listProjects,
  // listAccounts) before its first render, so the field may not exist yet
  // right after the project-row click - wait for it before checking for a chip.
  await (await $(".me-acc-field")).waitForExist({ timeout: 10000 });
  // Ambiguous registry (2+ accounts, no default) leaves Start disabled until a chip is picked.
  const accChip = await $(".me-acc-field .account-chip");
  if (await accChip.isExisting()) {
    await accChip.click();
  }

  // .me-remote-input lives inside .me-more-body (ba44deea); open it, then match
  // the app default (on) unless E2E_REMOTE=0 asks for the remote-off A/B.
  const moreOptionsBtn = await $(".me-more-btn");
  await moreOptionsBtn.waitForClickable({ timeout: 10000 });
  await moreOptionsBtn.click();
  const wantRemote = process.env.E2E_REMOTE !== "0";
  const remoteInput = await $(".me-remote-input");
  await remoteInput.waitForExist({ timeout: 10000 });
  if ((await remoteInput.isSelected()) !== wantRemote) {
    await remoteInput.click();
  }

  const confirm = await $(".me-confirm");
  await confirm.waitForClickable({ timeout: 10000 });
  await confirm.click();
  // 3. Pending pane mounts the composer.
  await (await $(".session-composer .composer-textarea")).waitForExist({ timeout: 20000 });
}

describe("Chat reload de-duplication (ai_todo 65)", () => {
  it("a turn then switch-away-and-back does not duplicate messages", async () => {
    await browser.execute(() => window.showView("sessions"));

    // --- Chat A: send one turn ---
    await startNewChatPickingFirstProject();
    const ta = await $(".session-composer .composer-textarea");
    await ta.setValue("reply with the literal word OK and stop.");
    await (await $(".session-composer .composer-send")).click();

    // Wait for the assistant's finalized (non-streaming) reply.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll(".msg.assistant:not(.streaming)").length
        )) >= 1,
      { timeout: 120000, interval: 1000, timeoutMsg: "assistant reply never finalized" }
    );

    const before = await msgCounts();
    expect(before.user).toBe(1);
    expect(before.assistant).toBeGreaterThanOrEqual(1);

    const aId = await browser.execute(
      () => document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id")
    );
    expect(aId).toBeTruthy();

    // --- Switch away to a second chat, so A's pane unmounts ---
    await startNewChatPickingFirstProject();

    // --- Switch back to A (first loadInitial -> the merge that used to dup) ---
    // rebuildSidebar() can replace the row between the clickable check and the
    // click, so re-query every attempt instead of holding one element handle.
    await browser.waitUntil(
      async () => {
        try {
          const row = await $(`#sessions-list li[data-session-id="${aId}"]`);
          if (!(await row.isClickable())) return false;
          await row.click();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000, interval: 500, timeoutMsg: "chat A row never became clickable" }
    );
    await browser.waitUntil(
      async () => (await msgCounts()).assistant >= 1,
      { timeout: 20000, interval: 500, timeoutMsg: "chat A did not re-render on switch-back" }
    );

    const after = await msgCounts();
    // The whole point: counts must be identical, not doubled/reordered.
    expect(after.user).toBe(before.user);
    expect(after.assistant).toBe(before.assistant);
  });
});
