import { test, expect, type Page } from "@playwright/test";
// asserts: src/views/sessions/project-rail.ts, src/views/sessions/hidden-sessions-sync.ts
import { fireEvent, invokeCalls, mountSessionsList, sessionInstance } from "./harness";

// The project-rail filter is one daemon-owned list (sessions/hidden_chats.rs),
// so hiding a project on the desktop hides it on the phone and back. These
// drive the rendered rail against a stateful fake of the daemon's two RPCs.

const ALPHA = "C:/Projects/alpha";
const BETA = "C:/Projects/beta";
const SESSIONS = [
  sessionInstance({ session_id: "s1", pid: 101, name: "Alpha chat", cwd: ALPHA }),
  sessionInstance({ session_id: "s2", pid: 102, name: "Beta chat", cwd: BETA }),
];

/** Wraps the harness's mock invoke as it is installed, so get/update_hidden_chats
 *  answer from one mutable store like the real daemon does. */
async function fakeDaemon(page: Page, projects: string[]): Promise<void> {
  await page.addInitScript((initial) => {
    localStorage.setItem("cc_hidden_synced", "1");
    localStorage.setItem("cc_hidden_projects_synced", "1");
    const store = { sessions: [] as string[], projects: [...initial] };
    let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => tauri,
      set: (v) => {
        const real = v.core.invoke;
        v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "get_hidden_chats") {
            (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
            return Promise.resolve({ ...store });
          }
          if (cmd === "update_hidden_chats") {
            (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
            const a = args as { addProjects: string[]; removeProjects: string[] };
            store.projects = store.projects.filter((p) => !a.removeProjects.includes(p));
            for (const p of a.addProjects) if (!store.projects.includes(p)) store.projects.push(p);
            return Promise.resolve({ ...store });
          }
          return real(cmd, args);
        };
        tauri = v;
      },
    });
  }, projects);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const avatar = (page: Page, cwd: string) => page.locator(`#project-rail .project-rail-avatar[data-cwd="${cwd}"]`);

test.describe("view-harness / project-rail filter synced through the daemon", () => {
  test("a project hidden on another device disappears here live", async ({ page }) => {
    await fakeDaemon(page, []);
    await mountSessionsList(page, SESSIONS);
    await expect(row(page, "s2")).toBeVisible();

    await fireEvent(page, "hidden-chats-changed", [{ sessions: [], projects: [BETA] }]);

    await expect(row(page, "s2")).toHaveCount(0);
    await expect(row(page, "s1")).toBeVisible();
    await expect(avatar(page, BETA)).toHaveClass(/\boff\b/);
  });

  test("clicking an avatar sends only that project's delta and keeps it hidden", async ({ page }) => {
    await fakeDaemon(page, []);
    await mountSessionsList(page, SESSIONS);

    await avatar(page, BETA).click();

    await expect(row(page, "s2")).toHaveCount(0);
    await expect
      .poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "update_hidden_chats").map((c) => c.args))
      .toEqual([{ add: [], remove: [], addProjects: [BETA], removeProjects: [] }]);
    // The refetch after the push must not flick the row back.
    await page.waitForTimeout(200);
    await expect(row(page, "s2")).toHaveCount(0);
  });

  test("a filtered project with no live chat here is kept, and All still reads as active", async ({ page }) => {
    await fakeDaemon(page, ["C:/Projects/only-on-the-phone"]);
    await mountSessionsList(page, SESSIONS);
    await expect(row(page, "s2")).toBeVisible();

    await expect(page.locator("#project-rail .project-rail-all")).toHaveClass(/\bactive\b/);
    const updates = (await invokeCalls(page)).filter((c) => c.cmd === "update_hidden_chats");
    expect(updates).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cc_hidden_projects") ?? "[]")))
      .toEqual(["C:/Projects/only-on-the-phone"]);
  });

  test("All showing everything clears only this device's projects, not one filtered elsewhere", async ({ page }) => {
    await fakeDaemon(page, ["C:/Projects/only-on-the-phone", BETA]);
    await mountSessionsList(page, SESSIONS);
    await expect(row(page, "s2")).toHaveCount(0);

    await page.locator("#project-rail .project-rail-all").click();

    await expect(row(page, "s2")).toBeVisible();
    await expect
      .poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "update_hidden_chats").map((c) => c.args))
      .toEqual([{ add: [], remove: [], addProjects: [], removeProjects: [BETA] }]);
  });
});
