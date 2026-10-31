import { test, expect, type Page, type Frame } from "@playwright/test";
import { PAGE_ZOOM_SCRIPT } from "../../src/views/sessions/preview-page-zoom";

// asserts: src/views/sessions/preview-page-zoom.ts

// preview-page-zoom.ts anchors with `(scroll + c) * ratio - c`, which only holds
// if Chromium reports clientX/clientY in unzoomed viewport pixels and scroll
// offsets in zoomed layout pixels while a root CSS `zoom` is set. Measured with
// hit testing, which needs no convention: the strip under a fixed viewport
// point before a zoom must still be under it afterwards, within one content
// pixel (the device-pixel rounding of the scroll offset).

const SIZE = 6000;
// Absolutely positioned 1px strips each sit at their own offset, so layout
// rounding never accumulates the way stacked rows' heights would.
const strips = (axis: "y" | "x") => Array.from({ length: SIZE }, (_, i) =>
  `<div class="${axis}" id="s${i}" style="${axis === "y" ? "top" : "left"}:${i}px"></div>`).join("");
const pageOf = (axis: "y" | "x") => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
html,body{margin:0;padding:0}body{position:relative;width:${SIZE}px;height:${SIZE}px}
.y{position:absolute;left:0;width:${SIZE}px;height:1px}.x{position:absolute;top:0;height:${SIZE}px;width:1px}
</style></head><body>${strips(axis)}${PAGE_ZOOM_SCRIPT}</body></html>`;

const stripUnder = (frame: Frame, x: number, y: number) =>
  frame.evaluate(([px, py]) => {
    const id = document.elementFromPoint(px!, py!)?.id ?? "";
    return { strip: Number(id.slice(1)), zoom: Number(document.documentElement.style.zoom || "1") };
  }, [x, y] as const);

async function mountIn(page: Page, html: string, inFrame: boolean): Promise<{ frame: Frame; origin: { x: number; y: number } }> {
  if (!inFrame) {
    await page.setContent(html);
    return { frame: page.mainFrame(), origin: { x: 0, y: 0 } };
  }
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  await page.setContent(`<body style="margin:0"><iframe id="f" style="width:600px;height:500px;border:0" srcdoc="${srcdoc}"></iframe></body>`);
  await page.frameLocator("#f").locator("body").waitFor();
  return { frame: page.frames().find((f) => f !== page.mainFrame())!, origin: (await page.locator("#f").boundingBox())! };
}

const scrollTo = (frame: Frame, axis: "y" | "x", to: number) =>
  frame.evaluate(([a, v]) => {
    const el = document.scrollingElement!;
    if (a === "y") el.scrollTop = v as number;
    else el.scrollLeft = v as number;
  }, [axis, to] as const);

test.describe("view-harness / preview page zoom anchor (desktop)", () => {
  test.use({ viewport: { width: 800, height: 600 } });

  for (const inFrame of [false, true]) {
    for (const axis of ["y", "x"] as const) {
      test(`Ctrl+wheel keeps the content under the cursor still along ${axis}${inFrame ? " inside an iframe" : ""}`, async ({ page }) => {
        // Distinct scroll depths and cursor spots, so a wrong origin term shows up as drift that grows with either.
        for (const [scroll, cx, cy] of [[1000, 300, 100], [3000, 450, 400]] as const) {
          // A fresh page per spot: the runtime's own zoom state cannot be reset from outside.
          const { frame, origin } = await mountIn(page, pageOf(axis), inFrame);
          await scrollTo(frame, axis, scroll);
          const at = axis === "y" ? cy : cx;
          const before = await stripUnder(frame, cx, cy);
          await page.mouse.move(origin.x + cx, origin.y + cy);
          await page.keyboard.down("Control");
          // One notch, a mid zoom, then the 5x cap: the error must not grow with depth.
          for (const notches of [1, 3, 7]) {
            for (let i = 0; i < notches; i++) {
              await page.mouse.wheel(0, -200);
              await page.waitForTimeout(40);
            }
            const after = await stripUnder(frame, cx, cy);
            expect(after.zoom).toBeGreaterThan(before.zoom);
            expect(Math.abs(after.strip - before.strip), `strip under (${cx},${cy}) at zoom ${after.zoom}, axis offset ${at}`).toBeLessThanOrEqual(1);
          }
          await page.keyboard.up("Control");
        }
      });
    }
  }
});

test.describe("view-harness / preview page zoom anchor (phone pinch)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

  test("a pinch keeps the content under the midpoint of the two fingers still", async ({ page }) => {
    const { frame } = await mountIn(page, pageOf("y"), false);
    await scrollTo(frame, "y", 2000);
    // Off-centre on purpose: a centre midpoint hides a wrong origin term.
    const mid = { x: 110, y: 230 };
    const before = await stripUnder(frame, mid.x, mid.y);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
    const fingers = (d: number) => [{ x: mid.x - d, y: mid.y }, { x: mid.x + d, y: mid.y }];
    await touch("touchStart", fingers(15).slice(0, 1));
    await touch("touchStart", fingers(15));
    for (let i = 1; i <= 8; i++) await touch("touchMove", fingers(15 + i * 10));
    await touch("touchEnd", []);
    await expect.poll(async () => (await stripUnder(frame, mid.x, mid.y)).zoom).toBeGreaterThan(2);
    const after = await stripUnder(frame, mid.x, mid.y);
    expect(Math.abs(after.strip - before.strip), `strip under the midpoint at zoom ${after.zoom}`).toBeLessThanOrEqual(1);
  });
});
