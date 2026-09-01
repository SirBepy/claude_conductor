// Preview-document builder for the docked preview panel (ai_todo 517/518,
// split off of preview-panel.ts). Pure functions, zero PreviewPanel instance
// state - they build the CSP/sandbox-relevant iframe document string.

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

/** Loaded via a `data:` URL, never `iframe.srcdoc`: a srcdoc document has no
 * navigation, so it inherits the app's CSP and can only intersect this meta,
 * never loosen it. A data: URL navigates into its own opaque origin, which
 * makes this meta the sole governing policy. */
export function buildPreviewDocumentHtml(html: string): string {
  const wrapped = wrapFragmentIfNeeded(html);
  const withHead = /<head[^>]*>/i.test(wrapped)
    ? wrapped.replace(/<head[^>]*>/i, (m) => `${m}${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}`)
    : /<html[^>]*>/i.test(wrapped)
      ? wrapped.replace(/<html[^>]*>/i, (m) => `${m}<head>${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}</head>`)
      : `${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}${wrapped}`;
  return /<\/body>/i.test(withHead)
    ? withHead.replace(/<\/body>/i, `${DIAGNOSTICS_BODY_END_SCRIPT}</body>`)
    : `${withHead}${DIAGNOSTICS_BODY_END_SCRIPT}`;
}
