import { expect, test, type Page } from "@playwright/test";
import { capture, mountView } from "./harness";
import type { UserTodo } from "../../src/types/ipc.generated";

// Todo 703, Your-Todos half. Shoots the CTA lifecycle off a stateful in-page
// invoke fake: this proves the PANEL reacts to seen_by_origin, not that the
// real UserPromptSubmit hook produced that flag.
const VIEWER = "sess-A";
const PANEL = { width: 640, height: 620 };

const CARD: UserTodo = {
  id: "dddddddd-4444-4444-8444-444444444444",
  text: "Install v0.2.75, then send a second message to this chat",
  origin_session_id: VIEWER,
  origin_label: "live-verify",
  state: "open",
  dropped: false,
  drop_reason: "",
  previous_text: "",
  by_ai: true,
  created_at: "2026-08-22T08:00:00Z",
  updated_at: "2026-08-22T08:00:00Z",
  // True at birth: `nothing unseen about a card the AI just wrote`
  // (src-tauri/src/sessions/user_todos.rs:284).
  seen_by_origin: true,
};

/** Inlined rather than shared from harness.ts (off limits to this dispatch);
 *  same stateful-fake technique as todos-panel.view.spec.ts. */
async function mountPanel(page: Page, seed: UserTodo[], columns: string[]) {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(
    async ({ seed, columns, viewer }) => {
      const w = window as unknown as Record<string, any>;
      const store = { todos: JSON.parse(JSON.stringify(seed)), columns: [...columns] };
      w.__todoStore = store;

      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        switch (cmd) {
          case "list_user_todos":
            return Promise.resolve({ todos: store.todos, columns: store.columns });
          case "set_user_todo_state": {
            const t = store.todos.find((x: any) => x.id === args.id);
            if (t) {
              // Mirrors sessions/user_todos.rs set_state for a Joe-side change.
              t.state = args.next;
              t.seen_by_origin = false;
              t.by_ai = false;
            }
            return Promise.resolve(null);
          }
          case "set_todo_columns":
            store.columns = [...args.columns];
            return Promise.resolve(null);
          case "mark_todos_seen":
            store.todos.forEach((t: any) => {
              if (t.origin_session_id === args.originSessionId) t.seen_by_origin = true;
            });
            return Promise.resolve(null);
          default:
            return passthrough(cmd, args);
        }
      };

      const host = document.createElement("div");
      host.id = "todos-spec-host";
      host.style.cssText =
        "position:fixed;inset:0;z-index:1;display:flex;background:var(--color-background)";
      document.body.appendChild(host);

      const mod = await import("/views/sessions/todos-panel.ts");
      w.__todosHandle = mod.mountTodosPanel(host);
      w.__todosHandle.setSessionScope(viewer);
    },
    { seed, columns, viewer: VIEWER },
  );

  const panel = page.locator("#todos-spec-host.todos-panel");
  await expect(panel.locator(".td-card").first()).toBeVisible();
  return panel;
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("your todos: open card, tick, self-clear", async ({ page }) => {
    await page.setViewportSize(PANEL);
    const panel = await mountPanel(page, [CARD], ["done"]);
    const cta = panel.locator(".td-cta");
    const card = panel.locator(".td-card");

    await expect(panel.locator(".td-col-here .td-card")).toHaveCount(1);
    await expect(card).toContainText("Install v0.2.75");
    await expect(card).not.toHaveClass(/is-unsent/);
    await expect(cta).toBeHidden();
    await capture(panel, "your-todos-card-open");

    await panel.locator(".td-col-here .td-card .td-box").click();

    await expect(panel.locator(".td-col-done .td-card")).toHaveCount(1);
    await expect(cta).toBeVisible();
    await expect(cta).toContainText("1 change");
    await expect(cta).toContainText("live-verify");
    await expect(panel.locator(".td-card.is-unsent")).toHaveCount(1);
    const ctaColor = await cta.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(ctaColor).toBe("rgb(240, 198, 116)");
    await capture(panel, "your-todos-card-ticked");

    // What the injection hook does daemon-side: flip the flag, no click.
    await page.evaluate(() => {
      (window as any).__todoStore.todos.forEach((t: any) => { t.seen_by_origin = true; });
      window.dispatchEvent(new Event("focus"));
    });

    await expect(cta).toBeHidden();
    await expect(panel.locator(".td-card.is-unsent")).toHaveCount(0);
    await expect(panel.locator(".td-col-done .td-card")).toHaveCount(1);
    await capture(panel, "your-todos-card-self-cleared");
  });
});
