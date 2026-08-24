import { expect, test, type Locator, type Page } from "@playwright/test";
import { capture, expectSeparated, mountView } from "./harness";

// Todo 479: 27db7698 moved the composer-wrap out of the image-only branch, so
// the caption box should now render for text and PDF previews too.
const DESKTOP = { width: 1400, height: 900 };

// Full Chromium, not the default headless shell: the shell ships no PDF plugin
// at all, so the pdf test's paint assertion would fail for the wrong reason.
test.use({ channel: "chromium" });

const LIGHTBOX_INVOKE = {
  list_slash_commands: [
    { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
  ],
  list_project_files: [],
};

type Kind = "text" | "pdf" | "image";

// A one-page PDF with a real xref/startxref: Chrome's plugin renders a black
// box on a white sheet, so a paint assertion has something unambiguous to see.
const PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMjAgMjAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+L0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDc5Pj5zdHJlYW0KMCAwIDAgcmcgNDAgNDAgMjQwIDEyMCByZSBmIEJUIC9GMSAxOCBUZiA2MCA5MCBUZCAxIDEgMSByZyAoTGlnaHRib3ggUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzQzIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA2CiUlRU9GCg==";

/** Installs a stub bridge then opens the lightbox, mirroring
 *  lightbox-composer-typing.view.spec.ts's own helper. */
async function openLightboxWithComposer(page: Page, kind: Kind): Promise<void> {
  await page.evaluate(async ({ k, PDF_BASE64 }: { k: Kind; PDF_BASE64: string }) => {
    const lightbox = await import("/shared/chat/lightbox.ts");
    lightbox.setLightboxComposerBridge({
      getDraftText: () => "",
      setDraftText: () => {},
      getCwd: () => null,
    });

    if (k === "text") {
      const lines: string[] = [];
      for (let i = 0; i < 36; i++) {
        const mm = String(20 + Math.floor(i / 6)).padStart(2, "0");
        const ss = String((i * 7) % 60).padStart(2, "0");
        lines.push(`[10:${mm}:${ss}] [daemon] session s${(i % 4) + 1} turn ${i} settled in ${120 + i * 13}ms`);
      }
      lightbox.openLightbox({ type: "text", content: lines.join("\n"), filename: "daemon.log" });
      return;
    }

    if (k === "pdf") {
      lightbox.openLightbox({ type: "pdf", base64: PDF_BASE64, filename: "report.pdf" });
      return;
    }

    // Canvas-drawn so the image has real dimensions: a 1x1 pixel would make the
    // non-overlap assertion pass trivially.
    const canvas = document.createElement("canvas");
    canvas.width = 760;
    canvas.height = 420;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 760, 420);
    grad.addColorStop(0, "#3b2f63");
    grad.addColorStop(1, "#1c7f6b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 760, 420);
    ctx.fillStyle = "#ffffff";
    ctx.font = "34px sans-serif";
    ctx.fillText("image attachment", 40, 230);
    const prefix = "data:image/png;base64,";
    lightbox.openLightbox({
      type: "image",
      mime: "image/png",
      base64: canvas.toDataURL("image/png").slice(prefix.length),
      filename: "shot.png",
    });
  }, { k: kind, PDF_BASE64 });
}

/** Records CSP violations for the whole page lifetime. Installed before
 *  mountView so it is already listening when the page navigates. */
async function watchCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      const v = e as SecurityPolicyViolationEvent;
      w.__cspViolations.push(`${v.effectiveDirective || v.violatedDirective} <- ${v.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** Share of near-white pixels in a locator's screenshot. A blocked plugin
 *  leaves the dark overlay showing through (~0); a rendered PDF page is a
 *  big white sheet. */
async function whitePixelRatio(page: Page, target: Locator): Promise<number> {
  const png = (await target.screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let light = 0;
    for (let i = 0; i < px.length; i += 4) {
      if ((px[i] ?? 0) > 200 && (px[i + 1] ?? 0) > 200 && (px[i + 2] ?? 0) > 200) light++;
    }
    return light / (px.length / 4);
  }, png);
}

/** Enter must stay a plain newline: the lightbox box mirrors a draft, it has
 *  no send path. */
async function expectEnterInsertsNewline(input: Locator, overlay: Locator): Promise<void> {
  await input.fill("line one");
  await input.press("Enter");
  await input.pressSequentially("line two");
  await expect(input).toHaveValue("line one\nline two");
  await expect(overlay).toBeVisible();
  await input.fill("");
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("text lightbox shows the caption box under the <pre>", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: LIGHTBOX_INVOKE });
    await openLightboxWithComposer(page, "text");

    const overlay = page.locator(".lightbox-overlay");
    const pre = overlay.locator(".lightbox-content pre");
    const input = overlay.locator(".lightbox-composer");
    await expect(pre).toBeVisible();
    await expect(pre).toContainText("[daemon] session s1 turn 0 settled in 120ms");
    await expect(input).toBeVisible();
    await expectSeparated(input, pre);

    await expectEnterInsertsNewline(input, overlay);
    await capture(overlay, "lightbox-text-composer");
  });

  test("pdf lightbox renders the PDF under the caption box", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cspViolations = await watchCspViolations(page);
    await mountView(page, { invoke: LIGHTBOX_INVOKE });
    await openLightboxWithComposer(page, "pdf");

    const overlay = page.locator(".lightbox-overlay");
    const embed = overlay.locator(".lightbox-content embed");
    const input = overlay.locator(".lightbox-composer");
    await expect(embed).toBeVisible();
    await expect(embed).toHaveAttribute("type", "application/pdf");
    await expect(embed).toHaveAttribute("src", /^blob:/);

    // Todo 739: an <embed> that exists but paints nothing IS the bug. A blocked
    // plugin leaves the dark overlay showing (ratio 0); the page sheet reads ~0.08.
    await expect.poll(() => whitePixelRatio(page, embed), { timeout: 10_000 }).toBeGreaterThan(0.03);
    expect(await cspViolations()).toEqual([]);

    await expect(input).toBeVisible();
    await expectSeparated(input, embed);

    await expectEnterInsertsNewline(input, overlay);
    await capture(overlay, "lightbox-pdf-composer");
  });

  test("image lightbox keeps its caption box, more-menu and zoom", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: LIGHTBOX_INVOKE });
    await openLightboxWithComposer(page, "image");

    const overlay = page.locator(".lightbox-overlay");
    const img = overlay.locator(".lightbox-content img");
    const input = overlay.locator(".lightbox-composer");
    await expect(img).toBeVisible();
    await expect(overlay.locator(".lightbox-more-btn")).toBeVisible();
    await expect(input).toBeVisible();
    await expectSeparated(input, img);

    await expectEnterInsertsNewline(input, overlay);
    await capture(overlay, "lightbox-image-composer-regression");

    // Click-to-zoom toggle, proving setupImageZoomPan still ran after the move.
    await img.click();
    await expect
      .poll(() => img.evaluate((el) => el.style.transform))
      .toContain("scale(2.5)");
  });
});
