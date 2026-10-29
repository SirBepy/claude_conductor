// asserts: src/views/sessions/backlog-panel/backlog-panel.ts, src/views/sessions/backlog-panel/backlog-drag.ts, src/views/sessions/backlog-panel/backlog-render.ts, src/views/sessions/backlog-panel/backlog-panel.css, src/views/sessions/split-panels/split.ts
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { expectIconButtonsCentred } from "./icon-centering";
import { shotDir } from "./shot-dir";

const SCREENSHOT_DIR = shotDir();

// The Backlog panel in the real desktop split: reader next to the chat on the
// left, a 230px list on the right, collapsing to list -> reader below ~560px
// of PANEL width. Real pointer input on the real strip, rows and drag handles;
// only the backend (list_ai_backlog / read_ai_todo / the writes) is mocked.

const VIEWER = "sess-A";
const ENTRY = (over: Record<string, unknown>) => ({
  name: "x.md", path: "C:\\proj\\.claude\\todos\\x.md", id: "pc-0000", title: "", summary: null, origin: "ai", todo_type: "task",
  worth: null, complexity: null, claimed: false, group: null, plan_index: null, mtime_ms: 0, ...over,
});

const TODOS = [
  ENTRY({ id: "pc-1264", title: "Hyperfocus the mobile / Android todos with Joe's phone on USB", origin: "dev", worth: 2, complexity: "EASY", group: "Joe's own priorities", plan_index: 0, summary: "Next session works only the phone-path todos, starting with the ones that need the real device." }),
  ENTRY({ id: "pc-0926", title: "Answering a question queues the answer and wedges the chat", origin: "dev", worth: 7, complexity: "HARD", claimed: true, group: "Joe's own priorities", plan_index: 1, summary: "Answering a question card sends the answer, and the chat can still send afterwards." }),
  ENTRY({ id: "pc-1441", title: "Inline show_preview cards often fail to load", origin: "dev", worth: 8, complexity: "MEDIUM", group: "v0.2.140", plan_index: 2, summary: "Inline preview cards render, or fail loudly so the session falls back." }),
  ENTRY({ id: "pc-1407", title: "Find why re-shown windows paint white and ignore input", origin: "dev", worth: 7, complexity: "HARD", group: "v0.2.140", plan_index: 3, summary: "A hidden window that comes back paints and takes input, every time." }),
  ENTRY({ id: "pc-1211", title: "Other phone apps can ride the tunnel's fixed 127.0.0.1:27184 port", origin: "dev", worth: 6, complexity: "HARD", mtime_ms: 5, summary: "Only Conductor's own WebView can use the phone-to-PC tunnel." }),
  ENTRY({ id: "pc-1440", title: "Any WebView script can stretch the phone app lock's relock window", origin: "ai", mtime_ms: 4, summary: "Every setter that weakens the app lock needs the same auth as turning it off." }),
  ENTRY({ id: "pc-1449", title: "Preview frame copies the cursor-hidden class", origin: "ai", worth: 3, complexity: "EASY", mtime_ms: 3, summary: "Typing in the app never hides the cursor inside a preview frame." }),
];
const BACKLOG = { groups: ["Joe's own priorities", "v0.2.140", "Parked"], todos: TODOS };

const SECTIONS = [
  { heading: "Goal", markdown: "A hidden window that comes back paints and takes input, every time." },
  { heading: "Context", markdown: "- Screenshots 2026-10-27 15:24, CPU at 100%.\n- Tray \"Open\" recovers it (`show` + `unminimize` + `set_focus`).\n- UNVERIFIED: controller `IsVisible` never set on a show path that sends no `WM_SHOWWINDOW`." },
  { heading: "Approach", markdown: "Reproduce in `scripts/live-verify.ps1`, re-show the hidden pop-out through each path." },
  { heading: "Acceptance", markdown: "- A repro is recorded, or every hypothesis is ruled out with evidence." },
  { heading: "Verify", markdown: "Run the repro twice." },
];
const DOC = (id: string) => {
  const entry = TODOS.find((t) => t.id === id)!;
  return {
    entry,
    why: id === "pc-1407" ? "Joe still sometimes sees the Preview pop-out and the dashboard return fully white and frozen." : null,
    sections: SECTIONS,
  };
};

/** The real FAB host (and so the real split) on a chat column, with the backlog mocked.
 *  `fraction` is the divider's remembered position: 0.5 gives ~640px of panel at 1334. */
async function mountPane(page: Page, width: number, fraction: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mountView(page, { invoke: { list_slash_commands: [], list_previews: [], list_message_drafts: { drafts: [] }, ai_todo_plan_move: null, ai_todo_plan_reorder_groups: null } });
  await page.evaluate(
    async ({ backlog, docs, viewer, fraction }) => {
      localStorage.clear();
      localStorage.setItem("cc.split.fraction", String(fraction));
      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        if (cmd === "list_ai_backlog") return Promise.resolve(backlog);
        if (cmd === "read_ai_todo") return Promise.resolve(docs[args.id]);
        if (cmd === "ai_todo_archive") {
          (window as any).__ccInvokeCalls.push({ cmd, args });
          return Promise.resolve({ id: args.id, done_path: "d", original_path: "o", original_content: "c", plan_line: null, plan_line_index: null });
        }
        return passthrough(cmd, args);
      };
      const pane = document.createElement("main");
      pane.className = "session-pane";
      pane.style.cssText = "position:fixed;inset:0;z-index:1;box-sizing:border-box";
      pane.innerHTML = `<div id="chat-col" style="flex:1"></div>`;
      document.body.appendChild(pane);
      const pv = await import("/views/sessions/preview-panel.ts");
      const mod = await import("/views/sessions/fab-dial.ts");
      const fab = mod.mountFabDial(pane, { onDraft: () => {}, onCode: () => {}, mountPreview: pv.mountPreviewTab });
      fab.setSessionScope(viewer, "C:\\proj");
    },
    { backlog: BACKLOG, docs: Object.fromEntries(TODOS.map((t) => [t.id, DOC(t.id)])), viewer: VIEWER, fraction },
  );
}

const tab = (page: Page) => page.locator('.sp-tab[data-sp-k="backlog"]');
const row = (page: Page, id: string) => page.locator(`.bl-row[data-bl-id="${id}"]`);
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => ((window as any).__ccInvokeCalls as { cmd: string; args: any }[]).filter((x) => x.cmd === c).map((x) => x.args), cmd);

async function openBacklog(page: Page): Promise<void> {
  await expect(tab(page).locator(".sp-count")).toHaveText(String(TODOS.length));
  await tab(page).click();
  await expect(page.locator(".bl-panel")).toBeVisible();
  await expect(row(page, "pc-1264")).toBeVisible();
}

test("wide: the strip tab carries the count, the reader sits left of a 230px list on the right, and nothing is clipped", async ({ page }) => {
  await mountPane(page, 1334, 0.5);
  await openBacklog(page);

  const panel = (await page.locator(".sp-panel").boundingBox())!;
  expect(panel.width).toBeGreaterThan(600);
  const list = (await page.locator(".bl-list-col").boundingBox())!;
  const reader = (await page.locator(".bl-reader-col").boundingBox())!;
  expect(Math.round(list.width)).toBe(230);
  expect(reader.x + reader.width).toBeLessThanOrEqual(list.x + 1);
  expect(Math.round(list.x + list.width)).toBe(Math.round(panel.x + panel.width));

  // Plan groups in PLAN order (the empty "Parked" one included), Backlog last.
  const heads = await page.locator(".bl-group-name").allTextContents();
  expect(heads).toEqual(["Joe's own priorities", "v0.2.140", "Parked", "Backlog"]);
  // Unplanned: newest first.
  const unplanned = await page.locator(".bl-group.is-unplanned .bl-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.blId));
  expect(unplanned).toEqual(["pc-1211", "pc-1440", "pc-1449"]);
  // A claimed row shows the pulse, others the origin dot.
  await expect(row(page, "pc-0926").locator(".bl-pulse")).toHaveCount(1);
  await expect(row(page, "pc-1264").locator(".bl-dot.dev")).toHaveCount(1);

  await row(page, "pc-1407").click();
  await expect(page.locator(".bl-doc-title")).toHaveText("Find why re-shown windows paint white and ignore input");
  await expect(row(page, "pc-1407")).toHaveClass(/is-on/);
  await expect(page.locator(".bl-why")).toBeVisible();
  // Goal, Context and Approach open; Done when and Verify folded.
  const open = await page.locator(".bl-sec").evaluateAll((els) => els.map((e) => [e.querySelector("summary")!.textContent, (e as HTMLDetailsElement).open]));
  expect(open).toEqual([["Goal", true], ["Context", true], ["Approach", true], ["Done when", false], ["Verify", false]]);

  await page.locator('[data-bl-act="archive"]').click();
  await expect(page.locator(".bl-note")).toBeVisible();
  // The footer sits inside the panel, buttons wrap rather than overflow.
  const foot = (await page.locator(".bl-actions").boundingBox())!;
  expect(foot.x + foot.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  expect(foot.y + foot.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
  const overflow = await page.locator(".bl-reader-col").evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "backlog-wide.png") });
  await expectIconButtonsCentred(page);

  await page.locator('[data-bl-act="archive-cancel"]').click();
  await expect(page.locator(".bl-note")).toBeHidden();
});

test("narrow: the list fills the panel, a row opens the reader full width, Back returns", async ({ page }) => {
  await mountPane(page, 1334, 0.31);
  await openBacklog(page);

  const panel = (await page.locator(".sp-panel").boundingBox())!;
  expect(panel.width).toBeGreaterThan(380);
  expect(panel.width).toBeLessThan(420);
  await expect(page.locator(".bl-reader-col")).toBeHidden();
  const list = (await page.locator(".bl-list-col").boundingBox())!;
  expect(Math.round(list.width)).toBe(Math.round(panel.width));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "backlog-narrow-list.png") });

  await row(page, "pc-1407").click();
  await expect(page.locator(".bl-list-col")).toBeHidden();
  await expect(page.locator(".bl-doc-title")).toBeVisible();
  const reader = (await page.locator(".bl-reader-col").boundingBox())!;
  expect(Math.round(reader.width)).toBe(Math.round(panel.width));
  await expect(page.locator(".bl-back")).toBeVisible();

  await page.locator('[data-bl-act="archive"]').click();
  await expect(page.locator(".bl-note")).toBeVisible();
  const foot = (await page.locator(".bl-actions").boundingBox())!;
  expect(foot.x + foot.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  expect(foot.y + foot.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "backlog-narrow.png") });

  await page.locator(".bl-back").click();
  await expect(page.locator(".bl-reader-col")).toBeHidden();
  await expect(page.locator(".bl-list-col")).toBeVisible();
});

test("archiving sends the trimmed note, then a quiet toast offers Undo", async ({ page }) => {
  await mountPane(page, 1334, 0.5);
  await openBacklog(page);
  await row(page, "pc-1407").click();
  await page.locator('[data-bl-act="archive"]').click();
  await page.locator(".bl-note").fill("  superseded  ");
  await page.locator('[data-bl-act="archive-go"]').click();
  await expect(page.locator(".bl-toast")).toBeVisible();
  await expect(page.locator(".bl-toast")).toContainText("Archived pc-1407");
  expect(await calls(page, "ai_todo_archive")).toEqual([{ cwd: "C:\\proj", id: "pc-1407", note: "superseded" }]);
});

test("dragging a row into another group calls ai_todo_plan_move with that group and slot", async ({ page }) => {
  await mountPane(page, 1334, 0.5);
  await openBacklog(page);

  // pc-1264 (first in "Joe's own priorities") dropped onto the top half of pc-1441
  // in "v0.2.140": group v0.2.140, index 0 (in front of it).
  const from = (await row(page, "pc-1264").boundingBox())!;
  const to = (await row(page, "pc-1441").boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + 4, { steps: 8 });
  await expect(row(page, "pc-1441")).toHaveClass(/is-drop-before/);
  await page.mouse.up();

  await expect.poll(() => calls(page, "ai_todo_plan_move")).toEqual([{ cwd: "C:\\proj", id: "pc-1264", group: "v0.2.140", index: 0 }]);
});

test("dragging a row onto the Backlog group unplans it, and a plain click still selects", async ({ page }) => {
  await mountPane(page, 1334, 0.5);
  await openBacklog(page);

  await row(page, "pc-1264").click();
  await expect(page.locator(".bl-doc-title")).toContainText("Hyperfocus");

  const from = (await row(page, "pc-1441").boundingBox())!;
  const end = (await page.locator(".bl-group.is-unplanned .bl-group-end").boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 20, { steps: 3 });
  await page.mouse.move(end.x + 40, end.y + 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => calls(page, "ai_todo_plan_move")).toEqual([{ cwd: "C:\\proj", id: "pc-1441", group: null, index: 3 }]);
  // The drag's trailing click did not select the row it was dropped on.
  await expect(row(page, "pc-1264")).toHaveClass(/is-on/);
});

test("dragging a plan heading reorders the groups", async ({ page }) => {
  await mountPane(page, 1334, 0.5);
  await openBacklog(page);

  const head = (await page.locator('.bl-group[data-group="v0.2.140"] .bl-group-h').boundingBox())!;
  const first = (await page.locator('.bl-group[data-group="Joe\'s own priorities"] .bl-group-h').boundingBox())!;
  await page.mouse.move(head.x + 60, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 60, head.y - 10, { steps: 3 });
  await page.mouse.move(first.x + 60, first.y + 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => calls(page, "ai_todo_plan_reorder_groups")).toEqual([{ cwd: "C:\\proj", groups: ["v0.2.140", "Joe's own priorities", "Parked"] }]);
});
