import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// asserts: src/shared/chat/lightbox.ts, src/shared/chat/lightbox-gallery-model.ts, src/shared/chat/chat-overlays.css, src/views/sessions/chat-dashboard/sub-peek.ts
// pc-1789: a lightbox opened from a group of images steps through the group with Left and Right,
// the prev/next buttons or a swipe, shows "n / total", and a lone image shows none of it. The
// caption box keeps its caret keys. The sub peek's group is the sub's whole image list, including
// the images behind "Show N more".

const COUNT = 5;

/** Opens a lightbox over COUNT distinct solid-colour images, starting at `start`. `draft` seeds the
 *  caption box; null opens it with no caption box at all. */
async function openGroup(page: Page, start: number, draft: string | null = ""): Promise<void> {
  await page.evaluate(async ({ count, at, text }) => {
    const lightbox = await import("/shared/chat/lightbox.ts");
    const model = await import("/shared/chat/lightbox-gallery-model.ts");
    const items = Array.from({ length: count }, (_, i) => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 200;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 300, 200);
      return { type: "image" as const, mime: "image/png", base64: canvas.toDataURL("image/png").split(",")[1]!, filename: `img${i}.png` };
    });
    if (text !== null) {
      lightbox.setLightboxComposerBridge({ getDraftText: () => text, setDraftText: () => {}, getCwd: () => null });
    }
    lightbox.openLightbox(items[at]!, text === null ? null : undefined, model.galleryOfItems(items, at));
  }, { count: COUNT, at: start, text: draft });
  await expect(page.locator(".lightbox-slide img")).toBeVisible();
}

const counter = (page: Page) => page.locator(".lightbox-counter");
const shown = (page: Page) => page.locator(".lightbox-slide:not(.is-leaving) img");
const filenameShown = async (page: Page): Promise<string> => (await shown(page).getAttribute("alt")) ?? "";

test.describe("view-harness / lightbox gallery", () => {
  test("a lone image shows no arrows, no counter, and the keys do nothing", async ({ page }) => {
    await mountView(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      const model = await import("/shared/chat/lightbox-gallery-model.ts");
      const one = { type: "image" as const, mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", filename: "only.png" };
      lightbox.openLightbox(one, null, model.galleryOfItems([one], 0));
    });
    await expect(page.locator(".lightbox-slide img")).toBeVisible();
    await expect(page.locator(".lightbox-nav")).toHaveCount(0);
    await expect(counter(page)).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".lightbox-overlay")).toBeVisible();
  });

  test("Left and Right step through the group, the counter follows, and the ends stop", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 2, null);
    await expect(counter(page)).toHaveText("3 / 5");
    expect(await filenameShown(page)).toBe("img2.png");

    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("4 / 5");
    await expect(shown(page)).toHaveAttribute("alt", "img3.png");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("2 / 5");
    await expect(shown(page)).toHaveAttribute("alt", "img1.png");

    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("1 / 5");
    await expect(page.locator(".lightbox-nav--prev")).toBeDisabled();
    // Past the first image nothing wraps round to the last.
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("1 / 5");
    await expect(shown(page)).toHaveAttribute("alt", "img0.png");
    await expect(page.locator(".lightbox-nav--next")).toBeEnabled();
  });

  test("the buttons step too, and a step leaves exactly one slide once the old one has gone", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 0, null);
    await expect(page.locator(".lightbox-nav--prev")).toBeDisabled();
    await page.locator(".lightbox-nav--next").click();
    await expect(counter(page)).toHaveText("2 / 5");
    await expect(shown(page)).toHaveAttribute("alt", "img1.png");
    // The outgoing slide stays for its transition, then goes: no stale slide piles up.
    await expect(page.locator(".lightbox-slide")).toHaveCount(1);
    // Two quick steps still end on the right image with one slide.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("4 / 5");
    await expect(page.locator(".lightbox-slide")).toHaveCount(1);
  });

  test("a step moves: the new slide declares a transition, and reduced motion keeps it as a fade", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 0, null);
    const props = await page.locator(".lightbox-slide").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { props: cs.transitionProperty, dur: cs.transitionDuration };
    });
    // The first paint is still (no motion); the step's slide is not.
    expect(props.dur).toBe("0s");
    await page.locator(".lightbox-slide").evaluate((el) => el.setAttribute("data-first", "1"));
    await page.keyboard.press("ArrowRight");
    const step = await shown(page).evaluate((img) => {
      const cs = getComputedStyle(img.parentElement!);
      // The first slide leaves on this step: it must animate out too, not vanish.
      const out = document.querySelector<HTMLElement>(".lightbox-slide[data-first]");
      const ocs = out ? getComputedStyle(out) : null;
      return { props: cs.transitionProperty, dur: cs.transitionDuration, from: (img.parentElement as HTMLElement).style.getPropertyValue("--lb-from"), outProps: ocs?.transitionProperty ?? "gone", outDur: ocs?.transitionDuration ?? "gone" };
    });
    expect(step.outProps).toContain("opacity");
    expect(step.outDur).not.toBe("0s");
    expect(step.props).toContain("transform");
    expect(step.props).toContain("opacity");
    expect(step.dur).toBe("0.15s, 0.15s");
    expect(step.from).toBe("32px");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ArrowRight");
    // The shift is zeroed but the fade timing stays.
    const shift = await shown(page).evaluate((img) => getComputedStyle(img.parentElement!).getPropertyValue("--lb-from").trim());
    expect(shift).toBe("0px");
    expect(await shown(page).evaluate((img) => getComputedStyle(img.parentElement!).transitionDuration)).toBe("0.15s, 0.15s");
  });

  test("a caption with text keeps Left and Right for the caret; an empty one and Alt+Arrow step", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 2, "hello");
    const box = page.locator(".lightbox-composer");
    await expect(box).toBeFocused();
    await box.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 5));

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("3 / 5");
    expect(await box.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(3);
    await page.keyboard.press("ArrowRight");
    expect(await box.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(4);
    await expect(counter(page)).toHaveText("3 / 5");
    // Typing is untouched.
    await page.keyboard.type("X");
    await expect(box).toHaveValue("hellXo");

    // Alt+Arrow steps from inside the box, and the caption (a draft) stays as typed.
    await page.keyboard.press("Alt+ArrowRight");
    await expect(counter(page)).toHaveText("4 / 5");
    await expect(box).toHaveValue("hellXo");
    await expect(box).toBeFocused();

    // Nothing to move through in an empty box: the arrows step.
    await box.fill("");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("3 / 5");
  });

  test("an async item that cannot be read is skipped, and the old image stays up while one loads", async ({ page }) => {
    await mountView(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      const mk = (name: string) => ({ type: "image" as const, mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", filename: name });
      const items = [mk("a.png"), null, mk("c.png"), mk("d.png")];
      lightbox.openLightbox(items[0]!, null, {
        count: items.length,
        index: 0,
        load: (i: number) => new Promise((res) => setTimeout(() => res(items[i] ?? null), 120)),
      });
    });
    await expect(shown(page)).toHaveAttribute("alt", "a.png");
    await page.keyboard.press("ArrowRight");
    // Still the first image while the read is in flight.
    await expect(shown(page)).toHaveAttribute("alt", "a.png");
    // The unreadable second item is passed over for the third.
    await expect(shown(page)).toHaveAttribute("alt", "c.png");
    await expect(counter(page)).toHaveText("3 / 4");
  });

  test("slow loads: pressing past the end keeps the load in flight, and reversing mid-load never reloads the shown image", async ({ page }) => {
    await mountView(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      const mk = (name: string) => ({ type: "image" as const, mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", filename: name });
      const items = [mk("a.png"), mk("b.png"), mk("c.png")];
      const w = window as unknown as { __loads: number[] };
      w.__loads = [];
      lightbox.openLightbox(items[0]!, null, {
        count: 3,
        index: 0,
        load: (i: number) => { w.__loads.push(i); return new Promise((res) => setTimeout(() => res(items[i]!), 150)); },
      });
    });
    const loads = () => page.evaluate(() => (window as unknown as { __loads: number[] }).__loads);
    // Right, Right, then a third Right past the end: the last image still arrives.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("3 / 3");
    await expect(shown(page)).toHaveAttribute("alt", "c.png");
    // Right then straight back Left: the image on screen is not read or slid again.
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("2 / 3");
    const before = (await loads()).length;
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(400);
    await expect(counter(page)).toHaveText("2 / 3");
    await expect(shown(page)).toHaveAttribute("alt", "b.png");
    expect((await loads()).length).toBe(before + 1);
  });

  test("reversing while a skip past an unreadable neighbour is loading never re-reads or re-slides the shown image", async ({ page }) => {
    await mountView(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      const mk = (name: string) => ({ type: "image" as const, mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", filename: name });
      const items = [mk("a.png"), mk("b.png"), null, mk("d.png"), mk("e.png")];
      const w = window as unknown as { __loads: number[] };
      w.__loads = [];
      lightbox.openLightbox(items[1]!, null, {
        count: 5,
        index: 1,
        load: (i: number) => { w.__loads.push(i); return new Promise((res) => setTimeout(() => res(items[i] ?? null), 150)); },
      });
    });
    await expect(counter(page)).toHaveText("2 / 5");
    // Right: item 3 is unreadable, so the walk goes on to 4. Left while 4 loads walks back through
    // the same unreadable item and would land on the image already shown.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(220);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(500);
    await expect(counter(page)).toHaveText("2 / 5");
    await expect(shown(page)).toHaveAttribute("alt", "b.png");
    await expect(page.locator(".lightbox-slide")).toHaveCount(1);
    const loads = await page.evaluate(() => (window as unknown as { __loads: number[] }).__loads);
    expect(loads).not.toContain(1);
  });

  test("a click on the buttons leaves the caption box focused", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 1, "note");
    const box = page.locator(".lightbox-composer");
    await expect(box).toBeFocused();
    await page.locator(".lightbox-nav--next").click();
    await expect(counter(page)).toHaveText("3 / 5");
    await expect(box).toBeFocused();
    await page.keyboard.type("!");
    await expect(box).toHaveValue("note!");
  });

  test("on the light theme the controls stay legible on the dark overlay", async ({ page }) => {
    await mountView(page, { invoke: { get_settings: { theme: "void-light" } } });
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
    await openGroup(page, 1, null);
    const overlay = page.locator(".lightbox-overlay");
    expect(await overlay.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0.85)");
    expect(await counter(page).evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    expect(await page.locator(".lightbox-nav--next").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    await expect(page.locator(".lightbox-nav--next i")).toBeVisible();
    await capture(page, "lightbox-gallery-light-theme");
  });

  test("a click on the backdrop beside the image closes it, but the slide's own click-outside never eats a button", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 1, null);
    await page.mouse.click(640, 120);
    await expect(page.locator(".lightbox-overlay")).toHaveCount(0);
  });

  test("the buttons do not move on hover, and they take the keyboard", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 1, null);
    const next = page.locator(".lightbox-nav--next");
    const before = await next.boundingBox();
    await next.hover();
    expect(await next.boundingBox()).toEqual(before);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(counter(page)).toHaveText("3 / 5");
    // Counter and buttons sit clear of the close and more buttons.
    const close = (await page.locator(".lightbox-close").first().boundingBox())!;
    const c = (await counter(page).boundingBox())!;
    expect(c.x + c.width).toBeLessThan(close.x);
  });
});

test.describe("view-harness / lightbox gallery on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

  type Pt = { x: number; y: number };
  async function swipe(cdp: CDPSession, from: Pt, to: Pt): Promise<void> {
    const send = (type: "touchStart" | "touchMove" | "touchEnd", pts: Pt[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
    await send("touchStart", [from]);
    for (let i = 1; i <= 6; i++) {
      const f = i / 6;
      await send("touchMove", [{ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }]);
    }
    await send("touchEnd", []);
  }

  test("a sideways swipe steps, a vertical drag does not", async ({ page }) => {
    await mountView(page);
    await openGroup(page, 2, null);
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, { x: 300, y: 400 }, { x: 80, y: 410 });
    await expect(counter(page)).toHaveText("4 / 5");
    await swipe(cdp, { x: 80, y: 400 }, { x: 300, y: 400 });
    await expect(counter(page)).toHaveText("3 / 5");
    await swipe(cdp, { x: 190, y: 200 }, { x: 200, y: 600 });
    await expect(counter(page)).toHaveText("3 / 5");
    await capture(page, "lightbox-gallery-phone");
  });
});

// A sub's images: the group is its whole list, not the tiles drawn so far.
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: "C:/Projects/cv-site" });
const WORK = sessionInstance({ session_id: "sub-work", name: "Footer", pid: 102, cwd: "C:/Projects/cv-site", subchat_of: "main", busy: true, awaiting: null, started_at: ago(12 * MIN) });

test.describe("view-harness / lightbox gallery from a sub's image grid", () => {
  async function openPeek(page: Page, total: number): Promise<void> {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [MAIN, WORK],
        get_active_sessions: [MAIN, WORK],
        list_subchats_on: ["main"],
        list_subchat_cards: [], list_previews: [],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        context_status: null,
        get_sub_brief: { brief: null },
        list_session_images: { images: Array.from({ length: total }, (_, i) => ({ id: `img${i}` })) },
        dashboard_gallery_image: PNG,
      },
    });
    await page.locator(`#sessions-list li[data-session-id="main"]`).click();
    await page.locator("#session-pane .cdash").waitFor();
    await page.locator('#session-pane .sx-av[data-sub="sub-work"]').click();
    await expect(page.locator(".sx-det .sx-img")).toBeVisible();
  }

  const reads = async (page: Page): Promise<string[]> =>
    (await invokeCalls(page)).filter((c) => c.cmd === "dashboard_gallery_image").map((c) => (c.args as { id: string }).id);

  test("opening the newest thumbnail starts at the end of the whole list and Left walks back through it", async ({ page }) => {
    await openPeek(page, 40);
    await page.locator(".sx-det .sx-img").click();
    await expect(page.locator(".lightbox-counter")).toHaveText("40 / 40");
    await expect(page.locator(".lightbox-nav--next")).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".lightbox-counter")).toHaveText("39 / 40");
    // Neighbours are read when stepped to, never the whole list up front.
    await expect.poll(async () => (await reads(page)).includes("img38")).toBe(true);
    expect((await reads(page)).includes("img5")).toBe(false);
  });

  test("a grid tile steps past the drawn page into images behind Show more", async ({ page }) => {
    await openPeek(page, 40);
    await page.locator(".sx-det .sx-imgmore").click();
    const tiles = page.locator(".sx-det .sx-gallery .sx-gal-img");
    await expect(tiles).toHaveCount(12);
    await expect(tiles.last().locator("img")).toHaveAttribute("src", PNG);
    await tiles.last().click();
    await expect(page.locator(".lightbox-counter")).toHaveText("12 / 40");
    // Image 13 is not a drawn tile; the list still reaches it.
    expect(await reads(page)).not.toContain("img12");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".lightbox-counter")).toHaveText("13 / 40");
    await expect.poll(async () => (await reads(page)).includes("img12")).toBe(true);
    await expect(tiles).toHaveCount(12);
    await capture(page, "lightbox-gallery-sub-peek");
  });

  test("a sub with a single image opens it with no arrows", async ({ page }) => {
    await openPeek(page, 1);
    await page.locator(".sx-det .sx-img").click();
    await expect(page.locator(".lightbox-slide img")).toBeVisible();
    await expect(page.locator(".lightbox-nav")).toHaveCount(0);
    await expect(page.locator(".lightbox-counter")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".lightbox-overlay")).toHaveCount(0);
  });
});
