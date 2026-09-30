import { test, expect } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The sidebar paints its rows from the first list_instances, and the sessions
// view then registers several event listeners (one IPC round trip each). The
// row click handler used to be wired only after all of them, so a click on an
// already-painted row during a slow boot was silently dropped: a reload in the
// billed chat-flow run clicked chat A and it never opened (todo 926). This
// stalls one of those registrations forever, which widens that window to
// "always", and requires the click to open the chat anyway.

const SESSIONS = [sessionInstance()];

test("a session row painted during a stalled boot still opens on click", async ({ page }) => {
  // Runs before mountView's own init script installs the fake __TAURI__, so
  // trap that assignment and wrap its listen as it lands.
  await page.addInitScript(() => {
    type Tauri = { event: { listen: (e: string, cb: unknown) => Promise<unknown> } };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => undefined,
      set(tauri: Tauri) {
        const listen = tauri.event.listen;
        tauri.event.listen = (event, cb) =>
          event === "daemon-status-changed" ? new Promise(() => {}) : listen(event, cb);
        Object.defineProperty(window, "__TAURI__", { value: tauri, writable: true, configurable: true });
      },
    });
  });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      load_history_page: {
        events: [{ type: "user_message", content: [{ type: "text", text: "hello" }], timestamp: 0 }],
        oldest_seq: 0,
        newest_seq: 0,
        has_more: false,
      },
    },
  });

  const row = page.locator('#sessions-list li[data-session-id="s1"]');
  await row.waitFor();
  await row.click();

  await expect(row).toHaveClass(/\bactive\b/);
  await expect(page.locator("#session-pane .session-messages .msg.user")).toHaveCount(1);
});
