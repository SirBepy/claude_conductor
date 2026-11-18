// asserts: src/styles/base.css
// asserts: src/shared/toast.css
// asserts: android/src/style.css
// asserts: android/src/app.js
// asserts: src/missed-panel.css
// asserts: src/shared/chat/chat-overlays.css
// asserts: src/views/sessions/permission-modal-shell.css
// asserts: src/views/sessions/permission-modal-preview-fullscreen.css
import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe, 2026-11-16 (Galaxy Z Flip4, 3-button nav): the pairing screen's Scan
// button sat under the nav bar. MainActivity.kt writes the bar sizes onto <html>
// as --safe-top / --safe-bottom because the WebView's env(safe-area-inset-*)
// can stay 0; these specs set the variables the way Kotlin does (env() is 0 in
// Chromium here) and check that nothing bottom-anchored stays under the bar.

const PHONE = { width: 393, height: 852 };
const NAV = 96;
const STATUS = 40;

async function setInsets(page: Page): Promise<void> {
  await page.evaluate(([top, bottom]) => {
    document.documentElement.style.setProperty("--safe-top", `${top}px`);
    document.documentElement.style.setProperty("--safe-bottom", `${bottom}px`);
  }, [STATUS, NAV]);
}

test.describe("view-harness / safe-area insets on the phone", () => {
  test("the chat composer and a toast clear the nav bar", async ({ page }) => {
    const session = sessionInstance();
    await page.setViewportSize(PHONE);
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session],
        get_active_sessions: [session],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    await page.locator("#sessions-list li[data-session-id='s1']").click();
    await page.locator("#session-pane .session-composer").waitFor();
    await waitForPaneSettled(page);
    await setInsets(page);

    // In-flow chrome is lifted by body's own padding.
    const body = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) };
    });
    expect(body.top).toBe(STATUS);
    expect(body.bottom).toBe(NAV);

    const composer = (await page.locator("#session-pane .session-composer").boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(PHONE.height - NAV);

    // A toast is position:fixed, so it escapes that padding and adds the bar itself.
    await page.evaluate(async () => {
      const mod = await import("/shared/toast.ts");
      mod.showToast("Safe area check");
    });
    const toast = page.locator("#toastStack .toast");
    await expect(toast).toBeVisible();
    await page.waitForTimeout(250); // the toast slides up 8px as it fades in
    const box = (await toast.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height - NAV);
  });

  test("edge-anchored fixed surfaces clear both bars", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page, { view: "sessions", invoke: { ...SESSIONS_BASE_INVOKE } });
    await setInsets(page);
    // Synthetic nodes carry the real classes: the rules under test are plain CSS.
    const r = await page.evaluate(() => {
      const mk = (html: string): HTMLElement => {
        const d = document.createElement("div");
        d.innerHTML = html;
        document.body.appendChild(d);
        return d;
      };
      mk('<div class="missed-panel-host"><div id="mp" style="width:50px;height:20px"></div></div>');
      mk('<div class="lightbox-overlay"><button class="lightbox-close" id="lc"></button></div>');
      mk('<div class="auq-fs"><div id="fs" style="flex:1"></div></div>');
      const b = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { mp: b("mp").bottom, lc: b("lc").top, fs: b("fs").bottom, fsTop: b("fs").top };
    });
    expect(r.mp).toBeLessThanOrEqual(PHONE.height - NAV);
    expect(r.lc).toBeGreaterThanOrEqual(STATUS);
    expect(r.fs).toBeLessThanOrEqual(PHONE.height - NAV);
    expect(r.fsTop).toBeGreaterThanOrEqual(STATUS);
  });

  test("with no insets nothing moves", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountView(page, { view: "sessions", invoke: { ...SESSIONS_BASE_INVOKE } });
    const bottom = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    expect(bottom).toBe(0);
  });
});

// The bundled pairing shell (android/src): plain page, the Tauri bridge stubbed.
const SHELL_URL = pathToFileURL(path.resolve(process.cwd(), "android/src/index.html")).toString();
const ENDPOINT = "a".repeat(64);

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.addInitScript((endpoint) => {
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string): Promise<unknown> => {
        if (cmd === "plugin:barcode-scanner|check_permissions") return Promise.resolve({ camera: "granted" });
        if (cmd === "plugin:barcode-scanner|scan") {
          return Promise.resolve({ content: `conductor://pair?iroh=${endpoint}&pair=ABC123` });
        }
        if (cmd === "start_iroh_tunnel") return Promise.resolve(5555);
        if (cmd === "probe_iroh_tunnel") {
          return new Promise((_, reject) => { w.__failProbe = () => reject(new Error("no route")); });
        }
        return Promise.resolve(null);
      },
    };
  }, ENDPOINT);
  await page.goto(SHELL_URL);
}

test.describe("view-harness / pairing shell", () => {
  test("the Scan button clears the nav bar", async ({ page }) => {
    await openShell(page);
    await page.evaluate(([top, bottom]) => {
      document.documentElement.style.setProperty("--safe-top", `${top}px`);
      document.documentElement.style.setProperty("--safe-bottom", `${bottom}px`);
    }, [STATUS, NAV]);
    const box = (await page.locator("#scan-qr-btn").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height - NAV);
  });

  // Joe, 2026-11-16: the scanned code appeared typed into the field before the
  // login. Now: loading screen over the pairing screen, field untouched, and a
  // failed probe fades back with the reason.
  test("a scan fades to a loading screen without filling the field, a failed probe returns with the error", async ({ page }) => {
    await openShell(page);
    await page.locator("#scan-qr-btn").click();

    const loading = page.locator("#connecting-screen");
    await expect(loading).toBeVisible();
    await expect(page.locator("#connecting-status")).toHaveText("Pairing with your PC…");
    // Held while the probe is pending, once the fade has finished.
    await expect.poll(() => loading.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect(page.locator("#server-url")).toHaveValue("");
    await expect(page.locator("#connecting-cancel-btn")).toBeHidden();

    await page.evaluate(() => (window as unknown as { __failProbe: () => void }).__failProbe());
    await expect(page.locator("#idle-error")).toContainText("Can’t reach your PC");
    await expect(loading).toBeHidden();
    await expect(page.locator("#server-url")).toHaveValue("");
  });
});
