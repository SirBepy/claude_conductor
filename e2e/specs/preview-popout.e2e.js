// Preview pop-out close/dock-back regression. Free - no `claude` turn: the
// window is driven straight through the `open_preview_window` /
// `close_preview_window` IPC commands (src-tauri/src/ipc/window/preview.rs).
//
// The bug: the one `session-preview` window is reused across chats, but its
// close handler announced `preview-window-docked` for the chat it was first
// BUILT for. The chat actually on screen kept `cc_preview_panel_popped` set, so
// the next preview a session pushed there called `open_preview_window` and
// un-hid the window Joe had closed - the white full-screen "Preview" window.

const SESSION_A = "e2e-preview-popout-a";
const SESSION_B = "e2e-preview-popout-b";

async function previewVisible() {
  return browser.execute(async () => {
    const all = await window.__TAURI__.window.getAllWindows();
    const w = all.find((x) => x.label === "session-preview");
    return w ? await w.isVisible() : null;
  });
}

describe("Preview pop-out", () => {
  before(async () => {
    await browser.waitUntil(
      async () => browser.execute(() => !!window.__TAURI__?.core?.invoke).catch(() => false),
      { timeout: 30000, interval: 300, timeoutMsg: "__TAURI__.core.invoke never appeared" }
    );
    await browser.execute(() => {
      window.__ccDocked = [];
      return window.__TAURI__.event.listen("preview-window-docked", (e) => {
        window.__ccDocked.push(e.payload);
      });
    });
  });

  it("docks back to the chat it is showing, not the one it was built for", async () => {
    await browser.execute(
      (sid) => window.__TAURI__.core.invoke("open_preview_window", { sessionId: sid }),
      SESSION_A
    );
    // Built hidden, shown on its ready heartbeat (ipc/ready.rs).
    await browser.waitUntil(async () => (await previewVisible()) === true, {
      timeout: 30000,
      interval: 300,
      timeoutMsg: "preview pop-out never became visible",
    });

    // Reuse: the same window now shows chat B.
    await browser.execute(
      (sid) => window.__TAURI__.core.invoke("open_preview_window", { sessionId: sid }),
      SESSION_B
    );

    await browser.execute(() => window.__TAURI__.core.invoke("close_preview_window"));
    await browser.waitUntil(async () => (await previewVisible()) === false, {
      timeout: 10000,
      interval: 200,
      timeoutMsg: "preview pop-out still visible after close",
    });
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__ccDocked.length)) > 0,
      { timeout: 10000, interval: 200, timeoutMsg: "preview-window-docked never fired" }
    );

    const docked = await browser.execute(() => window.__ccDocked);
    expect(docked[docked.length - 1].sessionId).toBe(SESSION_B);
  });

  it("stays hidden once closed", async () => {
    // Nothing un-hides a closed pop-out on its own: give any stray show a
    // window to land in before checking.
    await browser.pause(3000);
    expect(await previewVisible()).toBe(false);
  });
});
