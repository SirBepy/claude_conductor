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
import type { AuqAttachment } from "./types";

export interface AuqAttachmentsOpts {
  sessionId?: string;
  /** Paste is a no-op when false - only the async MCP flow can deliver
   *  attachments to Claude (see QuestionUIOpts.supportsExtras's doc). */
  supportsExtras?: boolean;
  initial?: AuqAttachment[];
  /** Called after every mutation (attach/remove) to trigger a re-render. */
  onChange: () => void;
}

export interface AuqAttachmentsController {
  /** Live reference - copy it (`[...attachments]`) before stashing a
   *  snapshot (e.g. a draft). */
  readonly attachments: AuqAttachment[];
  attachBlob(blob: Blob, filename: string): Promise<void>;
  attachFromPath(srcPath: string): Promise<void>;
  /** Wired onto every free-text input (per-question + review-step) so an
   *  image can be pasted from any step, same as the composer. No-op when
   *  the paste has no file items (a plain-text paste) - the AUQ card has no
   *  pasted-log-chip fallback, unlike the composer. */
  handleAttachmentPaste(e: ClipboardEvent): Promise<void>;
  renderAttachmentsStrip(container: HTMLElement): void;
}

export function createAuqAttachments(opts: AuqAttachmentsOpts): AuqAttachmentsController {
  const attachments: AuqAttachment[] = opts.initial ? [...opts.initial] : [];

  async function attachBlob(blob: Blob, filename: string): Promise<void> {
    const data = await blobToBase64(blob);
    let path: string | null = null;
    if (opts.sessionId) {
      try {
        path = await invoke<string>("paste_attachment", {
          sessionId: opts.sessionId,
          base64Data: data,
          mime: blob.type || "application/octet-stream",
        });
      } catch (err) {
        console.warn("[AUQ] paste_attachment failed:", err);
      }
    }
    attachments.push({ mime: blob.type || "application/octet-stream", data, path, filename });
    opts.onChange();
  }

  async function attachFromPath(srcPath: string): Promise<void> {
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
    attachments.push({
      filename,
      mime: result?.mime ?? "application/octet-stream",
      data: result?.base64 ?? "",
      path: result?.path ?? null,
    });
    opts.onChange();
  }

  async function handleAttachmentPaste(e: ClipboardEvent): Promise<void> {
    if (!opts.supportsExtras) return;
    const resolved = await resolveClipboardAttachments(e);
    if (!resolved) return;
    for (const r of resolved) {
      if (r.kind === "path") await attachFromPath(r.path);
      else await attachBlob(r.blob, r.filename);
    }
  }

  function renderAttachmentsStrip(container: HTMLElement): void {
    container.innerHTML = "";
    attachments.forEach((a, i) => {
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
        attachments.splice(i, 1);
        opts.onChange();
      });
      div.appendChild(rm);
      container.appendChild(div);
    });
  }

  return { attachments, attachBlob, attachFromPath, handleAttachmentPaste, renderAttachmentsStrip };
}
