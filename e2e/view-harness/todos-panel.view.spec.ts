import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Todo 692, "Your Todos" panel. Drives the REAL panel UI, not internal state.
// The harness's invoke map is fixed at mount, so these specs swap in a stateful
// in-page fake afterwards - a tick has to change what the next list call
// returns, or the red-to-green half is theatre.

const VIEWER = "sess-A";

/** Two cards written by the chat being viewed, one by a sibling chat. Scope is
 *  derived from origin_session_id, so the third belongs in Project wide. */
const SEED = [
  {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    text: "Grab a Cloudflare API token with `Workers:Edit`",
    origin_session_id: VIEWER,
    origin_label: "push-notifs",
    state: "open",
    dropped: false,
    drop_reason: "",
    previous_text: "",
    by_ai: true,
    created_at: "2026-08-19T08:00:00Z",
    updated_at: "2026-08-19T08:00:00Z",
    seen_by_origin: true,
  },
  {
    id: "bbbbbbbb-2222-4222-8222-222222222222",
    text: "Create the Cloudflare KV namespace by hand",
    origin_session_id: VIEWER,
    origin_label: "push-notifs",
    state: "open",
    dropped: false,
    drop_reason: "",
    previous_text: "",
    by_ai: true,
    created_at: "2026-08-19T08:05:00Z",
    updated_at: "2026-08-19T08:05:00Z",
    seen_by_origin: true,
  },
  {
    id: "cccccccc-3333-4333-8333-333333333333",
    text: "Approve the Play Store review",
    origin_session_id: "sess-B",
    origin_label: "release",
    state: "open",
    dropped: false,
    drop_reason: "",
    previous_text: "",
    by_ai: true,
    created_at: "2026-08-19T08:10:00Z",
    updated_at: "2026-08-19T08:10:00Z",
    seen_by_origin: true,
  },
];

async function mountPanel(page: Page, seed: unknown[], columns: string[] = []) {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(
    async ({ seed, columns, viewer }) => {
      const w = window as unknown as Record<string, any>;
      const store = { todos: JSON.parse(JSON.stringify(seed)), columns: [...columns] };
      w.__todoStore = store;

      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        const find = (id: string) => store.todos.find((t: any) => t.id === id);
        switch (cmd) {
          case "list_user_todos":
            return Promise.resolve({ todos: store.todos, columns: store.columns });
          case "set_user_todo_state": {
            const t = find(args.id);
            if (t) {
              t.state = args.next;
              // Mirrors the daemon: a Joe-side change is unseen by its author.
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
          case "clear_archived_todos":
            store.todos = store.todos.filter((t: any) => t.state !== "archived");
            return Promise.resolve(null);
          default:
            return passthrough(cmd, args);
        }
      };

      const host = document.createElement("div");
      host.id = "todos-spec-host";
      host.style.cssText = "position:fixed;inset:0;z-index:1;display:flex;background:var(--color-background)";
      document.body.appendChild(host);

      const mod = await import("/views/sessions/todos-panel.ts");
      w.__todosHandle = mod.mountTodosPanel(host);
      w.__todosHandle.setSessionScope(viewer);
    },
    { seed, columns, viewer: VIEWER },
  );

  // mountTodosPanel puts the class ON the host, so this is one element.
  const panel = page.locator("#todos-spec-host.todos-panel");
  await expect(panel.locator(".td-card").first()).toBeVisible();
  return panel;
}

test("default view is one This chat list, and a sibling chat's card is not in it", async ({ page }) => {
  const panel = await mountPanel(page, SEED);

  // Exactly one column on the board at rest - the whole point of the design.
  await expect(panel.locator(".td-col")).toHaveCount(1);
  await expect(panel.locator(".td-col-here .td-col-head")).toContainText("This chat");
  await expect(panel.locator(".td-col-here .td-card")).toHaveCount(2);
  await expect(panel.locator(".td-col-here")).not.toContainText("Approve the Play Store review");

  // Backticks in a card's text render as a real code span.
  await expect(panel.locator(".td-card .td-text code").first()).toHaveText("Workers:Edit");
});

test("the Columns menu puts Project wide on the board and derives the sibling card into it", async ({ page }) => {
  const panel = await mountPanel(page, SEED);

  await page.evaluate(() => {
    const anchor = document.createElement("button");
    anchor.id = "cols-anchor";
    anchor.style.cssText = "position:fixed;top:8px;right:8px;width:28px;height:28px;z-index:2";
    document.body.appendChild(anchor);
    (window as any).__todosHandle.toggleColumnsMenu(anchor);
  });

  const menu = page.locator(".td-columns-menu");
  await expect(menu).toBeVisible();
  // This chat is listed with a locked eye: being in the list is how the
  // derived-scope model teaches itself.
  await expect(menu.locator(".td-menu-row.is-locked")).toContainText("This chat");

  await menu.locator('[data-col="project"]').click();

  await expect(panel.locator(".td-col")).toHaveCount(2);
  await expect(panel.locator(".td-col-project .td-card")).toHaveCount(1);
  await expect(panel.locator(".td-col-project")).toContainText("Approve the Play Store review");
  // Menu stays open so several columns can be switched on in one visit.
  await expect(menu).toBeVisible();

  // ...and the choice was persisted for THIS chat.
  const columns = await page.evaluate(() => (window as any).__todoStore.columns);
  expect(columns).toEqual(["project"]);
});

test("every column is the same width, and a third one scrolls instead of squeezing", async ({ page }) => {
  // Regression: This chat used to collapse to ~150px next to the optional
  // columns, wrapping card text one word per line.
  const panel = await mountPanel(page, SEED, ["project", "done"]);
  await expect(panel.locator(".td-col")).toHaveCount(3);

  const widths = await panel.locator(".td-col").evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().width)),
  );
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]).toBeGreaterThanOrEqual(260);

  // Narrow the rail past what three columns fit in: they keep their width and
  // the board gains a scroll range rather than shrinking.
  await page.evaluate(() => {
    document.getElementById("todos-spec-host")!.style.width = "560px";
  });
  const after = await panel.locator(".td-col").evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().width)),
  );
  expect(new Set(after).size).toBe(1);
  expect(after[0]).toBeGreaterThanOrEqual(260);
  const scrollable = await panel.locator(".td-board").evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(scrollable).toBe(true);
});

test("ticking raises the notify CTA, and Notify clears it", async ({ page }) => {
  // Done is on the board so the ticked card stays visible; by default a tick
  // simply leaves the This chat list.
  const panel = await mountPanel(page, SEED, ["done"]);
  const cta = panel.locator(".td-cta");
  await expect(cta).toBeHidden();

  await panel.locator(".td-col-here .td-card").first().locator(".td-box").click();

  await expect(cta).toBeVisible();
  await expect(cta).toContainText("1 change");
  await expect(cta).toContainText("push-notifs");
  // The ticked card is marked unsent until a turn reads it.
  await expect(panel.locator(".td-card.is-unsent")).toHaveCount(1);

  await cta.locator('[data-act="notify"]').click();
  await expect(cta).toBeHidden();
  await expect(panel.locator(".td-card.is-unsent")).toHaveCount(0);
});

test("a turn reading the cards clears the CTA on its own, with nothing clicked", async ({ page }) => {
  // The hard requirement: if the AI sees the change, the bar disappears by
  // itself. The hook flips seen_by_origin daemon-side; simulated here.
  const panel = await mountPanel(page, SEED);
  const cta = panel.locator(".td-cta");

  await panel.locator(".td-col-here .td-card").first().locator(".td-box").click();
  await expect(cta).toBeVisible();

  await page.evaluate(() => {
    (window as any).__todoStore.todos.forEach((t: any) => { t.seen_by_origin = true; });
    window.dispatchEvent(new Event("focus"));
  });

  await expect(cta).toBeHidden();
});

test("Later hides the bar for that change but a NEW change raises it again", async ({ page }) => {
  const panel = await mountPanel(page, SEED, ["done"]);
  const cta = panel.locator(".td-cta");

  await panel.locator(".td-col-here .td-card").first().locator(".td-box").click();
  await expect(cta).toBeVisible();
  await cta.locator('[data-act="later"]').click();
  await expect(cta).toBeHidden();

  // A second tick is a different unseen set, so the bar must come back rather
  // than staying silenced forever.
  await panel.locator(".td-col-here .td-card").first().locator(".td-box").click();
  await expect(cta).toBeVisible();
  await expect(cta).toContainText("2 changes");
});
