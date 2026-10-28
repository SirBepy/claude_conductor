// asserts: src/shared/chat/file-editor.ts, src/shared/chat/file-editor.css, src/shared/chat/file-surface.ts, src/shared/chat/file-surface.css, src/views/file-window/file-window.ts, src/views/file-window/file-window.css, src/shared/open-file.ts
import { expect, test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// The Files window's editor in a real browser: it autosaves after typing
// stops, never overwrites a change made on disk meanwhile, keeps a CRLF file
// CRLF, explains why a file is read-only, and opens markdown rendered.

const FILE = "C:/Projects/alpha/src/main.ts";

interface Disk {
  files: Record<string, { content: string; mtime: number; writable: boolean }>;
  writes: { path: string; content: string; expectedMtimeUs: number | null }[];
  /** Fails the next write as if a chat had edited the file first. */
  conflictNext: boolean;
}

/** Mounts the Files window on a fake disk; returns nothing, state lives on
 *  `window.__disk`. */
async function mountFiles(page: Page, files: Disk["files"], first: string): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 700 });
  await mountView(page, { view: "sessions", invoke: SESSIONS_BASE_INVOKE });
  await page.evaluate(async ({ files, first }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __disk: Disk;
    };
    const disk: Disk = { files, writes: [], conflictNext: false };
    w.__disk = disk;
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      const path = (args?.path as string | undefined)?.replace(/\\/g, "/") ?? "";
      const f = disk.files[path];
      if (cmd === "stat_text_file") return f ? Promise.resolve({ mtime_us: f.mtime, writable: f.writable }) : Promise.reject(new Error("file not found"));
      if (cmd === "read_text_file") return f ? Promise.resolve({ content: f.content, truncated: false }) : Promise.reject(new Error("file not found"));
      if (cmd === "write_text_file") {
        const a = args as { path: string; content: string; expectedMtimeUs: number | null };
        if (disk.conflictNext) {
          disk.conflictNext = false;
          return Promise.reject("CHANGED_ON_DISK: the file changed on disk since it was opened");
        }
        disk.writes.push({ path, content: a.content, expectedMtimeUs: a.expectedMtimeUs });
        f!.content = a.content;
        f!.mtime += 1;
        return Promise.resolve(f!.mtime);
      }
      return orig(cmd, args);
    };
    document.querySelectorAll<HTMLElement>("body > *").forEach((el) => { el.style.display = "none"; });
    const app = document.createElement("div");
    app.id = "fw-test";
    document.body.appendChild(app);
    const { mountFileWindow } = await import("/views/file-window/file-window.ts");
    mountFileWindow(app, { path: first, line: null });
  }, { files, first });
  await page.locator("#fw-test .cm-content").first().waitFor();
}

const disk = (page: Page) => page.evaluate(() => (window as unknown as { __disk: Disk }).__disk);

test.describe("view-harness / file editor", () => {
  test("typing autosaves once it stops, with the stamp it loaded", async ({ page }) => {
    await mountFiles(page, { [FILE]: { content: "export const x = 1;\n", mtime: 100, writable: true } }, FILE);
    await expect(page.locator("#fw-test .cm-tab.on")).toContainText("main.ts");
    await page.locator("#fw-test .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("// hi");
    await expect.poll(async () => (await disk(page)).writes.length).toBe(1);
    const [w] = (await disk(page)).writes;
    expect(w!.expectedMtimeUs).toBe(100);
    expect(w!.content).toBe("export const x = 1;\n// hi");
    // A second burst sends the stamp the first write returned.
    await page.keyboard.type("!");
    await expect.poll(async () => (await disk(page)).writes.length).toBe(2);
    expect((await disk(page)).writes[1]!.expectedMtimeUs).toBe(101);
  });

  test("a CRLF file goes back to disk CRLF, its BOM kept", async ({ page }) => {
    await mountFiles(page, { [FILE]: { content: "\uFEFFa\r\nb\r\n", mtime: 5, writable: true } }, FILE);
    await page.locator("#fw-test .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("c");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await disk(page)).writes.length).toBeGreaterThan(0);
    const last = (await disk(page)).writes.at(-1)!;
    expect(last.content).toBe("\uFEFFa\r\nb\r\nc\r\n");
  });

  test("a write refused because the file changed on disk offers both versions", async ({ page }) => {
    await mountFiles(page, { [FILE]: { content: "one\n", mtime: 1, writable: true } }, FILE);
    await page.evaluate(() => { (window as unknown as { __disk: Disk }).__disk.conflictNext = true; });
    await page.locator("#fw-test .cm-content").click();
    await page.keyboard.type("mine ");
    const bar = page.locator("#fw-test .fe-conflict");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("changed on disk");
    expect((await disk(page)).writes).toHaveLength(0);
    await bar.locator('[data-act="mine"]').click();
    await expect(bar).toBeHidden();
    const w = (await disk(page)).writes[0]!;
    expect(w.expectedMtimeUs).toBeNull();
    expect(w.content).toContain("mine ");
  });

  test("a change on disk while the file sits unedited reloads it in place", async ({ page }) => {
    await mountFiles(page, { [FILE]: { content: "before\n", mtime: 1, writable: true } }, FILE);
    await expect(page.locator("#fw-test .cm-content")).toContainText("before");
    await page.evaluate((p) => {
      const f = (window as unknown as { __disk: Disk }).__disk.files[p]!;
      f.content = "after a chat edit\n";
      f.mtime = 9;
    }, FILE);
    await expect(page.locator("#fw-test .cm-content")).toContainText("after a chat edit", { timeout: 5000 });
    expect((await disk(page)).writes).toHaveLength(0);
  });

  test("a CRLF file shortened on disk reloads with the cursor near its old end", async ({ page }) => {
    // Raw string length counts each CRLF twice; the editor's doc counts it
    // once, so a cursor clamped to the string would land past the doc's end.
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n";
    await mountFiles(page, { [FILE]: { content: long, mtime: 1, writable: true } }, FILE);
    await page.locator("#fw-test .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.evaluate((p) => {
      const f = (window as unknown as { __disk: Disk }).__disk.files[p]!;
      f.content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n";
      f.mtime = 2;
    }, FILE);
    await expect(page.locator("#fw-test .cm-content")).not.toContainText("line 35", { timeout: 5000 });
    await expect(page.locator("#fw-test .cm-content")).toContainText("line 29");
  });

  test("a file outside every project says why it is read-only and never writes", async ({ page }) => {
    const outside = "C:/Windows/notes.txt";
    await mountFiles(page, { [outside]: { content: "hands off\n", mtime: 1, writable: false } }, outside);
    await expect(page.locator("#fw-test .fs-status")).toHaveText("Read-only: outside your projects");
    await page.locator("#fw-test .cm-content").click();
    await page.keyboard.type("x");
    await page.waitForTimeout(900);
    await expect(page.locator("#fw-test .cm-content")).toHaveText("hands off");
    expect((await disk(page)).writes).toHaveLength(0);
  });

  test("a second open adds a tab; markdown opens rendered without its HTML comments, Source shows the editor", async ({ page }) => {
    const md = "C:/Projects/alpha/.claude/todos/12-thing.md";
    await mountFiles(page, {
      [FILE]: { content: "x\n", mtime: 1, writable: true },
      [md]: { content: "<!-- claim note -->\n# Make the thing\n\n**Type:** task\n", mtime: 1, writable: true },
    }, FILE);
    // What open_file_window emits when the window is already open.
    await page.evaluate((p) => {
      const w = window as unknown as { __ccListeners: Map<string, Set<(e: { payload: unknown }) => void>> };
      w.__ccListeners.get("file-window-open")?.forEach((cb) => cb({ payload: { path: p, line: null } }));
    }, md);
    await expect(page.locator("#fw-test .cm-tab")).toHaveCount(2);
    await expect(page.locator("#fw-test .cm-tab.on")).toContainText("12-thing.md");
    const body = page.locator("#fw-test .fs-md");
    await expect(body.locator("h1")).toHaveText("Make the thing");
    await expect(body).not.toContainText("claim note");
    await page.locator("#fw-test .fs-md-btn").click();
    await expect(page.locator("#fw-test .cm-content")).toContainText("<!-- claim note -->");
  });
});
