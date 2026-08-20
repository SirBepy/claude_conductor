// Schedule view smoke (ai_todo-driven UI coverage). Free - no billed `claude`
// turn: item creation goes straight through the `schedule_create` IPC command
// (see src-tauri/src/ipc/schedule.rs), which only writes scheduled-items.json
// via the daemon's schedule_create RPC method (src-tauri/src/daemon/methods/
// schedule.rs) - nothing spawns until the scheduler tick loop's fire_at is
// reached, and this spec always schedules 1h in the future then deletes the
// item before that can happen.
//
// window.__TAURI__.core.invoke is the same direct-IPC mechanism already used
// by e2e/specs/multi-account.e2e.js and e2e/specs/changes-panel.e2e.js, so
// this spec follows that precedent rather than driving the composer/picker UI
// to create the item (the picker is composer-anchored and out of scope here).

const createdIds = [];

async function scheduleDelete(id) {
  try {
    await browser.execute((id) => window.__TAURI__.core.invoke("schedule_delete", { id }), id);
  } catch (e) {
    // best-effort cleanup; log but don't fail the afterEach on an already-gone id
    console.warn("[schedule-view.e2e] cleanup schedule_delete failed for", id, e.message);
  }
}

describe("Schedule view", () => {
  afterEach(async () => {
    // ALWAYS clean up items this spec created, even on assertion failure -
    // scheduled-items.json is shared app-data (SHARED-STATE CAVEAT in the
    // task brief), so only ever touch ids we created ourselves.
    while (createdIds.length) {
      const id = createdIds.pop();
      await scheduleDelete(id);
    }
  });

  it("renders the calendar grid, its status legend, and the day agenda", async () => {
    await browser.execute(() => window.showView("schedule"));

    const view = await $(".view-schedule");
    await view.waitForExist({ timeout: 15000 });

    const body = await $("#schedule-body");
    await body.waitForExist({ timeout: 15000 });

    // Grid and legend are unconditional chrome (schedule.ts:305-311), so they
    // anchor this test whatever the shared store happens to hold.
    await (await $(".cal-grid")).waitForExist({ timeout: 10000 });
    const legend = await $(".cal-legend");
    await legend.waitForExist({ timeout: 10000 });
    const legendText = await legend.getText();
    for (const status of ["Upcoming", "Sent", "Missed", "Failed", "Recurring"]) {
      expect(legendText).toContain(status);
    }

    // Either a row list or an empty state, never neither (schedule.ts:292-293).
    await (await $(".agenda-head .agenda-title")).waitForExist({ timeout: 10000 });
    const hasRows = await (await $(".agenda-list")).isExisting();
    const hasEmpty = await (await $(".agenda-empty")).isExisting();
    expect(hasRows || hasEmpty).toBe(true);
    if (hasEmpty && !hasRows) {
      expect(await (await $(".agenda-empty")).getText()).toContain("Nothing scheduled");
    }
  });

  it("creates a scheduled item via IPC, shows it in today's agenda, then deletes it via the row action", async () => {
    await browser.execute(() => window.showView("schedule"));
    await $(".view-schedule").waitForExist({ timeout: 15000 });

    const fireAtIso = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h: far enough out nothing fires during the run

    const item = await browser.execute(
      (fireAtIso) =>
        window.__TAURI__.core.invoke("schedule_create", {
          kind: { type: "new_chat", cwd: "C:\\Users\\tecno\\Desktop\\Projects\\claude_usage_in_taskbar", model: "", effort: "", account_id: null },
          prompt: "wdio smoke item",
          // Tauri v2 camelCases `fire_at: String` (ipc/schedule.rs:34).
          fireAt: fireAtIso,
          recurrence: null,
        }),
      fireAtIso
    );

    expect(item && item.id).toBeTruthy();
    createdIds.push(item.id);

    // Reload the view so it picks up the new item (the view also listens for
    // the daemon's scheduled-items-changed event, but re-navigating is the
    // same mechanism the other specs use and avoids a race on that listener).
    await browser.execute(() => window.showView("schedule"));

    // The redesign (todo 322) moved rows to `li.agenda-row[data-id]`
    // (schedule.ts:231). +1h puts it on today, the day selected on mount.
    const row = await $(`li.agenda-row[data-id="${item.id}"]`);
    await row.waitForExist({ timeout: 15000 });
    await expect(row).toExist();

    const title = await row.$(".agenda-name");
    expect(await title.getText()).toContain("claude_usage_in_taskbar");

    const timeLabel = await row.$(".agenda-time");
    await expect(timeLabel).toExist();
    expect(await timeLabel.getText()).not.toBe("");

    // Only upcoming rows get Reschedule (schedule.ts:244), so this pins status.
    await expect(row.$('button[data-action="reschedule-toggle"]')).toExist();

    // No stray askConfirm dialog should be up yet.
    expect(await $(".app-confirm-overlay").isExisting()).toBe(false);

    // Delete via the row's Delete action - askConfirm is an in-app DOM overlay
    // (never window.confirm - see src/shared/confirm.ts), so drive it for real.
    const deleteBtn = await row.$('button[data-action="delete"]');
    await deleteBtn.waitForClickable({ timeout: 10000 });
    await deleteBtn.click();

    const confirmOverlay = await $(".app-confirm-overlay");
    await confirmOverlay.waitForExist({ timeout: 5000 });
    const confirmBtn = await $(".app-confirm-ok");
    await confirmBtn.waitForClickable({ timeout: 5000 });
    await confirmBtn.click();

    await row.waitForExist({ timeout: 15000, reverse: true });
    expect(await $(`li.agenda-row[data-id="${item.id}"]`).isExisting()).toBe(false);

    // No stray dialog left behind after the confirm flow either.
    expect(await $(".app-confirm-overlay").isExisting()).toBe(false);

    // This item is gone via the UI action already; drop it from the cleanup
    // queue so afterEach doesn't try (and warn on) a redundant schedule_delete.
    createdIds.pop();
  });
});
