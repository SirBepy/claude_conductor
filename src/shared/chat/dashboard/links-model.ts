// What the dashboard's Links and files card and Changes card read from a chat's
// own rows (docs/chat-dashboard-design.md, "Extra content and quick views").
// There is no Links store: everything is derived on render from send_message
// text and details, pr_preview drafts and the file tools' inputs, so reload,
// older pages and a respawned chat all give the same card. Pure: no DOM.

import type { RenderedMessage } from "../chat-classifiers";
import { detectPrPreviewToken } from "../chat-classifiers";
import { findFileRefs } from "../file-ref-match";

export type LinkKind = "pr" | "ci" | "ticket" | "link" | "draft";

export interface LinkItem {
  /** Null for a PR draft, which has a title but no address yet. */
  url: string | null;
  label: string;
  kind: LinkKind;
}

export interface FileItem {
  path: string;
  /** Edited or written by the chat itself, as opposed to only named in a message. */
  touched: boolean;
}

export interface ChangedFile {
  path: string;
  edits: number;
}

export const LINKS_SHOWN = 8;
export const FILES_SHOWN = 8;

const URL_RE = /https?:\/\/[^\s<>"'`\])]+/g;
/** Sentence punctuation that closes a URL in prose is not part of it. */
const TRAILING_RE = /[.,;:!?]+$/;

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function classifyUrl(url: string): { kind: LinkKind; label: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: "link", label: url };
  }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname;
  if (host === "github.com") {
    const repo = /^\/([^/]+\/[^/]+)/.exec(path)?.[1] ?? "";
    const pr = /\/pull\/(\d+)/.exec(path);
    if (pr) return { kind: "pr", label: `PR #${pr[1]}${repo ? ` in ${repo}` : ""}` };
    const run = /\/actions\/runs\/(\d+)/.exec(path);
    if (run) return { kind: "ci", label: `CI run ${run[1]}${repo ? ` in ${repo}` : ""}` };
    const issue = /\/issues\/(\d+)/.exec(path);
    if (issue) return { kind: "ticket", label: `Issue #${issue[1]}${repo ? ` in ${repo}` : ""}` };
    const commit = /\/commit\/([0-9a-f]{7,40})/.exec(path);
    if (commit) return { kind: "link", label: `Commit ${commit[1]!.slice(0, 8)}` };
  }
  const linear = /\/issue\/([A-Za-z]+-\d+)/.exec(path);
  if (host === "linear.app" && linear) return { kind: "ticket", label: linear[1]!.toUpperCase() };
  const story = /\/story\/(\d+)/.exec(path);
  if (host.endsWith("shortcut.com") && story) return { kind: "ticket", label: `Story ${story[1]}` };
  const jira = /\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(path);
  if (host.endsWith("atlassian.net") && jira) return { kind: "ticket", label: jira[1]!.toUpperCase() };
  if (host === "trello.com" && path.startsWith("/c/")) return { kind: "ticket", label: "Trello card" };
  const short = path === "/" ? "" : path.length > 40 ? `${path.slice(0, 39)}...` : path;
  return { kind: "link", label: `${host}${short}` };
}

/** Every string of a message worth scanning: its text, its drill-down bodies
 *  and the rows of its card. */
function textsOf(m: RenderedMessage): string[] {
  const out: string[] = [];
  if (m.text) out.push(m.text);
  for (const d of m.details ?? []) out.push(d.body_md);
  const c = m.card;
  if (c) out.push(...(c.points ?? []), ...(c.done ?? []), ...(c.notDone ?? []), ...(c.waitingOn ?? []), ...(c.yourMove ?? []));
  return out;
}

/** A send_message the main agent wrote that draws: scanned for links and files. */
function isScannable(m: RenderedMessage): boolean {
  return m.kind === "message" && !m.failed && !m.retracted && !m.subCard && m.card?.kind !== "ack";
}

function draftTitle(m: RenderedMessage): string | null {
  if (m.kind !== "assistant") return null;
  for (const b of m.content ?? []) {
    if (b.type !== "text") continue;
    const t = detectPrPreviewToken(b.text);
    if (t) return t.title.trim() || "Untitled";
  }
  return null;
}

function normUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Links the chat produced, newest first, each address once. */
export function extractLinks(msgs: readonly RenderedMessage[]): LinkItem[] {
  const seen = new Set<string>();
  const out: LinkItem[] = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < LINKS_SHOWN; i--) {
    const m = msgs[i]!;
    const draft = draftTitle(m);
    if (draft) {
      const key = `draft:${draft}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ url: null, label: `PR draft: ${draft}`, kind: "draft" });
      }
      continue;
    }
    if (!isScannable(m)) continue;
    // Later text in a message beats earlier text, matching "newest first".
    const urls = textsOf(m).flatMap((t) => t.match(URL_RE) ?? []).map((u) => u.replace(TRAILING_RE, "")).reverse();
    for (const url of urls) {
      const key = normUrl(url);
      if (seen.has(key) || out.length >= LINKS_SHOWN) continue;
      seen.add(key);
      out.push({ url, ...classifyUrl(url) });
    }
  }
  return out;
}

function editedPath(m: RenderedMessage): string | null {
  if (m.kind !== "tool_use" || !m.tool || !EDIT_TOOLS.has(m.tool) || m.parentToolUseId) return null;
  const o = (m.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
  const p = typeof o.file_path === "string" ? o.file_path : typeof o.notebook_path === "string" ? o.notebook_path : "";
  return p || null;
}

/** One key per file however the chat spelled it: case and slash direction do not
 *  matter on Windows, and `extractFiles` and `changedFiles` must agree. */
export function pathKey(path: string): string {
  return path.toLowerCase().replace(/\\/g, "/");
}

/** Files the chat touched or named, newest first, each path once. A path the
 *  chat edited counts as touched even if it was only named earlier. */
export function extractFiles(msgs: readonly RenderedMessage[]): FileItem[] {
  const byPath = new Map<string, FileItem>();
  const order: string[] = [];
  const add = (path: string, touched: boolean): void => {
    const key = pathKey(path);
    const had = byPath.get(key);
    if (had) {
      if (touched) had.touched = true;
      return;
    }
    byPath.set(key, { path, touched });
    order.push(key);
  };
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const edited = editedPath(m);
    if (edited) {
      add(edited, true);
      continue;
    }
    if (!isScannable(m)) continue;
    for (const t of textsOf(m)) for (const ref of findFileRefs(t)) add(ref.path, false);
  }
  return order.slice(0, FILES_SHOWN).map((k) => byPath.get(k)!);
}

/** Files the chat edited at or after row `from`, with how many edits each took,
 *  most edited first. */
export function changedFiles(msgs: readonly RenderedMessage[], from: number): ChangedFile[] {
  const counts = new Map<string, ChangedFile>();
  for (let i = Math.max(0, from); i < msgs.length; i++) {
    const p = editedPath(msgs[i]!);
    if (!p) continue;
    const key = pathKey(p);
    const hit = counts.get(key);
    if (hit) hit.edits += 1;
    else counts.set(key, { path: p, edits: 1 });
  }
  return [...counts.values()].sort((a, b) => b.edits - a.edits);
}
