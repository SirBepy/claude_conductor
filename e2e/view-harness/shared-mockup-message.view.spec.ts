import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mountSessionsLayout, mountView, capture, invokeCalls, sessionInstance } from "./harness";

// asserts: src/views/sessions/shared-mockup-message.ts, src/views/sessions/shared-mockup-bar.ts, src/views/sessions/shared-mockup-model.ts, src/views/sessions/preview-panel.ts, src/views/sessions/shared-mockup.css

// pc-1668 frontend: the shared mockup's "Page" entry (shell controls) and the
// Alt-click box that messages the owner of an element. The page's two scripts
// are read from the Rust source (CONTROL_SCRIPT, ELEMENT_SCRIPT in
// daemon/preview/shared.rs), so the spec drives what the daemon really composes.
// Alt-click is a real keyboard modifier plus a real mouse click.

const PANEL = '.sp-panel[data-active="preview"]';
const NOW = new Date().toISOString();

function rustConst(name: string): string {
  const src = readFileSync("src-tauri/src/daemon/preview/shared.rs", "utf8");
  const m = new RegExp(`const ${name}: &str = "(.*)";`).exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

const sel = (id: string, label: string, options: string[]) => ({ id, label, kind: "select", options, default: options[0] });
const sw = (id: string, label: string, on = false) => ({ id, label, kind: "switch", options: [], default: on ? "on" : "off" });
const SHELL_CONTROLS = [sel("layout", "Layout", ["wide", "narrow"]), sw("rail", "Side rail")];

const sessions = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: "C:/Projects/cv" }),
  sessionInstance({ session_id: "sub-hero", name: "Hero header", pid: 102, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
  sessionInstance({ session_id: "sub-layout", name: "Layout", pid: 103, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
];

function pageHtml(): string {
  const css = `main { padding: 20px; } .shellp { color: rgb(10, 20, 30); height: 60px; }
    main[data-layout="narrow"] .shellp { color: rgb(200, 0, 0); }`;
  return `<main data-cc-root data-layout="wide" data-rail="off"><div data-part="header" style="height:120px"><h3>Ana Horvat</h3></div><p class="shellp">shell text</p></main><style>${css}</style>${rustConst("CONTROL_SCRIPT")}${rustConst("ELEMENT_SCRIPT")}`;
}

const shared = {
  owner_session_id: "main",
  shell: "",
  parts: [{ id: "header", owner_session_id: "sub-hero", owner_name: "Hero header", html: "", css: "", controls: [] }],
  layout_session_id: "sub-layout",
  controls: SHELL_CONTROLS,
};
const snap = {
  id: "shared-1", slug: "portfolio", title: "Portfolio", source: "chat", session_id: "main", version: 1, created_at: NOW,
  published: null, shared, html: pageHtml(), view_state: {},
};
const meta = { id: snap.id, slug: snap.slug, title: snap.title, source: snap.source, session_id: "main", version: 1, created_at: NOW, versions: [], shared: true };

async function openShared(page: Page, width = 1100): Promise<void> {
  await page.setViewportSize({ width, height: 760 });
  await mountView(page, {
    invoke: {
      list_previews: [meta],
      render_preview_doc: "about:blank",
      set_preview_state: null,
      message_shared_element: { ok: true, target_session_id: "sub-hero", target_name: "Hero header", element: "header" },
    },
  });
  await mountSessionsLayout(page);
  await page.evaluate(async ({ s }) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const orig = tauri.core.invoke;
    const w = window as unknown as Record<string, any>;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "render_preview_doc") return Promise.resolve(`data:text/html;charset=utf-8,${encodeURIComponent(args.html)}`);
      if (cmd === "get_preview") return Promise.resolve(s);
      if (cmd === "message_shared_element" && w.__failSend) return Promise.reject(w.__failSend);
      return orig(cmd, args);
    };
    const { state } = await import("/views/sessions/state.ts");
    (state as { sessions: unknown[] }).sessions = w.__sessions;
    w.__fab.setSessionScope("main", "/proj");
    w.__preview.open();
  }, { s: snap });
  await expect(page.locator(`${PANEL} .pv-name`)).toHaveText("portfolio");
  await expect(page.locator(`${PANEL} .pv-iframe`)).toBeVisible();
  await expect(frameEl(page, "h3")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((s) => { (window as unknown as { __sessions: unknown }).__sessions = s; }, sessions);
});

const frameEl = (page: Page, css: string) => page.frameLocator(`${PANEL} .pv-iframe`).locator(css);
const chip = (page: Page, id: string) => page.locator(`${PANEL} .pvs-chip[data-owner="${id}"]`);
const pop = (page: Page) => page.locator(`${PANEL} .pvs-pop`);
const box = (page: Page) => page.locator(`${PANEL} .pvm-box`);

async function altClick(page: Page, target: ReturnType<typeof frameEl>): Promise<void> {
  const b = (await target.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.click(b.x + 10, b.y + 10);
  await page.keyboard.up("Alt");
}

async function calls(page: Page, cmd: string) {
  return (await invokeCalls(page)).filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
}

test.describe("view-harness / shared mockup element message and Page entry", () => {
  test("the Page entry flips a shell select: the frame root's data attribute changes and ctl|shell|<id> is saved", async ({ page }) => {
    await openShared(page);
    await expect(chip(page, "shell")).toContainText("Page");
    await expect(frameEl(page, "main")).toHaveAttribute("data-layout", "wide");
    await chip(page, "shell").click();
    await expect(pop(page).locator("select")).toHaveCount(1);
    await expect(pop(page).locator('[role="switch"]')).toHaveCount(1);
    await pop(page).locator("select").selectOption("narrow");
    await expect(frameEl(page, "main")).toHaveAttribute("data-layout", "narrow");
    await expect(frameEl(page, ".shellp")).toHaveCSS("color", "rgb(200, 0, 0)");
    expect(await calls(page, "set_preview_state")).toContainEqual({ id: "shared-1", key: "ctl|shell|layout", value: "narrow" });
    await pop(page).locator('[role="switch"]').click();
    await expect(frameEl(page, "main")).toHaveAttribute("data-rail", "on");
    expect(await calls(page, "set_preview_state")).toContainEqual({ id: "shared-1", key: "ctl|shell|rail", value: "on" });
  });

  test("Alt-click on a region messages that region; the box names it and sends only the text", async ({ page }) => {
    await openShared(page);
    await altClick(page, frameEl(page, "h3"));
    await expect(box(page)).toBeVisible();
    await expect(box(page).locator(".pvm-to")).toHaveText("To: header region");
    await expect(box(page).locator("select")).toHaveCount(0);
    await box(page).locator("textarea").fill("make the name bigger");
    await capture(page.locator(PANEL), "shared-element-box");
    await box(page).locator("[data-send]").click();
    await expect(box(page).locator(".pvm-status")).toHaveText("Sent to Hero header.");
    expect(await calls(page, "message_shared_element")).toEqual([{ id: "shared-1", element: "header", text: "make the name bigger" }]);
  });

  test("Alt-click on the page itself messages the shell, and a plain click does nothing", async ({ page }) => {
    await openShared(page);
    const b = (await frameEl(page, ".shellp").boundingBox())!;
    await page.mouse.click(b.x + 10, b.y + 10);
    await expect(box(page)).toHaveCount(0);
    await altClick(page, frameEl(page, ".shellp"));
    await expect(box(page).locator(".pvm-to")).toHaveText("To: page layout");
    await box(page).locator("textarea").fill("move the rail left");
    await box(page).locator("[data-send]").click();
    await expect.poll(async () => (await calls(page, "message_shared_element")).length).toBe(1);
    expect((await calls(page, "message_shared_element"))[0]).toEqual({ id: "shared-1", element: "shell", text: "move the rail left" });
  });

  test("a failed send shows the error inline and keeps the text", async ({ page }) => {
    await openShared(page);
    await page.evaluate(() => { (window as unknown as { __failSend: string }).__failSend = "SESSION_BUSY: Hero header is busy"; });
    await altClick(page, frameEl(page, "h3"));
    await box(page).locator("textarea").fill("keep me");
    await box(page).locator("[data-send]").click();
    await expect(box(page).locator(".pvm-status")).toContainText("SESSION_BUSY");
    await expect(box(page).locator("textarea")).toHaveValue("keep me");
    await expect(box(page).locator("[data-send]")).toBeEnabled();
  });

  test("the box opens inside the panel even for a click at the page's far corner", async ({ page }) => {
    await openShared(page);
    const f = (await page.locator(`${PANEL} .pv-iframe`).boundingBox())!;
    await page.keyboard.down("Alt");
    await page.mouse.click(f.x + f.width - 4, f.y + f.height - 4);
    await page.keyboard.up("Alt");
    await expect(box(page)).toBeVisible();
    const p = (await page.locator(PANEL).boundingBox())!;
    const b = (await box(page).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 1);
    expect(b.y).toBeGreaterThanOrEqual(p.y - 1);
  });
});
