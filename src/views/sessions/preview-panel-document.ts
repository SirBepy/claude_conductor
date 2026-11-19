// Preview-document builder for the docked preview panel (ai_todo 517/518,
// split off of preview-panel.ts). Pure functions, zero PreviewPanel instance
// state - they build the CSP/sandbox-relevant iframe document string.

import { escapeHtml } from "../../shared/escape-html";
import { basename } from "../../shared/path-utils";
import { PAGE_STATE_SCRIPT } from "./preview-page-state";
import { PAGE_ZOOM_SCRIPT } from "./preview-page-zoom";
import { previewTemplateHead } from "./preview-templates";

/** AI-pushed HTML may be a bare fragment; wrap it in minimal boilerplate
 * before it becomes the iframe's data: URL document. */
export function wrapFragmentIfNeeded(html: string): string {
  if (/<html[\s>]/i.test(html) || /<body[\s>]/i.test(html)) return html;
  // Literal colours, not CSS vars: this loads via a data: URL into an opaque
  // origin with no access to the parent's custom properties. Matches the
  // app's dark chrome (--color-background/--color-text-primary fallbacks).
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#15151e;color:#e0e0e0}</style></head><body>${html}</body></html>`;
}

// Inner document CSP. Locked decision (Joe, 2026-06-26): do NOT hard-block
// network — a preview may legitimately fetch data. Left permissive on
// script/style/connect so "look-right rendering" (inline <script>, CDN
// fetches) isn't broken; the REAL isolation boundary is the iframe's
// `sandbox="allow-scripts"` with no `allow-same-origin` (opaque origin —
// scripts run but can't reach the parent DOM, storage, or IPC).
const INNER_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; font-src * data:;">`;

// Self-contained reporter injected into every pushed doc (see
// project_preview_panel_data_url_not_srcdoc: inline scripts have silently
// no-op'd in live WebView2, no repro outside it) - renders its own banner
// INSIDE the iframe DOM since parent postMessage can't be assumed to work.
const DIAGNOSTICS_HEAD_SCRIPT = `<script>(function(){
  window.__previewDiag = { bodyEndRan: false };
  function banner(text){
    var show = function(){
      var el = document.createElement("div");
      el.setAttribute("style","position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4a1420;color:#ffd7d7;font:12px/1.5 ui-monospace,Consolas,monospace;padding:8px 12px;white-space:pre-wrap;cursor:pointer;border-bottom:2px solid #ff6b6b;");
      el.textContent = "\\u26a0 preview diagnostic \\u2014 " + text + " (click to dismiss)";
      el.onclick = function(){ el.remove(); };
      document.body.prepend(el);
    };
    if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
  }
  window.onerror = function(msg, src, line, col, err){
    banner("script error: " + msg + " (" + (src || "inline") + ":" + line + ":" + col + ")");
  };
  window.addEventListener("unhandledrejection", function(e){
    banner("unhandled rejection: " + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  document.addEventListener("securitypolicyviolation", function(e){
    banner("CSP blocked " + e.violatedDirective + ": " + e.blockedURI);
  });
  setTimeout(function(){
    if (!window.__previewDiag.bodyEndRan) banner("trailing content never executed \\u2014 parsing likely stalled or was blocked before reaching the end of the document");
  }, 1500);
})();</script>`;

// Marks that parsing/execution reached the end of the document; the head
// script's timeout checks this flag to catch a total, error-free script
// no-op (the documented failure mode) rather than only catching exceptions.
const DIAGNOSTICS_BODY_END_SCRIPT = `<script>window.__previewDiag && (window.__previewDiag.bodyEndRan = true);</script>`;

/** Splices `headHtml` in right after the document's opening head tag, adding
 *  the head (or the whole prefix) when the page has none. */
function spliceHead(doc: string, headHtml: string): string {
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${headHtml}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => `${m}<head>${headHtml}</head>`);
  return `${headHtml}${doc}`;
}

/** The pushed page with its template applied (see preview-templates.ts), and
 *  nothing else: no CSP, no diagnostics. What "Open in browser" writes to disk. */
export function applyPreviewTemplate(html: string): string {
  const wrapped = wrapFragmentIfNeeded(html);
  return spliceHead(wrapped, previewTemplateHead(wrapped));
}

/** Loaded via a `data:` URL, never `iframe.srcdoc`: a srcdoc document has no
 * navigation, so it inherits the app's CSP and can only intersect this meta,
 * never loosen it. A data: URL navigates into its own opaque origin, which
 * makes this meta the sole governing policy.
 *
 * `zoom` adds the in-page pinch/wheel zoom (preview-page-zoom.ts) the Preview
 * panel wants; the inline chat card scrolls with the chat, so it leaves it off.
 * `state` adds the `ccPreview.state` save/restore channel (preview-page-state.ts),
 * only meaningful where the panel can keep what the page saves. */
export function buildPreviewDocumentHtml(html: string, opts: { zoom?: boolean; state?: boolean } = {}): string {
  const templated = applyPreviewTemplate(html);
  const withHead = spliceHead(templated, `${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}${opts.zoom ? PAGE_ZOOM_SCRIPT : ""}${opts.state ? PAGE_STATE_SCRIPT : ""}`);
  // The LAST </body>, not the first: a mockup's own inline script commonly
  // builds HTML strings containing the literal text "</body>" (e.g. an
  // AI-generated mockup that itself renders HTML), and .replace() with no
  // global flag would splice the diagnostics script into that string
  // instead of the real closing tag, truncating the script and silently
  // dropping everything after it.
  const bodyCloseTags = [...withHead.matchAll(/<\/body>/gi)];
  const lastBodyClose = bodyCloseTags[bodyCloseTags.length - 1];
  return lastBodyClose
    ? withHead.slice(0, lastBodyClose.index) + DIAGNOSTICS_BODY_END_SCRIPT + withHead.slice(lastBodyClose.index)
    : `${withHead}${DIAGNOSTICS_BODY_END_SCRIPT}`;
}

// ── a file opened in the Preview panel (previewFile, src/shared/preview-file.ts) ──

/** What `previewFile` found in a file, already reduced to what the document shows. */
export type FileDocument =
  | { kind: "markdown"; path: string; renderedHtml: string; source: string; truncated: boolean }
  | { kind: "code"; path: string; source: string; truncated: boolean }
  | { kind: "image"; path: string; src: string }
  | { kind: "error"; path: string; message: string };

// Literal colours for the same reason as `wrapFragmentIfNeeded`: the page is an opaque origin.
// The Rendered / Source switch is two radios and sibling selectors, so it needs no script and
// keeps working where the iframe's scripts are blocked.
const FILE_CSS = `body{background:#15151e;color:#e0e0e0}
.pf-head{display:flex;align-items:center;gap:12px;margin:0 0 12px;font:13px ui-monospace,Consolas,monospace;color:#9aa0b4}
.pf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-radio{position:absolute;opacity:0;pointer-events:none}
.pf-tab{padding:3px 10px;border:1px solid #3a3a4c;border-radius:6px;cursor:pointer;color:#c8cce0}
#pf-v-r:checked~.pf-head label[for=pf-v-r],#pf-v-s:checked~.pf-head label[for=pf-v-s]{background:#2b2b40;color:#fff}
#pf-v-r:focus-visible~.pf-head label[for=pf-v-r],#pf-v-s:focus-visible~.pf-head label[for=pf-v-s]{outline:2px solid #7aa2ff}
.pf-source{display:none}
#pf-v-s:checked~.pf-rendered{display:none}
#pf-v-s:checked~.pf-source{display:block}
pre.pf-body,.pf-body pre,.pf-source{margin:0;padding:12px;background:#1d1d29;border-radius:6px;overflow:auto;font:12.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre}
.pf-body code{font-family:ui-monospace,Consolas,monospace}
.pf-body table{border-collapse:collapse}.pf-body th,.pf-body td{border:1px solid #3a3a4c;padding:4px 8px}
.pf-body a{color:#7aa2ff}
/* A quote of a person is a reply bubble on every surface (chat-messages-markdown.css, same shape in literal colours). */
.pf-body blockquote.md-quote{margin:6px 0 8px;padding:6px 10px;border-left:3px solid #7aa2ff;border-radius:0 6px 6px 0;background:rgba(122,162,255,.1);font-style:normal}
.pf-body blockquote.md-quote>p{margin:0}
.pf-body blockquote.md-quote>p+p{margin-top:4px}
.pf-body blockquote.md-quote>p.md-quote-who{margin-bottom:2px;font-size:.92em;font-weight:600;color:#7aa2ff}
.pf-body blockquote.md-quote>p.md-quote-who+p{margin-top:0}
.pf-body .md-quote-src{font-weight:400;color:#9aa0b4}
.pf-body .md-quote-colon{display:none}
.pf-note{margin:12px 0 0;color:#e0b050;font-size:13px}
.pf-error{padding:16px;border:1px solid #6b2b36;border-radius:6px;background:#2a1519;color:#ffd7d7}
.pf-img{display:block;max-width:100%;margin:0 auto;background:repeating-conic-gradient(#222 0 25%,#2a2a2a 0 50%) 0 0/16px 16px}`;

/** The HTML page the Preview panel shows for a file: markdown rendered with a Source switch, an
 *  image, code as monospace, or a plain error box, so a file that cannot be shown is never a blank panel. */
export function buildFilePreviewHtml(doc: FileDocument): string {
  const name = escapeHtml(basename(doc.path));
  const head = (switcher: string) => `<div class="pf-head"><span class="pf-name" title="${escapeHtml(doc.path)}">${name}</span>${switcher}</div>`;
  const note = (truncated: boolean) => (truncated ? `<p class="pf-note">The file is larger than the preview reads, so only its start is shown.</p>` : "");
  let body: string;
  if (doc.kind === "error") {
    body = `${head("")}<div class="pf-error" role="alert">${escapeHtml(doc.message)}</div>`;
  } else if (doc.kind === "image") {
    body = `${head("")}<img class="pf-img" alt="${name}" src="${escapeHtml(doc.src)}">`;
  } else if (doc.kind === "code") {
    body = `${head("")}<pre class="pf-body" data-pf-view="source">${escapeHtml(doc.source)}</pre>${note(doc.truncated)}`;
  } else {
    const switcher = `<label class="pf-tab" for="pf-v-r">Rendered</label><label class="pf-tab" for="pf-v-s">Source</label>`;
    body = `<input type="radio" class="pf-radio" name="pf-v" id="pf-v-r" checked aria-label="Rendered"><input type="radio" class="pf-radio" name="pf-v" id="pf-v-s" aria-label="Source">`
      + `${head(switcher)}<div class="pf-rendered pf-body" data-pf-view="rendered">${doc.renderedHtml}</div><pre class="pf-source" data-pf-view="source">${escapeHtml(doc.source)}</pre>${note(doc.truncated)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>${FILE_CSS}</style></head><body>${body}</body></html>`;
}
