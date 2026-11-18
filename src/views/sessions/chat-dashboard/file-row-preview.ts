// A click on a file row in Links and files shows the file in the Preview panel
// (rendered by default, code on a switch, per pc-1747) instead of Code mode. The
// file chips elsewhere (transcript text, Changes card) keep opening Code mode.

import { invoke } from "../../../shared/ipc";
import { previewFile } from "../../../shared/preview-file";
import { openFileRef } from "../../../shared/chat/file-refs";
import { PREVIEW_OPEN_EVENT } from "../../../shared/chat/chat-preview-card";

/** A folder has no page to render; it keeps the old open. */
const isFolder = (path: string): boolean => /[\\/]$/.test(path);

export interface FileRowPreviewDeps {
  push: (args: { title: string; slug: string; html: string; source: string; session_id: string | null }) => Promise<unknown>;
  open: (slug: string) => void;
  fallback: (path: string) => void;
}

const realDeps: FileRowPreviewDeps = {
  push: (args) => invoke("push_preview", args),
  open: (slug) => window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug } })),
  fallback: (path) => openFileRef(path),
};

/** Pushes the file's page as a preview and opens it. The slug is the path, so
 *  clicking the same file again replaces its page in place. Any failure (the
 *  phone has no push_preview) falls back to the old open, never a dead click. */
export async function openFileInPreview(path: string, sessionId: string | null, deps: FileRowPreviewDeps = realDeps): Promise<void> {
  try {
    const r = await previewFile(path, sessionId ?? undefined);
    const slug = `file:${path}`;
    await deps.push({ title: r.title, slug, html: r.html, source: "chat", session_id: sessionId });
    deps.open(slug);
  } catch (err) {
    console.warn("[chat-dashboard] file preview failed; opening it the old way", err);
    deps.fallback(path);
  }
}

/** Registered before the shared file-ref handler: takes the event only for a
 *  file row's chip, so every other chip keeps its old behavior. */
export function handleFileRowEvent(e: MouseEvent | KeyboardEvent, sessionId: () => string | null, deps?: FileRowPreviewDeps): void {
  if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
  const chip = (e.target as Element | null)?.closest<HTMLElement>(".cdash-frow .file-ref");
  const path = chip?.dataset.path;
  if (!path || isFolder(path)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  void openFileInPreview(path, sessionId(), deps);
}
