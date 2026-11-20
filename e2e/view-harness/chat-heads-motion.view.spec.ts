// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/chat-heads-drag.ts, src/views/sessions/sidebar.ts, src/views/sessions/sidebar-anim.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The motion rules of the chat heads: a status update patches only the changed parts (so a
// hovered head never bounces), the stack opens and closes with a stagger, a drag moves the
// neighbours aside live and the drop settles, and the + and Hidden buttons are small ghosts
// shown only while the stack is open.

const DESKTOP = { width: 1280, height: 800 };
const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const CHAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((30 - pid % 100) * MIN), ...over });

const SESSIONS = [
  chat("a", "Alpha", 101, { busy: true, awaiting: null, model: "claude-opus-5", effort: "high" }),
  chat("b", "Bravo", 102, { awaiting: "done" }),
  chat("c", "Charlie", 103, { awaiting: "done" }),
  chat("d", "Delta", 104, { awaiting: "done" }),
  chat("e", "Echo", 105, { awaiting: "done" }),
  chat("h", "Hidden one", 106),
];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: { a: "a", b: "b", c: "c", d: "d", e: "e", h: "f" },
  character_asset_url: CHAR_URL,
  get_project_icon: null,
  get_project_tech: null,
  context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
};

async function mount(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => { localStorage.setItem("cc_hidden_sessions", JSON.stringify(["h"])); });
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
  await settled(page);
}

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const toggle = (page: Page): Locator => page.locator("#sessions-list li[data-heads-toggle]");

/** Every head sits still: the enter stagger and any slide are over. */
async function settled(page: Page): Promise<void> {
  let prev = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await page.locator("#sessions-list > li").evaluateAll((els) =>
      els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x * 10), Math.round(r.y * 10), el.getAnimations().length]; })));
    const same = now === prev;
    prev = now;
    return same;
  }, { intervals: [150], timeout: 8000 }).toBe(true);
}

/** Swaps what the next list_instances answers and tells the view the instances changed. */
async function answerWith(page: Page, next: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => cmd === "list_instances" ? Promise.resolve(list) : orig(cmd, args);
  }, next);
  await fireEvent(page, "instances-changed", [null]);
}

test.describe("view-harness / chat heads motion", () => {
  test("a status update keeps the head's nodes and a hovered face does not bounce", async ({ page }) => {
    await mount(page);
    const box = (await head(page, "a").boundingBox())!;
    await page.mouse.move(box.x + 22, box.y + 22);
    // The nudge has landed: the face sits 4px right.
    await expect.poll(() => head(page, "a").locator(".chat-head-face").evaluate((el) => getComputedStyle(el).translate), { intervals: [50] }).toBe("4px");

    await page.evaluate(() => {
      const li = document.querySelector('#sessions-list li[data-session-id="a"]')!;
      (li.querySelector(".chat-head-face") as unknown as Record<string, boolean>).__kept = true;
      (li.querySelector(".chat-head-portrait") as unknown as Record<string, boolean>).__kept = true;
      (li.querySelector(".chat-head-img") as unknown as Record<string, boolean>).__kept = true;
      // Sample the face's nudge every frame for the rest of the test.
      const w = window as unknown as { __faceX: number[]; __stop: boolean };
      w.__faceX = []; w.__stop = false;
      const tick = (): void => {
        const f = document.querySelector('#sessions-list li[data-session-id="a"] .chat-head-face');
        if (f) w.__faceX.push(parseFloat(getComputedStyle(f).translate) || 0);
        if (!w.__stop) requestAnimationFrame(tick);
      };
      tick();
    });

    // a: working -> asking a question (the red number and the battery change at once).
    await answerWith(page, SESSIONS.map((s) => s.session_id === "a" ? { ...s, busy: false, awaiting: "question", model: "claude-sonnet-5" } : s));
    await expect(head(page, "a").locator(".chat-head-tag .ht-n.is-red")).toHaveText("1");
    await page.waitForTimeout(500);

    const kept = await page.evaluate(() => {
      const w = window as unknown as { __faceX: number[]; __stop: boolean };
      w.__stop = true;
      const li = document.querySelector('#sessions-list li[data-session-id="a"]')!;
      const flag = (sel: string) => !!(li.querySelector(sel) as unknown as Record<string, boolean> | null)?.__kept;
      return { face: flag(".chat-head-face"), portrait: flag(".chat-head-portrait"), img: flag(".chat-head-img"), xs: w.__faceX };
    });
    expect(kept.face, "the face node survives a status update").toBe(true);
    expect(kept.portrait, "the portrait node survives").toBe(true);
    expect(kept.img, "the portrait image survives, so it never reloads").toBe(true);
    expect(Math.min(...kept.xs), "the hovered face never falls back to 0 and re-eases").toBeGreaterThanOrEqual(3.99);
    expect(Math.max(...kept.xs)).toBeLessThanOrEqual(4.01);
    await expect(head(page, "a").locator(".ht-n")).toHaveCount(1);
  });

  test("a status update starts no animation on the head's pieces", async ({ page }) => {
    await mount(page);
    // b waits on a question: its red number is up, so a replaced badge would pop in again.
    await answerWith(page, SESSIONS.map((s) => s.session_id === "b" ? { ...s, awaiting: "question" } : s));
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const w = window as unknown as { __runs: string[] };
      w.__runs = [];
      document.querySelector("#sessions-list")!.addEventListener("animationstart", (e) => {
        const t = e.target as HTMLElement;
        if (!t.closest('li[data-session-id="b"]')) return;
        w.__runs.push(`${t.tagName}.${(t as unknown as SVGElement).getAttribute("class") ?? ""}:${(e as AnimationEvent).animationName}`);
      });
    });
    // b's model changes (its battery), so b is patched; the red number must not pop again.
    await answerWith(page, SESSIONS.map((s) => s.session_id === "b" ? { ...s, awaiting: "question", model: "claude-sonnet-5", effort: "low" } : s));
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __runs: string[] }).__runs)).toEqual([]);
  });

  test("hovering a head leaves every head's box where it was", async ({ page }) => {
    await mount(page);
    const boxes = () => page.locator("#sessions-list > li").evaluateAll((els) =>
      els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
    const before = await boxes();
    const b = (await head(page, "c").boundingBox())!;
    await page.mouse.move(b.x + 22, b.y + 22);
    await page.waitForTimeout(400);
    expect(await boxes()).toEqual(before);
  });

  test("closing the stack sends the heads back to the toggle, last first, and opening staggers them out", async ({ page }) => {
    await mount(page);
    const closing = await page.evaluate(() => {
      document.querySelector<HTMLElement>("#sessions-list li[data-heads-toggle]")!.click();
      return [...document.querySelectorAll<HTMLElement>("#sessions-list li.row-exiting")].map((el) => ({
        name: getComputedStyle(el).animationName,
        delay: Math.round(parseFloat(getComputedStyle(el).animationDelay) * 1000),
        up: parseFloat(el.style.getPropertyValue("--travel-y")) < 0,
      }));
    });
    // 5 heads plus the + and Hidden buttons.
    expect(closing).toHaveLength(7);
    expect(closing.every((c) => c.name === "head-out" && c.up)).toBe(true);
    const delays = closing.map((c) => c.delay);
    expect(delays, "the last head leaves first, 20ms ahead of the one before").toEqual([120, 100, 80, 60, 40, 20, 0]);
    await expect(page.locator("#sessions-list > li")).toHaveCount(1);

    const opening = await page.evaluate(() => {
      document.querySelector<HTMLElement>("#sessions-list li[data-heads-toggle]")!.click();
      return [...document.querySelectorAll<HTMLElement>("#sessions-list li.row-entering")].map((el) => ({
        name: getComputedStyle(el).animationName,
        delay: Math.round(parseFloat(getComputedStyle(el).animationDelay) * 1000),
        down: parseFloat(el.style.getPropertyValue("--travel-y")) < 0,
      }));
    });
    expect(opening).toHaveLength(7);
    expect(opening.every((c) => c.name === "head-in" && c.down)).toBe(true);
    expect(opening.map((c) => c.delay), "35ms a head, from the toggle outward").toEqual([0, 35, 70, 105, 140, 175, 210]);
    await settled(page);
    await expect(page.locator("#sessions-list li.row-entering")).toHaveCount(0);
  });

  test("the + and Hidden buttons are small dashed ghosts under the stack, only while it is open", async ({ page }) => {
    await mount(page);
    const plus = page.locator("#sessionsFab");
    const hidden = page.locator("#sessions-list li[data-heads-hidden]");
    for (const ghost of [plus, hidden]) {
      const b = (await ghost.boundingBox())!;
      expect([Math.round(b.width), Math.round(b.height)]).toEqual([26, 26]);
      await expect(ghost.locator(".chat-head-face")).toHaveCSS("border-top-style", "dashed");
      await expect(ghost).toHaveCSS("opacity", "0.55");
    }
    const last = (await head(page, "e").boundingBox())!;
    // Hidden first, then +, both below the last head.
    expect((await hidden.boundingBox())!.y).toBeGreaterThan(last.y + last.height - 1);
    expect((await plus.boundingBox())!.y).toBeGreaterThan((await hidden.boundingBox())!.y);
    // Centred under the 44px column.
    expect(Math.round((await plus.boundingBox())!.x + 13)).toBe(Math.round(last.x + 22));

    const box = (await plus.boundingBox())!;
    await page.mouse.move(box.x + 13, box.y + 13);
    await expect(plus).toHaveCSS("opacity", "1");
    await page.mouse.move(700, 500);
    await expect(plus).toHaveCSS("opacity", "0.55");

    await toggle(page).click();
    await expect(page.locator("#sessionsFab")).toHaveCount(0);
    await expect(hidden).toHaveCount(0);
    await toggle(page).click();
    await expect(page.locator("#sessionsFab")).toBeVisible();
  });

  /** Drags head `from` to the middle of head `to`, stopping before the release. */
  async function dragTo(page: Page, from: string, to: string): Promise<void> {
    const a = (await head(page, from).boundingBox())!;
    const b = (await head(page, to).boundingBox())!;
    await page.mouse.move(a.x + 22, a.y + 22);
    await page.mouse.down();
    await page.mouse.move(a.x + 22, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x + 22, b.y + 30, { steps: 6 });
  }
  const transformOf = (page: Page, id: string) => head(page, id).evaluate((el) => getComputedStyle(el).transform);
  const orderOf = (page: Page) => page.locator("#sessions-list li[data-session-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.sessionId));

  test("dragging lifts the head and slides the neighbours aside live, with no insertion line", async ({ page }) => {
    await mount(page);
    expect(await transformOf(page, "b")).toBe("none");
    await dragTo(page, "a", "d");
    // b and c moved up a slot to make room; e, past the drop, stayed.
    await expect.poll(async () => (await transformOf(page, "b")) !== "none" && (await transformOf(page, "c")) !== "none").toBe(true);
    await expect.poll(() => head(page, "b").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42), { message: "b slid up one slot" }).toBeLessThan(-40);
    expect(await transformOf(page, "e")).toBe("none");
    const lifted = await head(page, "a").evaluate((el) => ({ scale: getComputedStyle(el).scale, shadow: getComputedStyle(el).boxShadow, cls: el.className }));
    expect(lifted.cls).toContain("is-dragging");
    expect(lifted.scale).toBe("1.05");
    expect(lifted.shadow).toContain("rgba(0, 0, 0, 0.55)");
    await expect(page.locator(".is-drop-before")).toHaveCount(0);
    // The heads slid under a resting pointer: no head's hover card opens during the drag.
    await page.waitForTimeout(700);
    expect(await page.locator(".cc-row-card").evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== "none").length)).toBe(0);
    await page.mouse.up();
  });

  test("with reduced motion the neighbours jump aside and the drop lands without a slide", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page);
    await dragTo(page, "a", "d");
    const during = await head(page, "b").evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(during.split(",").every((d) => parseFloat(d) < 0.25 || d.trim() === "0s")).toBe(true);
    expect(await head(page, "b").evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain("transform");
    await page.mouse.up();
    await expect(page.locator("#sessions-list li.is-settling")).toHaveCount(0, { timeout: 4000 });
  });

  test("a drop settles into its slot with a transition, then every transform is cleared", async ({ page }) => {
    await mount(page);
    const before = await orderOf(page);
    await dragTo(page, "a", "d");
    await page.mouse.up();
    const settling = await head(page, "a").evaluate((el) => ({ cls: el.className, transition: getComputedStyle(el).transitionProperty }));
    expect(settling.cls).toContain("is-settling");
    expect(settling.transition).toContain("transform");
    await expect.poll(() => invokeCalls(page).then((c) => c.some((x) => x.cmd === "save_settings" && JSON.stringify(x.args).includes("chatHeadsOrder")))).toBe(true);
    await expect(page.locator("#sessions-list li.is-settling")).toHaveCount(0);
    await expect(page.locator("#sessions-list")).not.toHaveClass(/is-reordering/);
    for (const id of before.filter((x): x is string => !!x)) expect(await transformOf(page, id)).toBe("none");
    expect(await orderOf(page)).toEqual(["b", "c", "d", "a", "e"].filter((x) => before.includes(x)));
  });

  test("a save that never answers does not freeze the stack: the drop lands and a status update still draws", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
      const orig = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => cmd === "save_settings" ? new Promise(() => {}) : orig(cmd, args);
    });
    await dragTo(page, "a", "d");
    await page.mouse.up();
    await expect(page.locator("#sessions-list li.is-settling")).toHaveCount(0, { timeout: 4000 });
    await expect(page.locator("#sessions-list")).not.toHaveClass(/is-reordering/);
    await answerWith(page, SESSIONS.map((s) => s.session_id === "c" ? { ...s, awaiting: "question" } : s));
    await expect(head(page, "c").locator(".chat-head-tag .ht-n.is-red")).toHaveText("1");
  });

  test("a second pointer pressed mid-drag does not replace the drag", async ({ page }) => {
    await mount(page);
    await dragTo(page, "a", "d");
    const e = (await head(page, "e").boundingBox())!;
    await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x!, y!)!;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 77, pointerType: "touch", clientX: x, clientY: y, button: 0 }));
    }, [e.x + 22, e.y + 22]);
    await expect(head(page, "a")).toHaveClass(/is-dragging/);
    await page.mouse.up();
    await expect(page.locator("#sessions-list li.is-settling")).toHaveCount(0, { timeout: 4000 });
    await expect(page.locator("#sessions-list")).not.toHaveClass(/is-reordering/);
  });

  test("a drag that lost its pointer capture never locks the next press out", async ({ page }) => {
    await mount(page);
    await dragTo(page, "a", "d");
    await head(page, "a").evaluate((el) => el.releasePointerCapture(1));
    const e = (await head(page, "e").boundingBox())!;
    await page.evaluate(([x, y]) => {
      document.elementFromPoint(x!, y!)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 78, pointerType: "mouse", clientX: x, clientY: y, button: 0 }));
    }, [e.x + 22, e.y + 22]);
    await expect(head(page, "a")).not.toHaveClass(/is-dragging/);
    await expect(page.locator("#sessions-list")).not.toHaveClass(/is-reordering/);
    // The mouse is still down on the first head, so it keeps its pressed scale; none is displaced.
    for (const id of ["a", "b", "c", "d", "e"]) {
      const m = await head(page, id).evaluate((el) => { const d = new DOMMatrix(getComputedStyle(el).transform); return [d.m41, d.m42]; });
      expect(m, id).toEqual([0, 0]);
    }
    await page.mouse.up();
  });

  test("a drop the backend refuses slides back to the old slot", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
      const orig = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => cmd === "save_settings" ? Promise.reject(new Error("the phone may not write settings")) : orig(cmd, args);
    });
    const before = await orderOf(page);
    const home = (await head(page, "a").boundingBox())!;
    await dragTo(page, "a", "d");
    await page.mouse.up();
    // Sliding back, not snapped: shortly after the release the head is still on its way.
    await page.waitForTimeout(60);
    const mid = (await head(page, "a").boundingBox())!;
    expect(mid.y).toBeGreaterThan(home.y + 10);
    await expect(page.locator("#sessions-list li.is-settling")).toHaveCount(0);
    expect(await orderOf(page)).toEqual(before);
    const after = (await head(page, "a").boundingBox())!;
    expect(Math.round(after.y)).toBe(Math.round(home.y));
  });
});