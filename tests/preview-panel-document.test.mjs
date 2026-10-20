// buildPreviewDocumentHtml splices a diagnostics script right before the
// closing </body>. A mockup whose own inline script builds HTML strings
// containing the literal text "</body>" (e.g. a mockup that renders HTML)
// must not have that string match mistaken for the real closing tag - the
// regression this guards (2026-10-20): matching the FIRST </body> spliced
// the diagnostics script into the middle of that string instead, truncating
// the inline script and silently dropping everything after it.

import { describe, it, expect } from "vitest";

const { buildPreviewDocumentHtml } = await import("../src/views/sessions/preview-panel-document.ts");

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
});
