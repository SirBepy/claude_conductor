// UI smoke: the app boots its SPA shell and the Sessions view renders with the
// daemon connected. Chat correctness itself is covered headlessly by the daemon
// integration tests (src-tauri/tests/daemon_chat_e2e.rs); this layer only proves
// the webview wiring renders.

describe("Claude Companion UI smoke", () => {
  it("boots the single desktop window's SPA shell (app rail)", async () => {
    // The Chats window is the only desktop window; its global rail (Jarvis,
    // Dashboard, Schedule, Settings) is the shell's stable marker. Go to the
    // Dashboard first: the standalone #app-rail is hidden while a chat's split
    // strip carries the same group, and the Dashboard never has a strip.
    await browser.execute(() => window.showView("dashboard"));
    const rail = await $("#app-rail");
    await rail.waitForDisplayed({ timeout: 30000 });
    await expect(rail.$('[data-rail-go="dashboard"]')).toExist();
    await expect(rail.$('[data-rail-go="schedule"]')).toExist();
    await expect(rail.$('[data-rail-go="settings"]')).toExist();
    await expect(rail.$("[data-rail-jarvis]")).toExist();
  });

  it("renders the Sessions view sidebar (daemon connected)", async () => {
    // window.showView is exposed globally by src/shared/navigation.ts.
    await browser.execute(() => window.showView("sessions"));

    const view = await $(".view-sessions");
    await view.waitForExist({ timeout: 15000 });

    // The sidebar list container (template.ts: <ul id="sessions-list">) is the
    // stable marker that the Sessions view mounted.
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 15000 });
    await expect(list).toExist();
  });
});
