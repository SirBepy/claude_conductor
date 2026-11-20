// The srcdoc document an option's `preview` HTML renders in. The card's frames
// are `sandbox=""` (no scripts, opaque origin) and inherit the app's CSP, so
// the fragment can only ever be markup + CSS. The fullscreen frame is
// `sandbox="allow-same-origin"` so the parent can read the page height; it
// must never also get `allow-scripts`, which together with same-origin would
// lift the sandbox. It loads the app's OWN stylesheets,
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
// The grid column is minmax(0, 1fr), not auto: an auto column grows to a wide
// image's natural width, the body's overflow:hidden then clips everything past
// the frame, and a phone frame (390px wide, 150-210px tall) showed only the
// image's top-left corner. `safe center` keeps a fragment that is still wider
// than the frame (a fixed-width mockup) starting at its left/top edge instead of
// cropping both sides. The media rule fits any image, svg, video or canvas to the
// frame whatever size the author gave it, keeping its aspect ratio (object-fit:
// contain covers an author's width AND height). It sits in :where() so any
// author rule, even a bare `img { object-fit: cover }`, still wins.
const FRAME_BASE = `<style>
html body { margin: 0; padding: 12px; box-sizing: border-box; min-height: 100vh; height: auto;
  display: grid; grid-template-columns: minmax(0, 1fr); place-items: safe center; overflow: hidden;
  background: var(--color-background); }
:where(html body) :where(img, svg, video, canvas) { max-width: 100%; object-fit: contain; }
</style>`;

// A frame with no scroll (card, stage, thumbnails) also caps the media height at
// the frame's height less the body padding. The fullscreen frame does not: it is
// stretched to the page's height and shrunk to fit (fitFrameToView), so a vh cap
// would grow with each stretch and never settle.
const FIT_FRAME_HEIGHT = `<style>:where(html body) :where(img, svg, video, canvas) { max-height: calc(100vh - 24px); }</style>`;

export function previewDocument(fragment: string, opts: { stretchable?: boolean } = {}): string {
  const fit = opts.stretchable ? "" : FIT_FRAME_HEIGHT;
  return `<!doctype html><html${rootAttrs()}><head><meta charset="utf-8">${appStyleTags()}${FRAME_BASE}${fit}</head><body>${fragment}</body></html>`;
}
