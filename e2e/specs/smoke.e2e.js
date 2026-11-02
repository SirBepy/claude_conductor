// UI smoke: the app boots its SPA shell and the Sessions view renders with the
// daemon connected. Chat correctness itself is covered headlessly by the daemon
// integration tests (src-tauri/tests/daemon_chat_e2e.rs); this layer only proves
// the webview wiring renders.

describe("Claude Companion UI smoke", () => {
  it("boots the single desktop window's SPA shell (app rail)", async () => {
    // The Chats window is the only desktop window; its global group (Jarvis,
    // Dashboard, Schedule, Settings) is the shell's stable marker. It lives on
    // the standalone #app-rail or on the split's strip, one at a time, so look
    // for whichever is on screen.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const shown = [...document.querySelectorAll(".sp-strip")].find((el) => el.getClientRects().length > 0);
          return (
            !!shown &&
            ['[data-rail-go="dashboard"]', '[data-rail-go="schedule"]', '[data-rail-go="settings"]', "[data-rail-jarvis]"].every(
              (sel) => !!shown.querySelector(sel),
            )
          );
        }),
      { timeout: 30000, interval: 300, timeoutMsg: "no on-screen rail carries the global group" },
    );
  });

  it("opens the Dashboard in the Chats window's side panel", async () => {
    await browser.execute(() => window.showView("dashboard"));
    const dash = await $(".sp-global-pane .view-dashboard");
    await dash.waitForDisplayed({ timeout: 15000 });
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
