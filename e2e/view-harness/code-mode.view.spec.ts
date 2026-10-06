// asserts: src/views/sessions/code-mode/code-mode.ts, src/views/sessions/code-mode/events.ts, src/views/sessions/code-mode/git-fold.ts, src/views/sessions/code-mode/explorer-html.ts, src/views/sessions/code-mode/code-mode-shell.css, src/views/sessions/code-mode/code-mode-explorer.css, src/views/sessions/code-mode/code-mode-commits.css, src/views/sessions/code-mode/code-mode-tabs.css, src/shared/chat/file-surface.ts, src/views/sessions/session-header.ts, src/views/sessions/code-mode/branch-switcher.ts, src/views/sessions/code-mode/branch-switcher.css, src/views/sessions/code-mode/data.ts, src/views/sessions/session-statusbar-popovers.ts
import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Code mode in a real browser at Joe's maximized Chats window size: the mode
// covers the chat list and the chat, the back pill names the chat, the explorer
// shows each scope's states, and typing never reaches the hidden composer.

const SIZE = { width: 1359, height: 860 };
const SPAWN = "C:/Projects/alpha";
const SESSIONS = [sessionInstance({ cwd: SPAWN, name: "Code mode review", busy: true })];
// The ahead/behind chip is the statusbar's way into Code mode on what a push
// would send; the merged git chip opens the commit list instead.
const ROW = ["model", "git", "commits"];

const FILES = [
  { path: "src/views/sessions/git-card.ts", status: "M", added: 3, removed: 1, old_path: null },
  { path: "src/shared/chat/unpushed-range.ts", status: "A", added: 9, removed: 0, old_path: null },
  { path: "src/shared/shortcuts.ts", status: "M", added: 3, removed: 8, old_path: null },
  { path: "tests/fab-dial-drafts-autoopen.test.mjs", status: "D", added: 0, removed: 40, old_path: null },
];

const DIFF = [
  "diff --git a/src/shared/shortcuts.ts b/src/shared/shortcuts.ts",
  "@@ -47,6 +47,4 @@ const SHORTCUT_DEFS = [",
  " ",
  ' const LS_KEY = "cc_shortcuts_bindings";',
  '-const LS_SLOT_MODE = "cc_chat_slot_mode";',
  '-const LS_SLOT_ASSIGNMENTS = "cc_chat_slot_assignments";',
  " ",
  "+export function newChatFromFavorite(slot: number): void {",
  "+  void openFavoriteSlot(slot);",
  "+}",
  " let _bindingsCache = null;",
].join("\n");

async function mount(page: Page): Promise<void> {
  await page.setViewportSize(SIZE);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      session_live_cwd: SPAWN,
      get_settings: { theme: "void", statuslineRowsV2Applied: true, statuslineRows: [ROW], statuslineRowsMobile: [ROW] },
      get_git_info: { branch: "master", repo: "alpha", ahead: 2, behind: 0, sha: "abc1234", insertions: null, deletions: null },
      get_commit_sync: {
        ahead: [
          { short_sha: "8b3cb30", message: "FIX: a new draft no longer pops the Drafts panel open" },
          { short_sha: "80b6247", message: "FEAT: Ctrl+Shift+1-9 starts a new chat from a favorite slot" },
        ],
        behind: [],
        has_upstream: true,
      },
      get_recent_branches: [{ name: "master", current: true, short_sha: "8b3cb30", upstream: "origin/master" }],
      get_git_dirty: [" M src/views/sessions/git-card.ts".slice(3)],
      get_range_files: FILES,
      get_file_diff: DIFF,
      get_file_at_rev: { content: "export const x = 1;\n", truncated: false },
      list_project_files: [...FILES.map((f) => f.path), "README.md", "src/main.ts"],
    },
  });
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .session-header .code-mode-btn").waitFor();
  await page.mouse.move(1300, 800);
}

async function shot(target: Parameters<typeof capture>[0], label: string): Promise<void> {
  if (process.env.CC_SHOTS) await capture(target, label);
}

test.describe("view-harness / Code mode", () => {
  test("the header button covers the chat list and the chat; Esc returns", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .code-mode-btn").click();

    const code = page.locator(".code-mode");
    await expect(code).toBeVisible();
    await expect(page.locator(".sessions-sidebar")).toBeHidden();
    await expect(page.locator("#session-pane")).toBeHidden();

    // The back pill: which chat, and that Claude is writing.
    const pill = code.locator(".cm-backchat");
    await expect(pill.locator(".cm-bc-title")).toHaveText("Code mode review");
    await expect(pill.locator(".cm-live")).toHaveClass(/on/);
    await expect(code.locator(".cm-qtitle")).toContainText("This chat");
    await expect(code.locator(".cm-note")).toContainText("hasn't edited any files");
    await shot(page, "code-mode-this-chat-empty");

    await page.keyboard.press("Escape");
    await expect(code).toHaveCount(0);
    await expect(page.locator("#session-pane")).toBeVisible();
  });

  test("Unpushed: badges, WT, the commits fold, Push, then Show older commits as the last row", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .sb-commits-btn").click();
    const code = page.locator(".code-mode");

    await expect(code.locator(".cm-qtitle")).toContainText("Unpushed");
    await expect(code.locator(".cm-qtitle .n")).toHaveText("4");
    const wt = code.locator('[data-file="src/views/sessions/git-card.ts"]');
    await expect(wt).toHaveClass(/wt/);
    await expect(wt.locator(".cm-wt")).toHaveText("WT");
    await expect(code.locator('[data-file="tests/fab-dial-drafts-autoopen.test.mjs"] .pr-file-status')).toHaveText("D");

    await expect(code.locator(".cm-commit[data-commit]")).toHaveCount(2);
    const rows = code.locator(".cm-commits > .cm-commit");
    const push = rows.nth((await rows.count()) - 2);
    await expect(push).toHaveClass(/cm-pushrow/);
    await expect(push).toContainText("Push 2 commits");
    await expect(push.locator(".cm-branchbtn")).toContainText("origin/master");
    const last = rows.last();
    await expect(last).toHaveClass(/cm-older-trigger/);
    await expect(last).toContainText("Show older commits");
    await shot(page, "code-mode-unpushed");
  });

  test("Show older commits pages in pushed history below Push; clicking a row opens that commit", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .sb-commits-btn").click();
    const code = page.locator(".code-mode");

    // The raw log interleaves the still-unpushed commit with older pushed
    // ones - the already-shown "80b6247" must not repeat below.
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
      const orig = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "get_commit_history") {
          return Promise.resolve({
            entries: [
              { short_sha: "80b6247", message: "FEAT: Ctrl+Shift+1-9 starts a new chat from a favorite slot", pushed: false, timestamp: 2 },
              { short_sha: "deadbee", message: "REFACTOR: split the usage poller out of boot", pushed: true, timestamp: 1 },
            ],
            has_more: false,
            has_upstream: true,
          });
        }
        if (cmd === "get_range_files" && args?.to === "deadbee") {
          return Promise.resolve([{ path: "src/daemon/boot.rs", status: "M", added: 2, removed: 0, old_path: null }]);
        }
        return orig(cmd, args);
      };
    });

    await code.locator('[data-act="older-commits"]').click();
    const older = code.locator('[data-commit="deadbee"]');
    await expect(older).toBeVisible();
    await expect(older).toHaveClass(/cm-older/);
    // Deduped: the unpushed commit the history page re-listed stays singular.
    await expect(code.locator('[data-commit="80b6247"]')).toHaveCount(1);
    // Exhausted (has_more: false) - the trigger is gone.
    await expect(code.locator('[data-act="older-commits"]')).toHaveCount(0);
    await shot(page, "code-mode-older-commits");

    await older.click();
    await expect(code.locator(".cm-ctitle")).toHaveText("REFACTOR: split the usage poller out of boot");
    await expect(code.locator('[data-file="src/daemon/boot.rs"]')).toBeVisible();
  });

  test("a file opens as a tab with icon-only diff tools in the tab row", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .sb-commits-btn").click();
    const code = page.locator(".code-mode");
    await code.locator('[data-file="src/shared/shortcuts.ts"]').click();

    await expect(code.locator(".cm-tab.on")).toContainText("shortcuts.ts");
    await expect(code.locator(".fs-path .fs-leaf")).toHaveText("shortcuts.ts");
    await expect(code.locator("table.fs-udiff tr.fs-add")).toHaveCount(3);
    // Diff controls live at the right end of the tab row, not a toolbar row.
    await expect(code.locator(".cm-tabs .cm-tools .fs-split-btn")).toBeVisible();
    await code.locator(".fs-split-btn").click();
    await expect(code.locator("table.fs-sdiff")).toBeVisible();

    // The tab close target is bigger than its icon.
    const box = await code.locator(".cm-tab.on .cm-x").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    await shot(page, "code-mode-diff-tab");
  });

  test("opening a commit swaps the header for its title and hash", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .sb-commits-btn").click();
    const code = page.locator(".code-mode");
    await code.locator('[data-commit="80b6247"]').click();

    await expect(code.locator(".cm-ctitle")).toHaveText("FEAT: Ctrl+Shift+1-9 starts a new chat from a favorite slot");
    await expect(code.locator(".cm-csha")).toContainText("80b6247");
    // Opening a commit opens its first file; inside it M badges hide.
    await expect(code.locator(".cm-tab.on")).toHaveCount(1);
    await expect(code.locator('[data-file="src/shared/shortcuts.ts"] .pr-file-status')).toHaveCount(0);
    await shot(page, "code-mode-commit");

    await code.locator('[data-act="scope-back"]').click();
    await expect(code.locator(".cm-qtitle")).toContainText("Unpushed");
  });

  test("the scope menu switches to All files, unchanged files included", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .code-mode-btn").click();
    const code = page.locator(".code-mode");
    await code.locator(".cm-qtitle").click();
    await expect(code.locator(".cm-scope-menu .cm-mi")).toHaveCount(4);
    await code.locator('.cm-mi[data-scope="all"]').click();

    await expect(code.locator('[data-file="README.md"]')).toBeVisible();
    await expect(code.locator('[data-file="README.md"]')).not.toHaveClass(/chg/);
    await expect(code.locator('[data-file="src/shared/shortcuts.ts"]')).toHaveClass(/chg/);
  });

  test("typing while in Code mode never lands in the hidden message box", async ({ page }) => {
    await mount(page);
    const composer = page.locator("#session-pane .session-composer .composer-textarea");
    await composer.fill("MARKER");
    await page.locator("#session-pane .code-mode-btn").click();
    await page.locator(".code-mode").waitFor();
    await page.keyboard.press("2");
    await page.keyboard.press("Escape");
    await expect(composer).toHaveValue("MARKER");
  });

  test("Preview on a branch shows its tree read-only, badged, with a Check out button", async ({ page }) => {
    await mount(page);
    await page.locator("#session-pane .sb-commits-btn").click();
    const code = page.locator(".code-mode");

    await page.evaluate(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
      const orig = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "get_recent_branches") {
          return Promise.resolve([
            { name: "master", current: true, short_sha: "8b3cb30", upstream: "origin/master" },
            { name: "feature/preview-me", current: false, short_sha: "def5678", upstream: null },
          ]);
        }
        if (cmd === "list_branch_files") {
          return Promise.resolve(["src/shared/shortcuts.ts", "src/shared/branch-only-file.ts"]);
        }
        if (cmd === "get_range_files" && args?.base === "HEAD" && args?.to === "feature/preview-me") {
          return Promise.resolve([{ path: "src/shared/shortcuts.ts", status: "M", added: 1, removed: 0, old_path: null }]);
        }
        return orig(cmd, args);
      };
    });

    await code.locator(".cm-branchbtn").click();
    await code.locator('.bs-preview[data-preview="feature/preview-me"]').click();

    await expect(code.locator(".cm-ctitle")).toContainText("feature/preview-me");
    await expect(code.locator('[data-file="src/shared/shortcuts.ts"] .pr-file-status')).toHaveText("M");
    await expect(code.locator('[data-file="src/shared/branch-only-file.ts"] .pr-file-status')).toHaveCount(0);
    await expect(code.locator('[data-act="checkout-branch"]')).toBeVisible();
    await shot(page, "code-mode-branch-preview");

    // Opening a file the diff never flagged still reads that branch's own
    // content (get_file_at_rev with rev=branch), not the working tree.
    await code.locator('[data-file="src/shared/branch-only-file.ts"]').click();
    await expect(code.locator(".cm-tab.on")).toContainText("branch-only-file.ts");

    // Check out reuses the branch switcher's own checkout flow, filtered to
    // exactly the previewed branch - not a second call path.
    await code.locator('[data-act="checkout-branch"]').click();
    await expect(code.locator('.sb-git-pop-row.pick[data-branch="feature/preview-me"]')).toBeVisible();
    await expect(code.locator(".sb-git-pop-row.pick")).toHaveCount(1);
  });

  test("Ctrl+Shift+E enters and leaves", async ({ page }) => {
    await mount(page);
    await page.keyboard.press("Control+Shift+E");
    await expect(page.locator(".code-mode")).toBeVisible();
    await page.keyboard.press("Control+Shift+E");
    await expect(page.locator(".code-mode")).toHaveCount(0);
  });
});
