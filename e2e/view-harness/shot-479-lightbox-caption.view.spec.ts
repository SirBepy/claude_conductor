import { expect, test, type Locator, type Page } from "@playwright/test";
import { capture, mountView } from "./harness";

// Todo 479: 27db7698 moved the composer-wrap out of the image-only branch, so
// the caption box should now render for text and PDF previews too.
const DESKTOP = { width: 1400, height: 900 };

const LIGHTBOX_INVOKE = {
  list_slash_commands: [
    { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
  ],
  list_project_files: [],
};

type Kind = "text" | "pdf" | "image";

/** Installs a stub bridge then opens the lightbox, mirroring
 *  lightbox-composer-typing.view.spec.ts's own helper. */
async function openLightboxWithComposer(page: Page, kind: Kind): Promise<void> {
  await page.evaluate(async (k: Kind) => {
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
      const body = "BT /F1 18 Tf 24 110 Td (Lightbox PDF caption test) Tj ET";
      const pdf = [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 200]"
          + "/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj",
        `4 0 obj<</Length ${body.length}>>stream`,
        body,
        "endstream endobj",
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
        "trailer<</Root 1 0 R/Size 6>>",
        "%%EOF",
      ].join("\n");
      lightbox.openLightbox({ type: "pdf", base64: btoa(pdf), filename: "report.pdf" });
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
  }, kind);
}

async function expectNoOverlap(composer: Locator, content: Locator): Promise<void> {
  const a = await composer.boundingBox();
  const b = await content.boundingBox();
  expect(a, "composer has no layout box").not.toBeNull();
  expect(b, "content has no layout box").not.toBeNull();
  const separated =
    a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y
    || a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x;
  expect(separated, `composer ${JSON.stringify(a)} overlaps content ${JSON.stringify(b)}`).toBe(true);
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
    await expectNoOverlap(input, pre);

    await expectEnterInsertsNewline(input, overlay);
    await capture(overlay, "lightbox-text-composer");
  });

  // The embed paints empty here AND under real Chrome: index.html's CSP sets no
  // object-src, so default-src 'self' blocks the blob: plugin load.
  test("pdf lightbox shows the caption box under the <embed>", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: LIGHTBOX_INVOKE });
    await openLightboxWithComposer(page, "pdf");

    const overlay = page.locator(".lightbox-overlay");
    const embed = overlay.locator(".lightbox-content embed");
    const input = overlay.locator(".lightbox-composer");
    await expect(embed).toBeVisible();
    await expect(embed).toHaveAttribute("type", "application/pdf");
    await expect(embed).toHaveAttribute("src", /^blob:/);
    await expect(input).toBeVisible();
    await expectNoOverlap(input, embed);

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
    await expectNoOverlap(input, img);

    await expectEnterInsertsNewline(input, overlay);
    await capture(overlay, "lightbox-image-composer-regression");

    // Click-to-zoom toggle, proving setupImageZoomPan still ran after the move.
    await img.click();
    await expect
      .poll(() => img.evaluate((el) => el.style.transform))
      .toContain("scale(2.5)");
  });
});
