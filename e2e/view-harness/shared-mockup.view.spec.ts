import { test, expect, type Page } from "@playwright/test";
import { mountSessionsLayout, mountView, capture, fireEvent, invokeCalls, sessionInstance } from "./harness";

// asserts: src/views/sessions/shared-mockup-bar.ts, src/views/sessions/shared-mockup-model.ts, src/views/sessions/shared-mockup-scope.ts, src/views/sessions/shared-mockup.css, src/views/sessions/preview-panel.ts, src/views/sessions/preview-panel-history.ts, src/views/sessions/preview-panel-header.ts, src/views/sessions/preview-panel-selection.ts

// The shared mockup (pc-1620): one page a main chat's subs each add controls to.
// The row of subs sits under the preview header; a sub opens a draggable popover
// of its controls (dropdown per choice, switch per yes/no) that never leaves the
// panel; a change reaches the staged frame with no reload; the picker lists
// Shared then Dedicated and a dedicated page leads back. Real clicks and real
// mouse drags, with the page staged in a real sandboxed frame. The Page entry
// and the Alt-click message box (pc-1668) are covered in shared-mockup-message.view.spec.ts.

const PANEL = '.sp-panel[data-active="preview"]';
const NOW = new Date().toISOString();

const sel = (id: string, label: string, options: string[]) => ({ id, label, kind: "select", options, default: options[0] });
const sw = (id: string, label: string, on = false) => ({ id, label, kind: "switch", options: [], default: on ? "on" : "off" });

const HERO_CONTROLS = [
  sel("style", "Style", ["aurora", "ember", "mesh"]),
  sel("layout", "Layout", ["centered", "left"]),
  sw("photo", "Photo", true),
  sw("sub", "Subtitle line", true),
  sw("big", "Large name"),
];
const CONTACT_CONTROLS = [sel("form", "Form", ["inline", "card"]), sw("map", "Map")];

const sessions = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: "C:/Projects/cv" }),
  sessionInstance({ session_id: "sub-hero", name: "Hero header", pid: 102, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
  sessionInstance({ session_id: "sub-contact", name: "Contact", pid: 103, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
  sessionInstance({ session_id: "sub-skills", name: "Skills", pid: 104, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
  sessionInstance({ session_id: "sub-footer", name: "Footer", pid: 105, cwd: "C:/Projects/cv", subchat_of: "main", busy: true }),
];

const part = (id: string, owner: string, name: string, controls: unknown[]) => ({ id, owner_session_id: owner, owner_name: name, html: "", css: "", controls });
const snapshot = (parts: unknown[], version: number) => ({
  id: "shared-1", slug: "portfolio", title: "Portfolio", source: "chat", session_id: "main", version, created_at: NOW,
  published: null, shared: { owner_session_id: "main", shell: "", parts }, html: pageHtml(),
});
const metaOf = (s: ReturnType<typeof snapshot>) => ({ id: s.id, slug: s.slug, title: s.title, source: s.source, session_id: s.session_id, version: s.version, created_at: NOW, versions: [], shared: true });
const DEDICATED = { id: "ded-1", slug: "footer-spacing", title: "Footer spacing", source: "chat_card", session_id: "sub-footer", version: 1, created_at: NOW, versions: [], shared: false };

/** The document the daemon composes for the header region: attributes from the
 *  controls' defaults, css under @scope, and the listener that applies a change. */
function pageHtml(): string {
  const listener = `<script>window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.cc!=="control")return;var els=document.querySelectorAll("[data-part]");for(var i=0;i<els.length;i++){if(els[i].getAttribute("data-part")===d.part){els[i].setAttribute("data-"+d.id,String(d.value));}}});</script>`;
  const css = `@scope ([data-part="header"]) {
    h3 { color: rgb(10, 20, 30); }
    :scope[data-style="ember"] h3 { color: rgb(200, 0, 0); }
    :scope[data-photo="off"] .photo { display: none; }
  }`;
  return `<div data-part="header" data-style="aurora" data-layout="centered" data-photo="on" data-sub="on" data-big="off"><h3>Ana Horvat</h3><div class="photo">PHOTO</div></div><style>${css}</style><div data-part="contact" data-form="inline" data-map="off"><p>contact region</p></div>${listener}`;
}

async function openShared(page: Page, snap = snapshot([part("header", "sub-hero", "Hero header", HERO_CONTROLS), part("contact", "sub-contact", "Contact", CONTACT_CONTROLS)], 2)): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 760 });
  await mountView(page, { invoke: { list_previews: [metaOf(snap), DEDICATED], render_preview_doc: "about:blank" } });
  await mountSessionsLayout(page);
  await page.addStyleTag({ content: ".sb-popover { z-index: 20000 !important; }" });
  // The page is staged for real: the doc the panel built becomes the frame's data: URL, and the current
  // snapshot is swappable so a later push can be simulated.
  await page.evaluate(async ({ list, snapshotNow, ded }) => {
    const tauri = (window as unknown as { __TAURI__: any }).__TAURI__;
    const orig = tauri.core.invoke;
    const w = window as unknown as Record<string, unknown>;
    w.__snap = snapshotNow;
    w.__list = list;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "render_preview_doc") return Promise.resolve(`data:text/html;charset=utf-8,${encodeURIComponent(args.html)}`);
      if (cmd === "get_preview") return Promise.resolve(args.id === "ded-1" ? { ...ded, html: "<p>footer spacing</p>" } : w.__snap);
      if (cmd === "list_previews") return Promise.resolve([w.__list, ded].flat());
      return orig(cmd, args);
    };
    const { state } = await import("/views/sessions/state.ts");
    (state as { sessions: unknown[] }).sessions = (window as unknown as { __sessions: unknown[] }).__sessions;
    (window as unknown as { __fab: { setSessionScope(a: string, b: string): void } }).__fab.setSessionScope("main", "/proj");
    (window as unknown as { __preview: { open(): void } }).__preview.open();
  }, { list: [metaOf(snap)], snapshotNow: snap, ded: DEDICATED });
  await expect(page.locator(`${PANEL} .pv-name`)).toHaveText("portfolio");
  await expect(page.locator(`${PANEL} .pv-iframe`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((s) => { (window as unknown as { __sessions: unknown }).__sessions = s; }, sessions);
});

const frameEl = (page: Page, css: string) => page.frameLocator(`${PANEL} .pv-iframe`).locator(css);
const chip = (page: Page, id: string) => page.locator(`${PANEL} .pvs-chip[data-owner="${id}"]`);
const pop = (page: Page) => page.locator(`${PANEL} .pvs-pop`);

async function rect(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; });
}

test.describe("view-harness / shared mockup", () => {
  test("the row names the subs: controls clickable, others dashed, a subchats icon and no 'Showing' word", async ({ page }) => {
    await openShared(page);
    const row = page.locator(`${PANEL} .pv-shared`);
    await expect(row.locator(".ph-tree-structure")).toBeVisible();
    await expect(row).not.toContainText("Showing");
    await expect(chip(page, "sub-hero")).toBeEnabled();
    await expect(chip(page, "sub-skills")).toHaveClass(/idle/);
    await expect(chip(page, "sub-footer")).toHaveClass(/idle/);
    // The ring around each avatar is the sub's state (working: yellow ring).
    await expect(chip(page, "sub-hero").locator(".avatar-ring")).toBeVisible();
    await expect(page.locator(`${PANEL} .pv-kind`)).toContainText("Shared");
    await capture(page.locator(PANEL), "shared-mockup-row");
  });

  test("a dashed chip does nothing when clicked", async ({ page }) => {
    await openShared(page);
    await chip(page, "sub-skills").click();
    await expect(pop(page)).toHaveCount(0);
  });

  test("a sub's popover has a small label over each dropdown, switches as rows, no title and no chip options", async ({ page }) => {
    await openShared(page);
    await chip(page, "sub-hero").click();
    await expect(pop(page)).toBeVisible();
    await expect(pop(page).locator("select")).toHaveCount(2);
    await expect(pop(page).locator('[role="switch"]')).toHaveCount(3);
    const label = await rect(page, `${PANEL} .pvs-field >> nth=0 >> span`);
    const select = await rect(page, `${PANEL} .pvs-field >> nth=0 >> select`);
    expect(label.bottom).toBeLessThanOrEqual(select.y + 1);
    expect(Math.abs(label.x - select.x)).toBeLessThan(2);
    // Opens clear of the row, so the other chips stay clickable.
    const row = await rect(page, `${PANEL} .pv-shared`);
    const p = await rect(page, `${PANEL} .pvs-pop`);
    expect(p.y).toBeGreaterThanOrEqual(row.bottom);
    await chip(page, "sub-contact").click();
    await expect(pop(page).locator("select")).toHaveCount(1);
    await capture(page.locator(PANEL), "shared-mockup-popover");
  });

  test("choosing from a dropdown and flipping a switch changes the page with no reload of the frame", async ({ page }) => {
    await openShared(page);
    const renders = async () => (await invokeCalls(page)).filter((c) => c.cmd === "render_preview_doc").length;
    const before = await renders();
    await frameEl(page, "h3").waitFor();
    // Mark the live frame document; a re-stage would drop this.
    await page.locator(`${PANEL} .pv-iframe`).evaluate((f) => { (f as HTMLIFrameElement).dataset.mark = "kept"; });
    await expect(frameEl(page, "h3")).toHaveCSS("color", "rgb(10, 20, 30)");
    await chip(page, "sub-hero").click();
    await pop(page).locator("select").first().selectOption("ember");
    await expect(frameEl(page, "h3")).toHaveCSS("color", "rgb(200, 0, 0)");
    await expect(frameEl(page, ".photo")).toBeVisible();
    await pop(page).locator('[role="switch"]').first().click();
    await expect(frameEl(page, ".photo")).toBeHidden();
    await expect(pop(page).locator('[role="switch"]').first()).toHaveAttribute("aria-checked", "false");
    expect(await renders()).toBe(before);
    await expect(page.locator(`${PANEL} .pv-iframe`)).toHaveAttribute("data-mark", "kept");
  });

  test("a sub's css cannot reach another sub's region", async ({ page }) => {
    await openShared(page);
    await expect(frameEl(page, '[data-part="contact"] p')).not.toHaveCSS("color", "rgb(10, 20, 30)");
  });

  test("the popover drags by its grip and never leaves the panel, even when a taller list opens at the bottom", async ({ page }) => {
    await openShared(page);
    await chip(page, "sub-contact").click();
    const grip = page.locator(`${PANEL} .pvs-grip`);
    const g = await rect(page, `${PANEL} .pvs-grip`);
    const panel = await rect(page, PANEL);
    await page.mouse.move(g.x + g.w / 2 - 20, g.y + g.h / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.w / 2 - 20, panel.bottom + 200, { steps: 8 });
    await page.mouse.up();
    let p = await rect(page, `${PANEL} .pvs-pop`);
    expect(p.bottom).toBeLessThanOrEqual(panel.bottom + 1);
    expect(p.y).toBeGreaterThan(g.y + 40);
    // The tall list (Hero header) opens where the short one was left.
    await chip(page, "sub-hero").click();
    p = await rect(page, `${PANEL} .pvs-pop`);
    const after = await rect(page, PANEL);
    expect(p.bottom).toBeLessThanOrEqual(after.bottom + 1);
    expect(p.y).toBeGreaterThanOrEqual(after.y);
    await expect(grip).toBeVisible();
    // A narrower window pulls it back inside as well.
    await page.setViewportSize({ width: 900, height: 600 });
    p = await rect(page, `${PANEL} .pvs-pop`);
    const small = await rect(page, PANEL);
    expect(p.right).toBeLessThanOrEqual(small.right + 1);
    expect(p.bottom).toBeLessThanOrEqual(small.bottom + 1);
    await capture(page.locator(PANEL), "shared-mockup-clamped");
  });

  test("the close button shuts the popover and the chip lets go", async ({ page }) => {
    await openShared(page);
    await chip(page, "sub-hero").click();
    await pop(page).locator(".pvs-x").click();
    await expect(pop(page)).toHaveCount(0);
    await expect(chip(page, "sub-hero")).not.toHaveClass(/open/);
  });

  test("a sub adding controls later puts a 'new' dot on its chip, opens nothing, and the dot goes once looked at", async ({ page }) => {
    await openShared(page);
    await expect(chip(page, "sub-skills")).toHaveClass(/idle/);
    const next = snapshot([
      part("header", "sub-hero", "Hero header", HERO_CONTROLS),
      part("contact", "sub-contact", "Contact", CONTACT_CONTROLS),
      part("skills", "sub-skills", "Skills", [sel("display", "Display", ["chips", "bars"])]),
    ], 3);
    await page.evaluate((n) => { (window as unknown as { __snap: unknown }).__snap = n; }, next);
    await fireEvent(page, "preview", [{ snapshot: metaOf(next) }]);
    await expect(chip(page, "sub-skills")).toHaveClass(/fresh/);
    await expect(chip(page, "sub-skills")).not.toHaveClass(/idle/);
    await expect(chip(page, "sub-hero")).not.toHaveClass(/fresh/);
    await expect(pop(page)).toHaveCount(0);
    await chip(page, "sub-skills").click();
    await expect(chip(page, "sub-skills")).not.toHaveClass(/fresh/);
    await expect(pop(page).locator("select")).toHaveCount(1);
  });

  test("the picker lists Shared then Dedicated with the owner's tag, and a dedicated page leads back", async ({ page }) => {
    await openShared(page);
    await page.locator(`${PANEL} .pv-pick-name`).click();
    const labels = page.locator(".pv-history-popover .pv-hist-lbl");
    await expect(labels).toHaveText(["Shared", "Dedicated"]);
    await expect(page.locator(".pv-history-popover .pv-snap", { hasText: "Footer spacing" })).toContainText("Footer");
    await capture(page.locator(".pv-history-popover"), "shared-mockup-picker");
    await page.locator(".pv-history-popover .pv-snap", { hasText: "Footer spacing" }).click();
    await expect(page.locator(`${PANEL} .pv-name`)).toHaveText("footer-spacing");
    await expect(page.locator(`${PANEL} .pv-kind`)).toContainText("Only Footer");
    await expect(page.locator(`${PANEL} .pv-shared`)).toBeHidden();
    await capture(page.locator(PANEL), "shared-mockup-dedicated");
    await page.locator(`${PANEL} .pv-back`).click();
    await expect(page.locator(`${PANEL} .pv-name`)).toHaveText("portfolio");
    await expect(page.locator(`${PANEL} .pv-back`)).toBeHidden();
  });
});
