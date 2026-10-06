// Window-mode hash parsing, shared shape across main.ts's "detect before
// mounting the normal router" window modes (detached session, preview
// pop-out, code mode pop-out). Each backend-opened window encodes its target
// in the URL hash (plus a query flag for preview/code) rather than a route
// name, since the router would otherwise treat it as an unknown view.

// Detached-window mode: backend opens a new Tauri window pointed at
// `index.html#detached?session=<id>`. Detect that URL shape BEFORE
// mounting the normal router (the router would treat "detached?..." as
// an unknown view name) and render the solo session pane instead.
export function detachedSessionFromHash(): string | null {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#detached")) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("session");
}

// Preview pop-out window mode (todo 290), same detect-before-router shape as
// detachedSessionFromHash: backend opens `index.html?previewwindow=1#preview?session=<id>`.
export function previewSessionFromHash(): string | null {
  if (new URLSearchParams(window.location.search).get("previewwindow") !== "1") return null;
  const hash = window.location.hash || "";
  if (!hash.startsWith("#preview")) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("session");
}

// Code mode's own window, same detect-before-router shape: backend opens
// `index.html?codewindow=1#code?session=<id>`.
export function codeSessionFromHash(): string | null {
  if (new URLSearchParams(window.location.search).get("codewindow") !== "1") return null;
  const hash = window.location.hash || "";
  if (!hash.startsWith("#code")) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return null;
  return new URLSearchParams(hash.slice(qIdx + 1)).get("session");
}
