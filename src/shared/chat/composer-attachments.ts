// Attachments controller for the Composer, split out of composer.ts (ai_todo
// 289), mirroring how ComposerPtt/ComposerVoice extract their own concerns.
// Owns the attachment + pasted-log-chip state, the .composer-attachments DOM,
// and clipboard-paste / file-input attach paths. Bound to elements via bind()
// on every Composer.render() (the DOM is fully rebuilt each time), with
// wireInteractive() re-attaching the file-input listener since the input
// element itself is recreated on each render.
//
// Note: attach-by-drop does NOT go through this module's DOM. Tauri v2
// intercepts native OS file drags before the browser's own dragover/drop
// events fire, so the working drop path is sessions.ts's `tauri://drag-drop`
// listener calling attachFromPath() directly. An earlier composer-local
// dragover/dragleave/drop listener (and the CSS drag-over state it drove) was
// dead code left over from before that fix landed; it was removed rather than
// moved here.

import { invoke } from "../ipc";
import { mimeToIcon } from "./attachment-hydrator";
import { openLightbox } from "./lightbox";
// tauri-plugin-clipboard-api pulls in valibot@0.40.0, which has a ReDoS in
// EMOJI_REGEX (GHSA-vqpr-j7v3-hqw9, valibot >=0.31.0 <1.2.0). Verified unreachable:
// v.emoji()/EMOJI_REGEX is never called anywhere in the plugin's guest-js source
// (only hasFiles/readFiles are imported here). Revisit if: the plugin bumps valibot
// to >=1.2.0, this file starts importing the plugin's monitor/listener API, or we
// migrate off this plugin.
import { hasFiles, readFiles } from "tauri-plugin-clipboard-api";
import { loadAttachmentsMeta, saveAttachmentsMeta, clearAttachmentsMeta } from "./composer-persistence";
import { decorateAttachmentChip, markAttachmentPop } from "./attachment-chip";
import { imageMimeFromPath } from "../image-mime";

export interface Attachment {
  mime: string;
  data: string; // base64 (no data: prefix); empty while a fresh pick is still being read
  path: string | null;
  filename: string; // original filename for display; derived from uuid path if absent
  /** Staged and shown, but its bytes are not on the daemon yet. A phone photo
   *  can take seconds to upload, and a chip that only appeared afterwards read
   *  as a failed pick and got picked again, sending the image twice. */
  uploading?: boolean;
}

/** A large text paste held as a collapsed "log" chip instead of being dumped
 * into the textarea. In-memory only; inlined into the message text on send. */
export interface PastedBlock {
  name: string;
  text: string;
}

// Paste payloads at or above this many characters become a pasted_log chip
// rather than landing as a wall of text in the textarea.
export const PASTE_LOG_THRESHOLD = 2000;

export interface ComposerAttachmentsCallbacks {
  /** Active session id, or null. Attachment metadata is persisted/read keyed
   * on this. */
  getSessionId: () => string | null;
  /** The paired machine a not-yet-started chat is aimed at, or null for a chat
   * on this machine. A pending pane's `pending-*` placeholder id is in no
   * machine's chat list, so the id alone cannot route an upload to the host
   * whose `claude` will Read the file; this does. */
  getMachineId?: () => string | null;
  /** Fired whenever the attachment/pasted-block set (re)renders, so the
   * composer can react (mirrors the old renderAttachments() ->
   * updateScheduleBtnState() call). */
  onChange: () => void;
}

export class ComposerAttachments {
  attachments: Attachment[] = [];
  pastedBlocks: PastedBlock[] = [];

  private cb: ComposerAttachmentsCallbacks;
  private attachmentsEl: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private inflight = new Set<Promise<void>>();

  constructor(cb: ComposerAttachmentsCallbacks) {
    this.cb = cb;
  }

  /** Re-query the DOM refs after a Composer.render() rebuild. */
  bind(root: HTMLElement): void {
    this.attachmentsEl = root.querySelector<HTMLElement>(".composer-attachments");
    this.fileInput = root.querySelector<HTMLInputElement>(".composer-file-input");
  }

  /** Re-attach listeners lost when the file input was recreated. Only called
   * while the composer is interactive (not read-only). */
  wireInteractive(): void {
    this.fileInput?.addEventListener("change", this.onFileInputChange);
  }

  isEmpty(): boolean {
    return this.attachments.length === 0 && this.pastedBlocks.length === 0;
  }

  isUploading(): boolean {
    return this.inflight.size > 0;
  }

  /** Resolves once every staged upload has settled, including any started
   *  while waiting, so a send never ships a chip that has no path yet. */
  async whenUploaded(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Open the native file picker (mobile "Attach image" menu entry). */
  openFilePicker(): void {
    if (!this.fileInput) return;
    this.fileInput.value = "";
    this.fileInput.click();
  }

  // Reads off the event's own target, not `this.fileInput` - a render()
  // between openFilePicker()'s click and the native picker resolving swaps in
  // a fresh empty input, and the field then silently sees zero files. Was the
  // mobile "picker opens, nothing attaches" bug (ai_todo 409).
  private onFileInputChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (!files?.length) return;
    void (async () => {
      await this.dropFiles(Array.from(files));
      target.value = "";
    })();
  };

  async handlePaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) return;
    const resolved = await resolveClipboardAttachments(e);
    if (resolved) {
      await Promise.all(resolved.map((r) =>
        r.kind === "path" ? this.attachFromPath(r.path) : this.attachBlob(r.blob, r.filename),
      ));
      return;
    }
    // A big plain-text paste becomes a collapsed log chip instead of a wall of
    // text in the textarea. Claude still receives the full text inline on send.
    const text = e.clipboardData.getData("text/plain");
    if (text && text.length >= PASTE_LOG_THRESHOLD) {
      e.preventDefault();
      this.addPastedBlock(text);
    }
  }

  private addPastedBlock(text: string): void {
    const n = this.pastedBlocks.length;
    const name = n === 0 ? "pasted_log.txt" : `pasted_log_${n + 1}.txt`;
    this.pastedBlocks.push({ name, text });
    this.render();
  }

  /** `{ machineId }` only when the chat is aimed at another machine, so a
   * local composer's invoke args stay byte-identical to before. */
  private machineArg(): { machineId?: string } {
    const machineId = this.cb.getMachineId?.();
    return machineId ? { machineId } : {};
  }

  async attachBlob(blob: Blob, filename: string): Promise<void> {
    const mime = blob.type || "application/octet-stream";
    await this.stage({ mime, data: "", path: null, filename }, async (a) => {
      a.data = await blobToBase64(blob);
      this.render();
      const sessionId = this.cb.getSessionId();
      if (!sessionId) return;
      try {
        a.path = await invoke<string>("paste_attachment", {
          sessionId,
          base64Data: a.data,
          mime,
          ...this.machineArg(),
        });
      } catch (err) {
        console.warn("[Composer] paste_attachment not available:", err);
      }
    });
  }

  async attachFromPath(srcPath: string): Promise<void> {
    const filename = srcPath.split(/[\\/]/).pop() ?? srcPath;
    // Guessed so the placeholder already has the image tile's shape; the
    // daemon's answer below replaces it.
    const mime = imageMimeFromPath(srcPath) ?? "application/octet-stream";
    await this.stage({ mime, data: "", path: null, filename }, async (a) => {
      const sessionId = this.cb.getSessionId();
      try {
        if (sessionId) {
          const result = await invoke<{ path: string; mime: string; base64: string }>(
            "paste_attachment_from_path",
            { sessionId, path: srcPath, ...this.machineArg() },
          );
          a.mime = result.mime;
          a.data = result.base64;
          a.path = result.path;
          return;
        }
      } catch (err) {
        console.warn("[Composer] paste_attachment_from_path failed:", err);
      }
      // No bytes: the guessed image mime would render a blank tile, while a
      // file chip still names what failed to attach.
      a.mime = "application/octet-stream";
    });
  }

  /** Shows `a` at once as an uploading chip, then runs `work` to fill in its
   *  bytes and path. Removing the chip mid-upload just detaches the object, so
   *  the late result lands nowhere. */
  private async stage(a: Attachment, work: (a: Attachment) => Promise<void>): Promise<void> {
    a.uploading = true;
    markAttachmentPop(a);
    this.attachments.push(a);
    this.render();
    const done = work(a)
      .catch((err) => {
        // Bytes never read, so there is nothing to show or send.
        const idx = this.attachments.indexOf(a);
        if (idx >= 0) this.attachments.splice(idx, 1);
        throw err;
      })
      .finally(() => {
        a.uploading = false;
        this.inflight.delete(done);
        this.render();
        this.persist();
      });
    this.inflight.add(done);
    await done;
  }

  async dropFiles(files: Iterable<File>): Promise<void> {
    // Not sequential: every pick shows its chip now, not after the one before
    // it finishes uploading.
    await Promise.all(Array.from(files, (file) => this.attachBlob(file, file.name)));
  }

  render(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.innerHTML = "";
    this.attachments.forEach((a) => {
      const div = document.createElement("div");
      const isImage = a.mime.startsWith("image/");
      div.className = `attachment${isImage ? "" : " file-chip"}`;

      if (isImage) {
        // No <img> until the bytes are read: the tile shows the upload spinner alone.
        if (a.data) {
          const img = document.createElement("img");
          img.src = `data:${a.mime};base64,${a.data}`;
          img.alt = a.filename;
          img.addEventListener("click", () => openLightbox({ type: "image", mime: a.mime, base64: a.data, filename: a.filename }));
          div.appendChild(img);
        }
      } else {
        const icon = mimeToIcon(a.mime);
        div.innerHTML = `<i class="ph ${icon}"></i>`;
        const label = document.createElement("span");
        label.textContent = a.filename;
        div.appendChild(label);
        div.addEventListener("click", () => openPreviewIfSupported(a));
      }
      decorateAttachmentChip(div, a);

      const rm = document.createElement("button");
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = this.attachments.indexOf(a);
        if (idx >= 0) this.attachments.splice(idx, 1);
        this.render();
        this.persist();
      });
      div.appendChild(rm);
      this.attachmentsEl!.appendChild(div);
    });

    this.pastedBlocks.forEach((b, i) => {
      const div = document.createElement("div");
      div.className = "attachment file-chip pasted-log";
      div.title = "Pasted text — click to view";
      div.innerHTML = `<i class="ph ph-file-text"></i>`;
      const label = document.createElement("span");
      label.textContent = b.name;
      div.appendChild(label);
      div.addEventListener("click", () =>
        openLightbox({ type: "text", content: b.text, filename: b.name }),
      );

      const rm = document.createElement("button");
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pastedBlocks.splice(i, 1);
        this.render();
      });
      div.appendChild(rm);
      this.attachmentsEl!.appendChild(div);
    });
    this.cb.onChange();
  }

  /** Reset both the attachment and pasted-log sets and persist the (empty)
   * result. Called on send/clear and on setDraftText. */
  clear(): void {
    this.attachments = [];
    this.pastedBlocks = [];
    this.render();
    this.persist();
  }

  /** Undo a `clear()` after a failed send: puts the attachments/pasted blocks
   * back so the user doesn't lose what they had staged. */
  restoreDraft(attachments: Attachment[], pastedBlocks: PastedBlock[]): void {
    this.attachments = attachments;
    this.pastedBlocks = pastedBlocks;
    this.render();
    this.persist();
  }

  persist(): void {
    const sessionId = this.cb.getSessionId();
    if (!sessionId) return;
    const metas = this.attachments
      .filter((a): a is Attachment & { path: string } => typeof a.path === "string" && a.path.length > 0)
      .map(a => ({ path: a.path, mime: a.mime, filename: a.filename }));
    if (metas.length) saveAttachmentsMeta(sessionId, metas);
    else clearAttachmentsMeta(sessionId);
  }

  /** Re-read any persisted attachment metadata for `sessionId` from disk (the
   * base64 bytes aren't stored in localStorage, only path/mime/filename).
   * Async, so it's raced against further session switches: bails if the
   * active session moved on before it resolves. */
  async hydrate(sessionId: string): Promise<void> {
    const metas = loadAttachmentsMeta(sessionId);
    if (metas.length === 0) return;
    const existingPaths = new Set(this.attachments.map(a => a.path).filter(Boolean));
    const restored: Attachment[] = [];
    for (const m of metas) {
      if (existingPaths.has(m.path)) continue;
      try {
        const r = await invoke<{ mime: string; base64: string }>("read_attachment", {
          path: m.path,
          ...this.machineArg(),
        });
        restored.push({ mime: m.mime || r.mime, data: r.base64, path: m.path, filename: m.filename });
      } catch {
        // Backing file gone (GC'd or deleted). Drop silently.
      }
    }
    if (this.cb.getSessionId() !== sessionId) return;
    if (restored.length === 0) {
      // All metas turned out to be dead; clean the LS entry.
      const stillHave = this.attachments.some(a => a.path && metas.find(m => m.path === a.path));
      if (!stillHave) clearAttachmentsMeta(sessionId);
      return;
    }
    this.attachments = [...this.attachments, ...restored];
    this.render();
    this.persist();
  }

  /** Migrate persisted attachment metadata when a pending placeholder session
   * id swaps to its real id (setSessionId's rename path). */
  migrateSession(prevId: string, newId: string): void {
    const prevAttMeta = loadAttachmentsMeta(prevId);
    if (prevAttMeta.length && loadAttachmentsMeta(newId).length === 0) {
      saveAttachmentsMeta(newId, prevAttMeta);
    }
    clearAttachmentsMeta(prevId);
  }
}

function openPreviewIfSupported(a: Attachment): void {
  if (!a.data) return;
  if (a.mime === "application/pdf") {
    openLightbox({ type: "pdf", base64: a.data, filename: a.filename });
  } else if (a.mime.startsWith("text/") || a.mime === "application/json") {
    try {
      const text = atob(a.data);
      openLightbox({ type: "text", content: text, filename: a.filename });
    } catch {
      /* non-UTF8 content, no preview */
    }
  }
}

/** True when a clipboard event's DataTransfer carries at least one file item.
 *  Shared by the composer's stray-paste relay (which only needs the boolean
 *  to decide routing) and `resolveClipboardAttachments` below (which needs
 *  the same filter to build the actual blob list) - one predicate, two
 *  different consumption shapes (ai_todo 877). */
export function clipboardHasFile(dt: DataTransfer | null): boolean {
  return Array.from(dt?.items ?? []).some((it) => it.kind === "file");
}

/** A clipboard file item, resolved to either a native OS path (Explorer
 *  copy, read via the clipboard plugin) or a raw blob (e.g. a Win+Shift+S
 *  snip, which has no CF_HDROP path). */
export type ResolvedClipboardAttachment =
  | { kind: "path"; path: string }
  | { kind: "blob"; blob: File; filename: string };

/** Resolve a paste ClipboardEvent's file items into native paths or blobs -
 *  the branching shared by `ComposerAttachments.handlePaste` and the AUQ
 *  card's own paste handler (ai_todo 440: same logic, two separate callers,
 *  since AuqAttachment's persistence deliberately stays separate from
 *  Attachment's - see AuqAttachment's doc comment). Pure: does not call the
 *  `paste_attachment*` IPC itself, does not persist anything - each caller
 *  turns the result into its own stored shape. Returns `null` for a
 *  paste with no file items at all (a plain-text paste), so a caller that
 *  wants a pasted-log-chip fallback (the composer) or wants to no-op (the
 *  AUQ card, which has none) can each handle that on their own. */
export async function resolveClipboardAttachments(
  e: ClipboardEvent,
): Promise<ResolvedClipboardAttachment[] | null> {
  if (!e.clipboardData) return null;
  if (!clipboardHasFile(e.clipboardData)) return null;
  // Snapshot the browser blobs SYNCHRONOUSLY, before any await: WebView2
  // neuters e.clipboardData the moment this handler yields, so getAsFile()
  // returns null afterwards. This is the fallback for pastes with no native
  // file list (e.g. a Win+Shift+S snip, which lands as a raw bitmap on the
  // clipboard with no CF_HDROP paths). Capturing here keeps that path alive.
  // No separate file-kind filter needed: a non-file item's getAsFile()
  // already returns null per spec, so the blob !== null filter below covers it.
  const blobs = Array.from(e.clipboardData.items)
    .map((item) => ({ blob: item.getAsFile(), type: item.type }))
    .filter((b): b is { blob: File; type: string } => b.blob !== null);
  if (blobs.length === 0) return null;
  e.preventDefault();
  // The browser's DataTransfer only ever exposes one file when multiple files
  // are copied from Explorer (a WebView2 limitation), so read the native
  // clipboard file list directly when available. Falls back to the blob(s)
  // snapshotted above when the plugin call fails or finds no file list
  // (non-Windows, view-harness, or a bitmap snip with no paths).
  try {
    if (await hasFiles()) {
      const paths = await readFiles();
      if (paths.length > 0) {
        const resolved: ResolvedClipboardAttachment[] = paths.map((path) => ({ kind: "path", path }));
        return resolved;
      }
    }
  } catch (err) {
    console.warn("[resolveClipboardAttachments] clipboard readFiles failed, falling back to blob paste:", err);
  }
  const resolved: ResolvedClipboardAttachment[] = blobs.map(({ blob, type }) => ({
    kind: "blob",
    blob,
    filename: blob.name || `paste.${type.split("/")[1] ?? "bin"}`,
  }));
  return resolved;
}

/** Exported so other paste-image surfaces (e.g. the AUQ card) can reuse the
 *  same base64 conversion without duplicating it. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
