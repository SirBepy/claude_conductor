// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/sidebar.ts, src/views/sessions/hidden-sessions-sync.ts, src/views/sessions/sidebar-anim.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The idle rule (docs/architecture/chat-dashboard.md, "Idle chats hide themselves") runs in the
// daemon: it puts an idle chat into the shared hidden list and broadcasts `hidden_chats_changed`.
// The heads only have to draw that like a hand-hide: the head leaves with the exit motion, the
// eye head's count grows, a hidden chat draws no number, and a chat that comes back enters again.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 800 };
const CHAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: `C:/Projects/${name.toLowerCase()}`, awaiting: "done", ...over });

const SESSIONS = [
  chat("a", "Alpha", 101, { busy: true, awaiting: null }),
  chat("b", "Bravo", 102),
  chat("c", "Charlie", 103),
];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: { a: "a", b: "b", c: "c" },
  character_asset_url: CHAR_URL,
  get_project_icon: null,
  get_project_tech: null,
  get_hidden_chats: { sessions: [], projects: [] },
  update_hidden_chats: { sessions: [], projects: [] },
};

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const eye = (page: Page): Locator => page.locator("#sessions-list li[data-heads-hidden]");
const back = (page: Page): Locator => page.locator("#sessions-list li[data-heads-back]");

async function mount(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await head(page, "b").waitFor();
}

/** The daemon's `hidden_chats_changed` push, as the transport hands it to the page. */
async function daemonHides(page: Page, ids: string[]): Promise<void> {
  await fireEvent(page, "hidden-chats-changed", [{ sessions: ids, projects: [] }]);
}

/** Records every head that ever carried `row-exiting` or `row-entering`, so a motion that is over
 *  by the time the test looks still counts. */
async function watchMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __motion: Record<string, string[]> };
    w.__motion = {};
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        const id = el.dataset?.sessionId;
        if (!id) continue;
        for (const cls of ["row-exiting", "row-entering"]) {
          if (el.classList.contains(cls)) (w.__motion[id] ??= []).includes(cls) || w.__motion[id].push(cls);
        }
      }
    }).observe(document.querySelector("#sessions-list")!, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
  });
}

const motionOf = (page: Page, id: string): Promise<string[]> =>
  page.evaluate((sid) => (window as unknown as { __motion: Record<string, string[]> }).__motion[sid] ?? [], id);

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / idle chats hide themselves (${label})`, () => {
    test("an idle chat the daemon hides leaves the stack with the exit motion and the eye head counts it", async ({ page }) => {
      await mount(page, size);
      await expect(eye(page)).toHaveCount(0);
      await watchMotion(page);

      await daemonHides(page, ["b"]);

      await expect(head(page, "b")).toHaveCount(0);
      await expect(head(page, "c")).toBeVisible();
      await expect(eye(page).locator(".chat-head-count")).toHaveText("1");
      expect(await motionOf(page, "b"), "it leaves the way a hand-hide does, not by popping out").toContain("row-exiting");
      await capture(page, `chat-heads-auto-hide-left-${label}`);
    });

    test("the hidden view lists it with no number, and a new turn brings it back with the enter motion", async ({ page }) => {
      await mount(page, size);
      await daemonHides(page, ["b"]);
      await eye(page).click();
      await expect(head(page, "b")).toBeVisible();
      await expect(head(page, "b").locator(".chat-head-tag .ht-n")).toHaveCount(0);
      await capture(page, `chat-heads-auto-hide-hidden-view-${label}`);

      await back(page).click();
      await watchMotion(page);
      await daemonHides(page, []);

      await expect(head(page, "b")).toBeVisible();
      await expect(eye(page)).toHaveCount(0);
      expect(await motionOf(page, "b")).toContain("row-entering");
    });

    test("a chat the daemon hid that then asks a question keeps the red count on the toggle", async ({ page }) => {
      await mount(page, size);
      await daemonHides(page, ["b"]);
      const asking = SESSIONS.map((s) => (s.session_id === "b" ? { ...s, awaiting: "question" } : s));
      await page.evaluate((list) => {
        const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = (cmd, args) => (cmd === "list_instances" ? Promise.resolve(list) : orig(cmd, args));
      }, asking);
      await fireEvent(page, "instances-changed", [null]);
      // A closed stack shows the red count of every card waiting, hidden chats' included.
      await page.locator("#sessions-list li[data-heads-toggle]").click();
      await expect(page.locator("#sessions-list li[data-heads-toggle] .chat-head-count")).toHaveText("1");
      await expect(head(page, "b")).toHaveCount(0);
    });
  });
}
