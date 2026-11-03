// asserts: src/views/sessions/backlog-panel/backlog-panel.ts, src/views/sessions/backlog-panel/todo-ref-click.ts, src/views/sessions/backlog-panel/backlog-open-event.ts, src/shared/chat/markdown-highlight.ts
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// A todo id in a rendered chat message opens that todo in the real Backlog
// panel (the real FAB host and split); only the backend is mocked. The
// sessions view's two bridges (document click -> handleTodoRefClick, and
// cc-backlog-open -> fab.openPanel) are wired here the way sessions.ts wires
// them, since the full sessions view is not mounted.

const ENTRY = (over: Record<string, unknown>) => ({
  name: "x.md", path: "C:\\proj\\.claude\\todos\\x.md", id: "pc-0000", title: "", summary: null, origin: "ai", todo_type: "task",
  worth: null, complexity: null, claimed: false, group: null, plan_index: null, mtime_ms: 0, ...over,
});
const TODOS = [
  ENTRY({ id: "pc-1264", title: "Hyperfocus the mobile todos", origin: "dev", group: "Joe's own priorities", plan_index: 0 }),
  ENTRY({ id: "pc-1407", title: "Find why re-shown windows paint white", origin: "dev", group: "Joe's own priorities", plan_index: 1 }),
];
const DOC = (id: string) => ({
  entry: TODOS.find((t) => t.id === id)!,
  why: null,
  sections: [{ heading: "Goal", markdown: `Goal text of ${id}.` }],
});

async function mountChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1334, height: 800 });
  await mountView(page, { invoke: { list_slash_commands: [], list_previews: [], list_message_drafts: { drafts: [] } } });
  await page.evaluate(
    async ({ backlog, docs }) => {
      localStorage.clear();
      localStorage.setItem("cc.split.fraction", "0.5");
      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        if (cmd === "list_ai_backlog") return Promise.resolve(backlog);
        if (cmd === "read_ai_todo") return Promise.resolve(docs[args.id]);
        return passthrough(cmd, args);
      };
      const pane = document.createElement("main");
      pane.className = "session-pane";
      pane.style.cssText = "position:fixed;inset:0;z-index:1;box-sizing:border-box";
      pane.innerHTML = `<div id="chat-col" style="flex:1;padding:16px"></div>`;
      document.body.appendChild(pane);
      const { renderMarkdown } = await import("/shared/chat/chat-transforms.ts");
      const msg = document.createElement("div");
      msg.className = "msg assistant";
      msg.innerHTML = renderMarkdown("Picking up pc-1407 next. `pc-9999` is not a real todo, and utf-8 is not an id.");
      pane.querySelector("#chat-col")!.appendChild(msg);
      const pv = await import("/views/sessions/preview-panel.ts");
      const mod = await import("/views/sessions/fab-dial.ts");
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, onCode: () => {}, mountPreview: pv.mountPreviewTab });
      fab.setSessionScope("sess-A", "C:\\proj");
      const ev = await import("/views/sessions/backlog-panel/backlog-open-event.ts");
      const click = await import("/views/sessions/backlog-panel/todo-ref-click.ts");
      window.addEventListener(ev.BACKLOG_OPEN_EVENT, () => fab.openPanel("backlog"));
      document.addEventListener("click", click.handleTodoRefClick);
    },
    { backlog: { groups: ["Joe's own priorities"], todos: TODOS }, docs: Object.fromEntries(TODOS.map((t) => [t.id, DOC(t.id)])) },
  );
  await expect(page.locator('.sp-tab[data-sp-k="backlog"] .sp-count')).toHaveText(String(TODOS.length));
}

test("clicking a todo id in a message opens that todo in the Backlog reader", async ({ page }) => {
  await mountChat(page);
  // Only the canonical id forms are targets; the rest of the sentence stays plain.
  await expect(page.locator(".msg .todo-ref")).toHaveCount(2);
  await expect(page.locator(".msg .todo-ref").first()).toHaveText("pc-1407");

  await page.locator('.msg .todo-ref[data-todo-id="pc-1407"]').click();
  await expect(page.locator(".bl-panel")).toBeVisible();
  await expect(page.locator(".bl-doc-title")).toHaveText("Find why re-shown windows paint white");
  await expect(page.locator('.bl-row[data-bl-id="pc-1407"]')).toHaveClass(/is-on/);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "todo-ref-click-opens-reader.png") });
});

test("an id with no todo opens the panel and says so quietly instead of failing", async ({ page }) => {
  await mountChat(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.locator('.msg .todo-ref[data-todo-id="pc-9999"]').click();
  await expect(page.locator(".bl-panel")).toBeVisible();
  await expect(page.locator(".bl-error")).toContainText("pc-9999 is not in this project's backlog");
  expect(errors).toEqual([]);
});
