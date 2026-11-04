import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance, fireEvent, capture } from "./harness";

// A chat's title types in when Claude names it: the sidebar row backspaces
// "New chat" and types the new name instead of hard-cutting to it.
//
// asserts: src/views/sessions/sidebar-anim.ts, src/shared/title-typewriter.ts

test("a sidebar row retypes its title when the chat gets named", async ({ page }) => {
  await mountSessionsList(page, [sessionInstance({ session_id: "s1", name: null })]);
  const title = page.locator("#sessions-list li[data-session-id='s1'] .session-row-title-text");
  await expect(title).toHaveText("New chat");

  const NAME = "Fix the login redirect loop on expired sessions";
  await page.evaluate((next) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) =>
      cmd === "list_instances" ? Promise.resolve(next) : orig(cmd, args);
  }, [sessionInstance({ session_id: "s1", name: NAME })]);
  await fireEvent(page, "instances-changed", [null]);

  // Somewhere between the old and the new title it shows a half-typed name:
  // neither "New chat" nor the full text.
  let sawPartial = false;
  await expect.poll(async () => {
    const t = ((await title.textContent()) ?? "").trim();
    if (t.length > 0 && t !== "New chat" && t !== NAME && NAME.startsWith(t)) {
      if (!sawPartial) await capture(page.locator("#sessions-list"), "title-typewriter-midway");
      sawPartial = true;
    }
    return sawPartial;
  }, { timeout: 5000, intervals: [20] }).toBe(true);

  await expect(title).toHaveText(NAME);
});
