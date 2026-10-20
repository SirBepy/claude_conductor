// "Publish to claude.ai", shared by the preview panel, the drafts
// editor and the in-chat draft card. The daemon does the upload through a
// one-shot `claude -p` with the CLI's Artifact tool, so a click costs one
// short model turn; a link that is already current is just re-copied.
//
// Every page lands PRIVATE on claude.ai. Joe makes it shareable from the
// page's own Share menu, which is also the only gate before client work
// reaches anyone else - so there is no confirm step here, only the account
// name on the button and in the toast.

import MarkdownIt from "markdown-it";
import { invoke } from "./ipc";
import { isRemote } from "./transport";
import { showToast } from "./toast";
import type { PublishedLink } from "../types/ipc.generated";
import "./claude-ai-publish.css";

export type PublishParams =
  | { target: "preview"; id: string }
  | { target: "draft"; session_id: string; id: string; recipient: string; title: string; html: string; version: number };

export type PublishState = "none" | "current" | "stale";

/** Desktop only: the RPC has no phone transport row (it spends a model turn
 *  and uploads content, a write the phone path was never reviewed for). */
export function canPublish(): boolean {
  return !isRemote();
}

export function publishState(link: PublishedLink | null | undefined, version: number): PublishState {
  if (!link) return "none";
  return link.version === version ? "current" : "stale";
}

/** A draft's `version` stamp: FNV-1a of its markdown. A user edit amends the
 *  current draft version in place without bumping `n`, so `n` alone cannot
 *  tell a link that still matches from one an edit has left behind. */
export function contentStamp(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function publishTitle(link: PublishedLink | null | undefined, version: number): string {
  switch (publishState(link, version)) {
    case "none": return "Publish to claude.ai (private until you Share it)";
    case "current": return `Copy claude.ai link (published as ${link!.account})`;
    case "stale": return `Update on claude.ai - changed since it was published (as ${link!.account})`;
  }
}

export function publishIcon(link: PublishedLink | null | undefined, version: number): string {
  return publishState(link, version) === "current" ? "ph-link" : "ph-cloud-arrow-up";
}

/** Menu-item wording, for surfaces that list publish as a text row. */
export function publishLabel(link: PublishedLink | null | undefined, version: number): string {
  switch (publishState(link, version)) {
    case "none": return "Publish to claude.ai";
    case "current": return "Copy claude.ai link";
    case "stale": return "Update on claude.ai";
  }
}

/** The publish icon button's markup. `data-publish` is the click hook. */
export function publishButtonHtml(link: PublishedLink | null | undefined, version: number, cls: string): string {
  const state = publishState(link, version);
  const icon = publishIcon(link, version);
  const title = publishTitle(link, version).replace(/"/g, "&quot;");
  return `<button type="button" class="${cls}" data-publish data-publish-state="${state}" title="${title}"><i class="ph ${icon}"></i></button>`;
}

function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, "");
}

async function copyLink(link: PublishedLink, verb: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
  } catch {
    // The toast still carries the link, and clicking it opens the page.
  }
  showToast(`${verb} as ${link.account}, link copied: ${shortUrl(link.url)} - click to open, then Share to let others in`, {
    ttlMs: 10000,
    onClick: () => void invoke("open_external", { url: link.url }),
  });
}

/** Publishes (or re-copies a link that is already current) and reports the
 *  outcome in a toast. `btn` spins and is disabled for the run. Returns the
 *  link on success; the daemon's change broadcast refreshes the stores. */
export async function publishToClaudeAi(
  params: PublishParams,
  existing: PublishedLink | null | undefined,
  version: number,
  btn: HTMLButtonElement | null,
): Promise<PublishedLink | null> {
  if (existing && publishState(existing, version) === "current") {
    await copyLink(existing, "Published");
    return existing;
  }
  const icon = btn?.querySelector("i");
  const prevIcon = icon?.className;
  // A menu item closes on click, so with no button left to spin the run
  // (up to a minute) would otherwise give no sign it started.
  if (!btn) showToast("Publishing to claude.ai...", { ttlMs: 4000 });
  if (btn) btn.disabled = true;
  if (icon) icon.className = "ph ph-circle-notch publish-spin";
  try {
    const link = await invoke<PublishedLink>("publish_to_claude_ai", { params });
    await copyLink(link, existing ? "Updated" : "Published privately");
    return link;
  } catch (err) {
    showToast(`Publish to claude.ai failed: ${String(err)}`, { ttlMs: 10000 });
    return null;
  } finally {
    if (btn) btn.disabled = false;
    if (icon && prevIcon) icon.className = prevIcon;
  }
}

// html:false so a draft can never smuggle markup into a page others open.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One fixed, readable page for a markdown draft (Joe picked a single clean
 *  template over a Claude-designed page, 2026-10-20). Follows the Artifact
 *  tool's page contract: colour tokens on :root with a dark-mode override,
 *  an explicit body background, and a 16px gutter at phone width. */
export function buildDraftPage(title: string, markdown: string): string {
  const safeTitle = escapeHtml(title.trim() || "Draft");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{--bg:#ffffff;--fg:#1d1d22;--muted:#5d5d6b;--rule:#e4e4ea;--code-bg:#f4f4f7;--link:#2f5fd0}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15151e;--fg:#e6e6ec;--muted:#a0a0b0;--rule:#2c2c3a;--code-bg:#1f1f2b;--link:#8fb0ff}}
:root[data-theme="dark"]{--bg:#15151e;--fg:#e6e6ec;--muted:#a0a0b0;--rule:#2c2c3a;--code-bg:#1f1f2b;--link:#8fb0ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:1.9rem;line-height:1.25;margin:0 0 24px}
h2{font-size:1.35rem;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
h3{font-size:1.1rem;margin:28px 0 8px}
p,ul,ol,blockquote,pre,table{margin:0 0 16px}
a{color:var(--link)}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:var(--code-bg);padding:.1em .35em;border-radius:4px}
pre{background:var(--code-bg);padding:12px 14px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{border-left:3px solid var(--rule);padding-left:14px;color:var(--muted)}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid var(--rule);padding:6px 10px;text-align:left}
hr{border:0;border-top:1px solid var(--rule);margin:28px 0}
img{max-width:100%}
</style>
</head>
<body>
<main>
<h1>${safeTitle}</h1>
${md.render(markdown)}
</main>
</body>
</html>
`;
}
