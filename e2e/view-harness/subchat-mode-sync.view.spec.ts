// asserts: src/views/sessions/permission-modal/index.ts, src/views/sessions/permission-modal/gating.ts, src/shared/global-stream.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// First real run: after a respawn, the successor had "Use subchats" in chat-config and
// list_subchats_on named it, yet the sidebar kept it under Input Needed with a model
// battery until a reload, because each window reads the set of mode-on chats once at
// boot. A flip made on the phone or in a second window had the same gap. The daemon
// now nudges every client ("subchats-on-changed") and the window re-reads the set.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/Projects/cv-site";
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });

/** Mounts with a stand-in daemon whose set of mode-on chats can change after boot. */
async function mount(page: Page, size: { width: number; height: number }, sessions: unknown[], on: string[]): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_subchats_on: on,
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    },
  });
  await page.evaluate(({ rows, set }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
      __rows: unknown[];
      __on: string[];
    };
    w.__rows = rows;
    w.__on = set;
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "list_instances" || cmd === "get_active_sessions") return Promise.resolve(w.__rows);
      if (cmd === "list_subchats_on") return Promise.resolve(w.__on);
      return orig(cmd, args);
    };
  }, { rows: sessions, set: on });
  await page.locator("#sessions-list li").first().waitFor();
  await page.waitForTimeout(250);
}

async function daemonNow(page: Page, rows: unknown[], on: string[]): Promise<void> {
  await page.evaluate(({ r, s }) => {
    const w = window as unknown as { __rows: unknown[]; __on: string[] };
    w.__rows = r;
    w.__on = s;
  }, { r: rows, s: on });
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
/** The text of the group header above a row. */
const groupOf = (page: Page, id: string) =>
  page.evaluate((sid) => {
    let cur = document.querySelector(`#sessions-list li[data-session-id="${sid}"]`)?.previousElementSibling ?? null;
    while (cur && !cur.classList.contains("session-group-header")) cur = cur.previousElementSibling;
    return cur?.textContent?.trim() ?? null;
  }, id);

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / the set of mode-on chats follows the daemon (${label})`, () => {
    test("a respawn successor that inherited the mode joins Main chats without a reload", async ({ page }) => {
      const pred = chat("pred", "CV redesign", 101);
      await mount(page, size, [pred], ["pred"]);
      await expect.poll(() => groupOf(page, "pred")).toBe("Main chats");

      // The successor appears, asking, with the mode already in the daemon's chat-config.
      const next = chat("next", "CV redesign", 102, { busy: false, awaiting: "question", successor_of: "pred" });
      await daemonNow(page, [next], ["next"]);
      await fireEvent(page, "instances-changed", [null]);
      await expect(row(page, "next")).toHaveCount(1);
      // Nothing told the window the mode set changed: it files the row as an ordinary asking chat.
      expect(await groupOf(page, "next")).not.toBe("Main chats");

      // The daemon's nudge makes the window re-read the set.
      await fireEvent(page, "subchats-on-changed", [{}]);
      await expect.poll(() => groupOf(page, "next")).toBe("Main chats");
    });

    test("a flip made on another surface reaches this window, on and off", async ({ page }) => {
      const a = chat("chat-a", "Chat A", 101);
      const b = chat("chat-b", "Chat B", 102);
      await mount(page, size, [a, b], []);
      expect(await groupOf(page, "chat-a")).not.toBe("Main chats");

      await daemonNow(page, [a, b], ["chat-a"]);
      await fireEvent(page, "subchats-on-changed", [{}]);
      await expect.poll(() => groupOf(page, "chat-a")).toBe("Main chats");
      expect(await groupOf(page, "chat-b")).not.toBe("Main chats");

      await daemonNow(page, [a, b], []);
      await fireEvent(page, "subchats-on-changed", [{}]);
      await expect.poll(() => groupOf(page, "chat-a")).not.toBe("Main chats");
    });
  });
}
