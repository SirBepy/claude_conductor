// buildPreviewDocumentHtml splices a diagnostics script right before the
// closing </body>. A mockup whose own inline script builds HTML strings
// containing the literal text "</body>" (e.g. a mockup that renders HTML)
// must not have that string match mistaken for the real closing tag - the
// regression this guards (2026-10-20): matching the FIRST </body> spliced
// the diagnostics script into the middle of that string instead, truncating
// the inline script and silently dropping everything after it.

import { describe, it, expect } from "vitest";

const { buildPreviewDocumentHtml, applyPreviewTemplate } = await import("../src/views/sessions/preview-panel-document.ts");

describe("buildPreviewDocumentHtml", () => {
  it("splices before the LAST </body>, not a </body> string literal inside an inline script", () => {
    const html = `<!doctype html><html><head></head><body>
      <script>var tpl = "<div></div></body>"; window.__tplRan = true;</script>
      <p id="after">after the script</p>
    </body></html>`;

    const out = buildPreviewDocumentHtml(html);

    // The inline script must survive intact, not get cut off mid-string.
    expect(out).toContain('window.__tplRan = true;');
    // The real trailing content, after the script, must still be present.
    expect(out).toContain('id="after"');
    // The real closing </body> immediately follows the body-end marker.
    expect(out).toMatch(/window\.__previewDiag && \(window\.__previewDiag\.bodyEndRan = true\);<\/script><\/body>/);
  });

  it("still splices before the only </body> in a normal document", () => {
    const out = buildPreviewDocumentHtml("<!doctype html><html><body><p>hi</p></body></html>");
    expect(out).toMatch(/bodyEndRan = true\);<\/script><\/body><\/html>$/);
  });

  // Only the Preview panel zooms; the inline chat card scrolls with the chat.
  it("adds the in-page zoom only when asked", () => {
    const html = "<!doctype html><html><head></head><body><p>hi</p></body></html>";
    expect(buildPreviewDocumentHtml(html, { zoom: true })).toContain("touchAction");
    expect(buildPreviewDocumentHtml(html)).not.toContain("touchAction");
  });

  it("serializes the zoom runtime into a script that parses and keeps no reference to this module", () => {
    const out = buildPreviewDocumentHtml("<p>hi</p>", { zoom: true });
    const script = out.match(/<script>\((function pageZoomRuntime[\s\S]*?)\)\(\);<\/script>/)?.[1];
    expect(script).toBeTruthy();
    // Throws on a stray `__name(` helper or any import the transpiler left behind.
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(script).not.toMatch(/__name|import\./);
  });

  describe("page template", () => {
    it("gives a document with no template meta the default page template", () => {
      const out = buildPreviewDocumentHtml("<!doctype html><html><head></head><body><p>hi</p></body></html>");
      expect(out).toContain('data-preview-template="page"');
      expect(out).toContain('name="viewport"');
    });

    it("gives a bare fragment the template too", () => {
      expect(buildPreviewDocumentHtml("<h1>hi</h1>")).toContain('data-preview-template="page"');
    });

    it("keeps every template rule at zero specificity so the page's own rules win", () => {
      const css = buildPreviewDocumentHtml("<p>x</p>").match(/<style data-preview-template="page">([\s\S]*?)<\/style>/)[1];
      // A selector outside :where() would outrank a plain `body {}` in the page.
      for (const rule of css.split("}").filter((r) => r.trim())) {
        expect(rule.trim().startsWith(":where(")).toBe(true);
      }
    });

    it("skips the template for a page that asks for bare, in either attribute order", () => {
      const a = buildPreviewDocumentHtml('<!doctype html><html><head><meta name="preview-template" content="bare"></head><body></body></html>');
      const b = buildPreviewDocumentHtml("<!doctype html><html><head><meta content='bare' name='preview-template'></head><body></body></html>");
      expect(a).not.toContain("data-preview-template");
      expect(b).not.toContain("data-preview-template");
    });

    it("falls back to the default for an unknown template name", () => {
      const out = buildPreviewDocumentHtml('<!doctype html><html><head><meta name="preview-template" content="nope"></head><body></body></html>');
      expect(out).toContain('data-preview-template="page"');
    });

    it("leaves a page's own viewport meta alone", () => {
      const out = buildPreviewDocumentHtml('<!doctype html><html><head><meta name="viewport" content="width=500"></head><body></body></html>');
      expect(out.match(/name="viewport"/g)).toHaveLength(1);
    });

    it("applyPreviewTemplate adds the template without the CSP or diagnostics", () => {
      const out = applyPreviewTemplate("<h1>hi</h1>");
      expect(out).toContain('data-preview-template="page"');
      expect(out).not.toContain("Content-Security-Policy");
      expect(out).not.toContain("__previewDiag");
    });
  });
});
