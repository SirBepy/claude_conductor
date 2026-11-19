// `previewFile(path)`: one entry that turns a file on disk into the page the
// Preview panel shows. Markdown renders through `renderMarkdown` (so the
// blockquote-is-a-quote rule holds) with a Source switch, an image shows as an
// image, anything else is code, and a missing, unreadable or binary file is a
// plain error page rather than a blank panel. The document builder lives with
// the panel's other documents (views/sessions/preview-panel-document.ts); this
// file only reads and classifies. A dashboard file row opens it through
// views/sessions/chat-dashboard/file-row-preview.ts.

import { invoke } from "./ipc";
import { renderMarkdown } from "./chat/chat-transforms";
import { markdownForDisplay } from "./chat/file-surface";
import { basename } from "./path-utils";
import { buildFilePreviewHtml, type FileDocument } from "../views/sessions/preview-panel-document";
import type { TextFileData } from "../types/ipc.generated";

export type PreviewFileKind = FileDocument["kind"];

export interface FilePreviewResult {
  kind: PreviewFileKind;
  /** The file's name, for a panel title. */
  title: string;
  /** The page to push into the Preview panel. */
  html: string;
}

// The extensions `read_image_file` knows a MIME for (attachments.rs `mime_for_ext`); an
// image format outside it would come back as octet-stream and draw a broken picture.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
// Binary formats that `read_text_file` would lossily decode into replacement characters.
const BINARY_EXT = new Set([
  "pdf", "zip", "gz", "tgz", "7z", "rar", "tar", "exe", "dll", "so", "dylib", "bin", "o", "obj", "class", "jar", "wasm",
  "ico", "avif", "heic", "tif", "tiff", "psd", "mp3", "wav", "ogg", "flac", "mp4", "mov", "mkv", "webm", "avi",
  "ttf", "otf", "woff", "woff2", "sqlite", "db", "docx", "xlsx", "pptx", "iso", "dmg",
]);

function extOf(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/** A file read as text is binary when it holds NUL bytes (no text encoding emits them)
 *  or is mostly replacement characters from a lossy decode. Looks at the first 8000 chars only. */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 8000);
  if (head.includes("\0")) return true;
  if (head.length === 0) return false;
  let bad = 0;
  for (const ch of head) if (ch === "�") bad++;
  return bad / head.length > 0.1;
}

function errorDoc(path: string, message: string): FileDocument {
  return { kind: "error", path, message };
}

function describeError(path: string, err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  if (/not found|no such file|cannot find|os error 2|os error 3/i.test(raw)) return `${basename(path)} was not found. It may have been moved or deleted.`;
  return `${basename(path)} could not be read: ${raw}`;
}

async function loadImage(path: string, sessionId?: string): Promise<FileDocument> {
  const data = await invoke<{ mime: string; base64: string }>("read_image_file", { path, sessionId: sessionId ?? null });
  if (!data.mime.startsWith("image/")) return errorDoc(path, `${basename(path)} is not an image this preview can show.`);
  return { kind: "image", path, src: `data:${data.mime};base64,${data.base64}` };
}

async function loadText(path: string): Promise<FileDocument> {
  const data = await invoke<TextFileData>("read_text_file", { path });
  if (looksBinary(data.content)) return errorDoc(path, `${basename(path)} is a binary file, so there is nothing to show as text.`);
  if (MARKDOWN_EXT.has(extOf(path))) {
    const source = markdownForDisplay(data.content);
    return { kind: "markdown", path, source, renderedHtml: renderMarkdown(source), truncated: data.truncated };
  }
  return { kind: "code", path, source: data.content, truncated: data.truncated };
}

/** Reads `path` and picks its view by extension. Never throws: a failure is an `error` document. */
export async function loadFileDocument(path: string, sessionId?: string): Promise<FileDocument> {
  const ext = extOf(path);
  try {
    if (IMAGE_EXT.has(ext)) return await loadImage(path, sessionId);
    if (BINARY_EXT.has(ext)) return errorDoc(path, `${basename(path)} is a binary file, so there is nothing to show as text.`);
    return await loadText(path);
  } catch (err) {
    return errorDoc(path, describeError(path, err));
  }
}

/** The page for `path`, ready to push into the Preview panel. */
export async function previewFile(path: string, sessionId?: string): Promise<FilePreviewResult> {
  const doc = await loadFileDocument(path, sessionId);
  return { kind: doc.kind, title: basename(path), html: buildFilePreviewHtml(doc) };
}
