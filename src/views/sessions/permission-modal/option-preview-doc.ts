// The srcdoc document an option's `preview` HTML renders in. The frame is
// `sandbox=""` (no scripts, opaque origin) and inherits the app's CSP, so the
// fragment can only ever be markup + CSS. It loads the app's OWN stylesheets,
// which is what lets Claude draw with the real classes and tokens instead of a
// hand-made imitation of the app.

import { escapeHtml } from "../../../shared/escape-html";

// A linked sheet is re-linked by URL (a memory-cache hit, no re-download); an
// inline <style> (Vite dev, injected chunks) is copied by text.
function appStyleTags(): string {
  return Array.from(document.styleSheets).map((sheet) => {
    const media = sheet.media?.mediaText ? ` media="${escapeHtml(sheet.media.mediaText)}"` : "";
    if (sheet.href) return `<link rel="stylesheet" href="${escapeHtml(sheet.href)}"${media}>`;
    const node = sheet.ownerNode;
    return node instanceof HTMLStyleElement ? `<style${media}>${node.textContent ?? ""}</style>` : "";
  }).join("");
}

// Theme and palette live on <html> as data-* attributes (and inline custom
// properties); without them every var() in the fragment falls back. Only the
// classes in FRAME_ROOT_CLASSES are copied: appStyleTags() brings in index.html's
// boot gate (html:not(.app-ready) body hidden), so a frame without .app-ready
// paints blank, while the root also carries transient classes (cursor-typing-hidden
// hides the cursor on everything, alt-held reveals shortcut keys) that would stay
// frozen in a frame built at the wrong moment.
const FRAME_ROOT_CLASSES = new Set(["app-ready"]);

function rootAttrs(): string {
  return Array.from(document.documentElement.attributes)
    .map((a): [string, string] => a.name === "class"
      ? [a.name, a.value.split(/\s+/).filter((c) => FRAME_ROOT_CLASSES.has(c)).join(" ")]
      : [a.name, a.value])
    .filter(([name, value]) => name.startsWith("data-") || name === "style" || (name === "class" && value !== ""))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
}

// Placed after the app sheets so it outranks base.css's body rules (safe-area
// padding, dvh height). Centring makes a small fragment read as a composed
// specimen instead of a scrap stuck in the top-left corner.
const FRAME_BASE = `<style>
html body { margin: 0; padding: 12px; box-sizing: border-box; min-height: 100vh; height: auto;
  display: grid; place-items: center; overflow: hidden; background: var(--color-background); }
</style>`;

export function previewDocument(fragment: string): string {
  return `<!doctype html><html${rootAttrs()}><head><meta charset="utf-8">${appStyleTags()}${FRAME_BASE}</head><body>${fragment}</body></html>`;
}
