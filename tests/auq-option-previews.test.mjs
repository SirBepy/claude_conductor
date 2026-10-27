// The srcdoc document an option preview renders in copies the app's inline
// <style> blocks, including index.html's boot gate
// `html:not(.app-ready) body { visibility: hidden }`. The frame's <html> must
// therefore carry the root's class list too, or the gate never lifts inside the
// frame and every preview paints as a blank rectangle.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

class FakeStyleElement {
  constructor(text) { this.textContent = text; }
}

const GATE_CSS = "html:not(.app-ready) body { visibility: hidden; }";

function stubDocument(rootAttrs) {
  globalThis.HTMLStyleElement = FakeStyleElement;
  globalThis.document = {
    styleSheets: [{ href: null, media: { mediaText: "" }, ownerNode: new FakeStyleElement(GATE_CSS) }],
    documentElement: { attributes: rootAttrs },
  };
}

const mod = await import("../src/views/sessions/permission-modal/option-preview-doc.ts");

describe("option preview document", () => {
  beforeEach(() => stubDocument([
    { name: "class", value: "app-ready" },
    { name: "data-theme", value: "void" },
    { name: "lang", value: "en" },
  ]));
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.HTMLStyleElement;
  });

  it("lifts the app's boot gate inside the frame by copying the root class list", () => {
    const doc = mod.previewDocument("<b>x</b>");
    const htmlTag = doc.slice(doc.indexOf("<html"), doc.indexOf(">", doc.indexOf("<html")) + 1);
    expect(doc).toContain(GATE_CSS);
    expect(htmlTag).toContain('class="app-ready"');
    expect(htmlTag).toContain('data-theme="void"');
  });

  it("still copies data-* attributes and drops unrelated root attributes", () => {
    const doc = mod.previewDocument("<b>x</b>");
    const htmlTag = doc.slice(doc.indexOf("<html"), doc.indexOf(">", doc.indexOf("<html")) + 1);
    expect(htmlTag).not.toContain("lang=");
    expect(doc).toContain("<body><b>x</b></body>");
  });
});
