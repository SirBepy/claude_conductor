// Pasted-image attachment handling for the AUQ card, split out of
// question-ui.ts (ai_todo 439/440). Owns the AuqAttachment[] array and the
// paste/attach/render mechanics; parameterized by sessionId + supportsExtras
// + a render callback rather than reaching into question-ui.ts's closures
// directly, so it's a plain factory function (not a class - there's no
// lifecycle here beyond "call the callback after every mutation").
//
// AuqAttachment stays a separate shape/storage from the composer's own
// Attachment (shared/chat/composer-attachments.ts) - see AuqAttachment's doc
// comment in types.ts for why (localStorage draft persistence keyed by
// session id would collide). Only the clipboard-RESOLUTION logic (native
// path vs blob fallback) is shared, via resolveClipboardAttachments.

import { invoke } from "../../../shared/ipc";
import { blobToBase64, resolveClipboardAttachments } from "../../../shared/chat/composer-attachments";
import { mimeToIcon } from "../../../shared/chat/attachment-hydrator";
import { openLightbox } from "../../../shared/chat/lightbox";
import { downscaleImage } from "./image-downscale";
import type { AuqAttachment } from "./types";

// Per-draft raw-byte budget (sum across every staged attachment). A realistic
// pasted screenshot is 3-8MB raw; 8MB fits 1-2 full-res shots or several
// downscaled ones, bounding daemon disk usage and hydrate-fetch time.
const MAX_DRAFT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Downscale target for attachBlob - see image-downscale.ts's quality steps.
const DOWNSCALE_TARGET_BYTES = 1_500_000;

function capMessage(): string {
  const mb = (MAX_DRAFT_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
  return `Can't attach: this draft's images already total ${mb} MB, the per-draft limit.`;
}

export interface AuqAttachmentsOpts {
  sessionId?: string;
  /** Paste attaches nothing when false - only the async MCP flow can deliver
   *  attachments to Claude (see QuestionUIOpts.supportsExtras's doc). Still
   *  reported back to the caller as a message (not a silent no-op). */
  supportsExtras?: boolean;
  initial?: AuqAttachment[];
  /** Panel index the card is currently showing, read at attach time so an
   *  image stays on the step it was pasted into. */
  currentPanel?: () => number;
  /** Called after every mutation (attach/remove) to trigger a re-render. */
  onChange: () => void;
}

export interface AuqAttachmentsController {
  /** Live reference - copy it (`[...attachments]`) before stashing a
   *  snapshot (e.g. a draft). */
  readonly attachments: AuqAttachment[];
  /** Returns null on success, or a rejection message (over the per-draft cap). */
  attachBlob(blob: Blob, filename: string): Promise<string | null>;
  attachFromPath(srcPath: string): Promise<string | null>;
  /** The subset staged from `panel`. A pre-stamp draft entry counts as panel 0. */
  attachmentsForPanel(panel: number): AuqAttachment[];
  /** Wired onto every free-text input (per-question + review-step) so an
   *  image can be pasted from any step. Returns null for a plain-text paste
   *  or on success; otherwise a message to surface (unsupported card, over cap). */
  handleAttachmentPaste(e: ClipboardEvent): Promise<string | null>;
  renderAttachmentsStrip(container: HTMLElement, panel: number): void;
}

export function createAuqAttachments(opts: AuqAttachmentsOpts): AuqAttachmentsController {
  const attachments: AuqAttachment[] = opts.initial ? [...opts.initial] : [];
  hydrateMissingData();

  // A restored draft carries path+size only, no base64 (see
  // draft-persistence.ts) - backfill `data` from the daemon's on-disk copy.
  // Fire-and-forget; a dead path (file GC'd) just stays un-renderable, same
  // as composer-attachments.ts's hydrate().
  function hydrateMissingData(): void {
    const stale = attachments.filter((a) => a.path && !a.data);
    if (!stale.length) return;
    void (async () => {
      for (const a of stale) {
        try {
          const r = await invoke<{ mime: string; base64: string }>("read_attachment", { path: a.path });
          a.data = r.base64;
          a.mime = a.mime || r.mime;
        } catch (err) {
          console.warn("[AUQ] read_attachment hydrate failed:", err);
        }
      }
      opts.onChange();
    })();
  }

  function panelOf(a: AuqAttachment): number {
    return a.panel ?? 0;
  }

  function attachmentsForPanel(panel: number): AuqAttachment[] {
    return attachments.filter((a) => panelOf(a) === panel);
  }

  function stagePanel(): number {
    return opts.currentPanel?.() ?? 0;
  }

  function attachedBytes(): number {
    return attachments.reduce((sum, a) => sum + a.size, 0);
  }

  async function attachBlob(blob: Blob, filename: string): Promise<string | null> {
    const toStage = blob.type.startsWith("image/") && blob.size > DOWNSCALE_TARGET_BYTES
      ? await downscaleImage(blob, DOWNSCALE_TARGET_BYTES)
      : blob;
    if (attachedBytes() + toStage.size > MAX_DRAFT_ATTACHMENT_BYTES) return capMessage();
    const data = await blobToBase64(toStage);
    const mime = toStage.type || "application/octet-stream";
    // A downscale re-encodes as JPEG - rename so it doesn't claim .png.
    const displayName = toStage !== blob && mime === "image/jpeg" && !/\.jpe?g$/i.test(filename)
      ? filename.replace(/\.\w+$/, "") + ".jpg"
      : filename;
    let path: string | null = null;
    if (opts.sessionId) {
      try {
        path = await invoke<string>("paste_attachment", {
          sessionId: opts.sessionId,
          base64Data: data,
          mime,
        });
      } catch (err) {
        console.warn("[AUQ] paste_attachment failed:", err);
      }
    }
    attachments.push({ mime, data, path, filename: displayName, size: toStage.size, panel: stagePanel() });
    opts.onChange();
    return null;
  }

  async function attachFromPath(srcPath: string): Promise<string | null> {
    const filename = srcPath.split(/[\\/]/).pop() ?? srcPath;
    let result: { path: string; mime: string; base64: string } | null = null;
    if (opts.sessionId) {
      try {
        result = await invoke<{ path: string; mime: string; base64: string }>(
          "paste_attachment_from_path",
          { sessionId: opts.sessionId, path: srcPath },
        );
      } catch (err) {
        console.warn("[AUQ] paste_attachment_from_path failed:", err);
      }
    }
    // Rust already wrote the full file by the time base64 comes back, so a
    // cap rejection here leaves an orphan on disk - acceptable, same GC-later
    // tradeoff composer-attachments.ts's hydrate() already documents.
    const size = result ? Math.floor((result.base64.length * 3) / 4) : 0;
    if (size > 0 && attachedBytes() + size > MAX_DRAFT_ATTACHMENT_BYTES) return capMessage();
    attachments.push({
      filename,
      mime: result?.mime ?? "application/octet-stream",
      data: result?.base64 ?? "",
      path: result?.path ?? null,
      size,
      panel: stagePanel(),
    });
    opts.onChange();
    return null;
  }

  async function handleAttachmentPaste(e: ClipboardEvent): Promise<string | null> {
    const hasFile = Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === "file");
    if (!hasFile) return null;
    if (!opts.supportsExtras) return "This card can't accept attachments.";
    const resolved = await resolveClipboardAttachments(e);
    if (!resolved) return null;
    for (const r of resolved) {
      const msg = r.kind === "path" ? await attachFromPath(r.path) : await attachBlob(r.blob, r.filename);
      if (msg) return msg;
    }
    return null;
  }

  // Only this panel's own attachments - every panel used to render the whole
  // array, so one pasted image appeared on all of them at once.
  function renderAttachmentsStrip(container: HTMLElement, panel: number): void {
    container.innerHTML = "";
    attachments.forEach((a) => {
      if (panelOf(a) !== panel) return;
      const div = document.createElement("div");
      const isImage = a.mime.startsWith("image/");
      div.className = `attachment${isImage ? "" : " file-chip"}`;
      if (isImage && a.data) {
        const img = document.createElement("img");
        img.src = `data:${a.mime};base64,${a.data}`;
        img.alt = a.filename;
        img.addEventListener("click", () => openLightbox({ type: "image", mime: a.mime, base64: a.data, filename: a.filename }));
        div.appendChild(img);
      } else {
        const icon = mimeToIcon(a.mime);
        div.innerHTML = `<i class="ph ${icon}"></i>`;
        const label = document.createElement("span");
        label.textContent = a.filename;
        div.appendChild(label);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = attachments.indexOf(a);
        if (idx >= 0) attachments.splice(idx, 1);
        opts.onChange();
      });
      div.appendChild(rm);
      container.appendChild(div);
    });
  }

  return { attachments, attachBlob, attachFromPath, attachmentsForPanel, handleAttachmentPaste, renderAttachmentsStrip };
}
