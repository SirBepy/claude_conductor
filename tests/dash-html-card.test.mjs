// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "lit-html";

// A chat-written html card renders in a sandboxed frame that cannot reach the
// app: scripts run, but with an opaque origin and no network.

const { buildCardDoc, htmlCardFrame } = await import("../src/views/sessions/projects-tab/dash-html-card.ts");

describe("dashboard html card", () => {
  it("renders an iframe sandboxed to scripts only, never same-origin", () => {
    const host = document.createElement("div");
    render(htmlCardFrame("Hours", "<b>hi</b>", { h: 1 }), host);
    const frame = host.querySelector("iframe.pd-html-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.srcdoc).toContain("<b>hi</b>");
  });

  it("locks the document to no network with a CSP meta", () => {
    const doc = buildCardDoc("", null, "");
    expect(doc).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none'`);
    expect(doc).not.toMatch(/connect-src (?!'none')/);
  });

  it("inlines the data so a closing script tag inside it cannot break out", () => {
    const doc = buildCardDoc("", { note: "</script><script>alert(1)</script>" }, "");
    expect(doc).not.toContain("</script><script>alert(1)");
    expect(doc).toContain("\\u003c/script>");
  });

  it("escapes the JS line separators in the inlined data", () => {
    const doc = buildCardDoc("", { s: `a${String.fromCharCode(0x2028)}b` }, "");
    expect(doc).toContain("a\\u2028b");
    expect(doc).not.toContain(String.fromCharCode(0x2028));
  });

  it("carries the theme variables into the frame", () => {
    const doc = buildCardDoc("", null, "--color-text:#eee;--color-accent:#f80");
    expect(doc).toContain(":root{--color-text:#eee;--color-accent:#f80}");
  });
});
