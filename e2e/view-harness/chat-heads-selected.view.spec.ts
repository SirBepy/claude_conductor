// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/chat-heads-keys.ts, src/views/sessions/chat-heads-model.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Joe 2026-11-17: "its not too obvious which chat is selected". The open head steps out of the
// column and wears a ring, hover nudges instead of growing, the Ctrl numbers are keycaps beside
// the heads, and a Ctrl tap toggles the stack.
// None of it may move the layout: every head keeps its slot.

const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const chat = (id: string, name: string, n: number) =>
  sessionInstance({ session_id: id, name, pid: 100 + n, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((20 - n) * MIN) });

const SESSIONS = [chat("a", "First chat", 1), chat("b", "Second chat", 2), chat("c", "Third chat", 3)];
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: {},
  get_project_icon: null,
  get_project_tech: null,
};

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);

async function mount(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await head(page, "a").waitFor();
}

/** Layout slots (unaffected by `translate`/`transform`): the proof nothing reflowed. */
const slots = (page: Page): Promise<number[][]> =>
  page.locator("#sessions-list > li").evaluateAll((els) => els.map((e) => [(e as HTMLElement).offsetLeft, (e as HTMLElement).offsetTop, (e as HTMLElement).offsetWidth, (e as HTMLElement).offsetHeight]));

test.describe("view-harness / chat heads: the selected chat", () => {
  test("the open head steps out, wears a ring, and declares the transitions that animate both", async ({ page }) => {
    await mount(page);
    const before = await slots(page);
    await head(page, "b").click();
    await expect(head(page, "b")).toHaveClass(/active/);
    const css = await head(page, "b").evaluate((e) => {
      const cs = getComputedStyle(e);
      return { translate: cs.translate, shadow: cs.boxShadow, transition: cs.transitionProperty, radius: cs.borderRadius };
    });
    await expect.poll(() => head(page, "b").evaluate((e) => getComputedStyle(e).translate)).toBe("10px");
    expect(css.shadow).not.toBe("none");
    expect(css.transition).toContain("translate");
    expect(css.transition).toContain("box-shadow");
    // The ring follows the circle, not the li's square box.
    expect(css.radius).toBe("50%");
    // A plain head neither steps nor rings.
    expect(await head(page, "a").evaluate((e) => getComputedStyle(e).translate)).toMatch(/^(0px|none)/);
    // Selecting moved nothing in the layout.
    expect(await slots(page)).toEqual(before);
    await capture(page, "chat-heads-selected");
  });

  test("hover nudges a head's face 4px instead of growing it, and moves no slot", async ({ page }) => {
    await mount(page);
    const before = await slots(page);
    const face = head(page, "c").locator(".chat-head-face");
    expect(await face.evaluate((e) => getComputedStyle(e).transitionProperty)).toContain("translate");
    await head(page, "c").hover();
    await expect.poll(() => face.evaluate((e) => getComputedStyle(e).translate)).toBe("4px");
    expect(await face.evaluate((e) => getComputedStyle(e).transform)).toBe("none");
    expect(await slots(page)).toEqual(before);
    // The li the pointer is over stays put, so a pointer on its left edge never loses the hover.
    expect(await head(page, "c").evaluate((e) => getComputedStyle(e).translate)).toMatch(/^(0px|none)/);
  });

  test("Ctrl+Down steps the highlighted head out too, in the primary colour", async ({ page }) => {
    await mount(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("ArrowDown");
    const lit = page.locator("#sessions-list li.is-highlight");
    await expect(lit).toHaveCount(1);
    await expect.poll(() => lit.evaluate((e) => getComputedStyle(e).translate)).toBe("10px");
    expect(await lit.evaluate((e) => getComputedStyle(e).boxShadow)).toContain("rgb(");
    await page.keyboard.up("Control");
  });

  test("Ctrl numbers are keycaps beside the heads that ease in, 25ms apart", async ({ page }) => {
    await mount(page);
    await page.keyboard.down("Control");
    await expect(page.locator("#sessions-list")).toHaveClass(/kbd-hint-active/, { timeout: 5000 });
    const caps = await page.locator("#sessions-list li[data-kbd-hint]").evaluateAll((els) =>
      els.map((e) => {
        const cs = getComputedStyle(e, "::after");
        return { content: cs.content, delay: cs.transitionDelay.split(",")[0]!.trim(), prop: cs.transitionProperty, left: parseFloat(cs.left), width: parseFloat(cs.width) };
      }));
    expect(caps.map((c) => c.content)).toEqual(['"1"', '"2"', '"3"']);
    expect(caps.map((c) => c.delay)).toEqual(["0s", "0.025s", "0.05s"]);
    expect(caps[0]!.prop).toContain("opacity");
    // Beside the head (past its 44px), never covering its face.
    expect(caps[0]!.left).toBeGreaterThanOrEqual(44);
    await expect.poll(() => head(page, "a").evaluate((e) => getComputedStyle(e, "::after").opacity)).toBe("1");
    await capture(page, "chat-heads-keycaps");
    await page.keyboard.up("Control");
    await expect.poll(() => head(page, "a").evaluate((e) => getComputedStyle(e, "::after").opacity)).toBe("0");
  });

  test("a Ctrl tap toggles the stack, a Ctrl+key does not", async ({ page }) => {
    await mount(page);
    await expect(head(page, "a")).toBeVisible();
    await page.keyboard.press("Control");
    await expect(head(page, "a")).toHaveCount(0);
    await page.keyboard.press("Control");
    await expect(head(page, "a")).toBeVisible();
    // Ctrl+A is a shortcut, not a tap.
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await expect(head(page, "a")).toBeVisible();
  });
});
