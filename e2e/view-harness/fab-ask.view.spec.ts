import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// The chat-pane FAB and the Ask panel it opens. Drives the real UI, not
// internal state: the ask_* commands are backed by an in-page stateful fake so
// asking a question actually changes what the next list call returns.

const VIEWER = "sess-A";

const SEEDED_THREAD = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "whats backpressure again",
  created_at: 1756000000000,
  updated_at: 1756000000000,
  sidecar_session_id: "side-1",
  messages: [
    { role: "user", text: "whats backpressure again", ts: 1756000000000 },
    { role: "assistant", text: "Slowing the producer when the consumer can't keep up.", ts: 1756000001000 },
  ],
};

/** Mounts the real FAB into a full-bleed fake pane, with ask_* faked in-page. */
async function mountFab(page: Page, seed: unknown[]): Promise<void> {
  await mountView(page);
  await page.evaluate(
    async ({ seed, viewer }) => {
      const w = window as unknown as Record<string, any>;
      const store = { threads: JSON.parse(JSON.stringify(seed)) as any[] };
      w.__askStore = store;
      w.__drafts = [] as string[];

      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        switch (cmd) {
          case "ask_list_threads":
            return Promise.resolve(store.threads);
          case "ask_send": {
            let t = store.threads.find((x) => x.id === args.threadId);
            if (!t) {
              t = {
                id: `new-${store.threads.length + 1}`,
                title: args.question.slice(0, 60),
                created_at: 1,
                updated_at: 1,
                sidecar_session_id: "side-new",
                messages: [],
              };
              store.threads.unshift(t);
            }
            t.messages.push({ role: "user", text: args.question, ts: 2 });
            t.messages.push({
              role: "assistant",
              text: "You were splitting pump.rs.\nSUGGESTED: split the tests out of pump/mod.rs",
              ts: 3,
            });
            return Promise.resolve(t);
          }
          case "ask_delete_thread":
            store.threads = store.threads.filter((x) => x.id !== args.threadId);
            return Promise.resolve(store.threads);
          default:
            return passthrough(cmd, args);
        }
      };

      const pane = document.createElement("div");
      pane.id = "fab-spec-pane";
      pane.style.cssText =
        "position:fixed;inset:0;z-index:1;background:var(--color-background)";
      document.body.appendChild(pane);

      const mod = await import("/views/sessions/fab-dial.ts");
      w.__fabHandle = mod.mountFabDial(pane, {
        onDraft: (text: string) => w.__drafts.push(text),
        preview: null,
      });
      w.__fabHandle.setSessionScope(viewer, "/proj");
    },
    { seed, viewer: VIEWER },
  );
}

test("FAB rests closed, fans out to four, and opens Ask in a floating card", async ({ page }) => {
  await mountFab(page, [SEEDED_THREAD]);

  const fab = page.locator(".fab-dial-fab");
  await expect(fab).toBeVisible();
  // The three DIAL card panels plus the Preview toggle, which is a dial item
  // but never a panel.
  await expect(page.locator(".fab-dial-item")).toHaveCount(4);
  // Dial exists in the DOM but is hidden until the FAB is tapped.
  await expect(page.locator(".fab-dial-item").first()).toBeHidden();
  await expect(page.locator(".fab-card")).toHaveCount(0);

  await fab.click();
  await expect(page.locator(".fab-dial-item").first()).toBeVisible();

  await page.locator('[data-dial="ask"]').click();
  await expect(page.locator(".fab-card")).toBeVisible();
  await expect(page.locator(".ask-panel")).toBeVisible();
  // The card floats: the FAB hides so it can't cover the card's input row.
  await expect(fab).toBeHidden();
});

test("Preview is a toggle in the dial, not a card panel", async ({ page }) => {
  await mountFab(page, []);
  await page.locator(".fab-dial-fab").click();

  const preview = page.locator('[data-dial="preview"]');
  await expect(preview).toHaveClass(/is-toggle/);
  // Never lands in the card, and the spine only ever offers the three that do.
  await expect(page.locator('[data-spine="preview"]')).toHaveCount(0);
});

test("the spine switches panels without closing the card", async ({ page }) => {
  await mountFab(page, [SEEDED_THREAD]);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="ask"]').click();
  await expect(page.locator(".ask-panel")).toBeVisible();

  await page.locator('[data-spine="todos"]').click();
  await expect(page.locator(".fab-card")).toBeVisible();
  await expect(page.locator(".ask-panel")).toHaveCount(0);

  await page.locator('[data-spine="ask"]').click();
  await expect(page.locator(".fab-card")).toBeVisible();
  await expect(page.locator(".ask-panel")).toBeVisible();
});

test("asking a question renders the answer and drafts the suggestion into the composer", async ({ page }) => {
  await mountFab(page, [SEEDED_THREAD]);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="ask"]').click();

  await page.locator("[data-ask-input]").fill("what was i meant to do here");
  await page.locator("[data-ask-send]").click();

  await expect(page.locator(".ask-a").last()).toContainText("You were splitting pump.rs");
  // The SUGGESTED line is split off the answer, never shown as prose.
  await expect(page.locator(".ask-a").last()).not.toContainText("SUGGESTED:");

  const handoff = page.locator(".ask-handoff");
  await expect(handoff).toBeVisible();
  await expect(handoff).toContainText("split the tests out of pump/mod.rs");

  await handoff.locator("button").click();
  const drafts = await page.evaluate(() => (window as any).__drafts);
  expect(drafts).toEqual(["split the tests out of pump/mod.rs"]);
});

test("the index lists threads, deletes one, and starts a new one", async ({ page }) => {
  await mountFab(page, [SEEDED_THREAD]);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="ask"]').click();

  await page.locator("[data-ask-index-toggle]").click();
  await expect(page.locator(".ask-menu-row")).toHaveCount(1);
  // Delete is dimmed at rest, not hidden - it has to be discoverable.
  const del = page.locator(".ask-del").first();
  await expect(del).toBeVisible();
  expect(Number(await del.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0);

  // The index stays open through a delete, so New thread is one click away
  // rather than needing the menu reopened.
  await del.click();
  await expect(page.locator(".ask-menu-row")).toHaveCount(0);
  await expect(page.locator("[data-ask-new]")).toBeVisible();
});

test("Escape closes the card, but not while typing in it", async ({ page }) => {
  await mountFab(page, [SEEDED_THREAD]);
  await page.locator(".fab-dial-fab").click();
  await page.locator('[data-dial="ask"]').click();

  await page.locator("[data-ask-input]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fab-card")).toBeVisible();

  await page.locator(".ask-body").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fab-card")).toHaveCount(0);
  await expect(page.locator(".fab-dial-fab")).toBeVisible();
});
