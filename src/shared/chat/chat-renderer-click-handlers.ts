import { invoke } from "../ipc";
import { renderBlocks } from "./chat-transforms";
import type { ChatEvent } from "../../types/ipc.generated";
import { openFileViewer } from "./file-viewer";
import { getScreenshotRowShots } from "./screenshot-row";
import { collectChatImages } from "./chat-image-gallery-data";
import { openChatImageGallery } from "./chat-image-gallery";
import { openLightbox } from "./lightbox";
import { onWaitingChipClick } from "./turn-chips";
import { getCta } from "./cta-registry";
import { PREVIEW_OPEN_EVENT } from "./chat-preview-card";
import type { ChatRenderer } from "./chat-renderer";

/** Delegated `click` handlers for `ChatRenderer`'s container. Each factory
 *  closes over the renderer instance and is wired in the constructor - split
 *  out of chat-renderer.ts (todo 745) since these are DOM interaction, not
 *  event-stream lifecycle. Pure move, same bodies as before. */

/** Tapping an inline rendered image block (screenshots, image tool results)
 *  opens the chat-wide gallery at that image, resolved by element identity -
 *  the collector binds every inline render to the slot it collected for it. */
export function createHandleBlockImageClick(renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const img = (e.target as Element).closest<HTMLImageElement>("img.block.image");
    if (!img) return;
    const collection = collectChatImages(renderer.messages, renderer.messageEls);
    const foundIndex = collection.byElement.get(img);
    if (foundIndex !== undefined) {
      openChatImageGallery(collection, foundIndex);
      return;
    }
    const match = /^data:([^;]+);base64,(.+)$/.exec(img.src);
    const mime = match?.[1];
    const base64 = match?.[2];
    if (!mime || !base64) return;
    // Loud on purpose (todo 740): the silent lightbox fallback is what let a
    // broken gallery look correct for a whole release.
    console.error("[chat-renderer] inline image is not in the gallery collection, falling back to the lightbox", img);
    openLightbox({ type: "image", mime, base64 });
  };
}

/** Tapping a screenshot-row thumbnail (turn-collapse.ts's screenshot-block)
 *  opens the chat-wide gallery, starting at the clicked shot. The shot is
 *  resolved via screenshot-row.ts's WeakMap, then matched by content into
 *  the freshly-collected gallery collection. */
export function createHandleScreenshotThumbClick(renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const thumb = (e.target as Element).closest<HTMLElement>(".screenshot-thumb");
    if (!thumb) return;
    const row = thumb.closest<HTMLElement>(".screenshot-row");
    if (!row) return;
    const shots = getScreenshotRowShots(row);
    if (!shots) return;
    const shotIdx = Number(thumb.dataset.shotIndex);
    if (!Number.isFinite(shotIdx)) return;
    const shot = shots[shotIdx];
    if (!shot) return;
    const collection = collectChatImages(renderer.messages, renderer.messageEls);
    const foundIndex = collection.images.findIndex((ci) => ci.kind === "screenshot" && ci.data === shot.data && ci.mime === shot.mime);
    if (foundIndex >= 0) openChatImageGallery(collection, foundIndex);
    else openLightbox({ type: "image", mime: shot.mime, base64: shot.data });
  };
}

// Custom chip-panel file rows (Read / File Changes) open their target in the
// in-app file viewer (ai_todo 95). The external-editor jump is preserved via
// the "Open in VS Code" button in the viewer header.
export function createHandleToolFileClick(_renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tool-file-row[data-path]");
    if (!row) return;
    const path = row.dataset.path;
    if (path) openFileViewer(path);
  };
}

/** A page-truncated tool_result row's "Load full output" button (ai_todo
 *  json-cache): fetches the untruncated content on demand instead of
 *  shipping every large Bash/Read/Grep dump on every page load. */
export function createHandleToolResultLoadFullClick(renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".tool-result-load-full");
    if (!btn || !renderer.sessionId) return;
    const toolUseId = btn.dataset.toolUseId;
    const seq = Number(btn.dataset.seq);
    if (!toolUseId || !Number.isFinite(seq)) return;
    const card = btn.nextElementSibling as HTMLElement | null;
    btn.disabled = true;
    btn.innerHTML = `<i class="ph ph-spinner tool-result-load-spin"></i>Loading…`;
    void invoke<ChatEvent>("load_event_detail", {
      sessionId: renderer.sessionId,
      cwd: renderer.paginator.cwdHint,
      seq,
      toolUseId,
    })
      .then((ev) => {
        if (ev.type !== "tool_result") throw new Error("unexpected event type");
        card?.remove();
        btn.outerHTML = renderBlocks([ev.output]);
      })
      .catch((err) => {
        console.error("[chat-renderer] load_event_detail failed", err);
        btn.disabled = false;
        btn.innerHTML = `<i class="ph ph-warning"></i>Failed to load - retry`;
      });
  };
}

export function createHandleRetryClick(renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".api-retry-btn");
    if (!btn || !renderer.onSendText) return;
    btn.disabled = true;
    renderer.onSendText("continue");
  };
}

/** Waiting-on chip (todo 675) - delegated here (not turn-chips.ts) because
 *  opening a local-process tail needs `sessionId`, which that module
 *  deliberately doesn't carry. */
export function createHandleWaitingChipClick(renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const chip = (e.target as Element).closest<HTMLElement>(".turn-chip--waiting-on");
    if (!chip) return;
    onWaitingChipClick(chip, renderer.sessionId);
  };
}

export function createHandleCtaClick(_renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".msg-cta-btn");
    if (!btn) return;
    const id = btn.dataset.ctaId;
    if (!id) return;
    const action = getCta(id);
    if (!action) return;
    btn.closest<HTMLElement>(".msg-cta")?.remove();
    void action.handler();
  };
}

/** The show_preview card header: ⤢ promotes the pushed snapshot to the rail,
 *  anywhere else on the header folds the card. */
export function createHandlePreviewCardClick(_renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const pop = (e.target as HTMLElement).closest<HTMLElement>(".pc-pop");
    if (pop) {
      e.stopPropagation();
      // Announced, not called directly: the rail controller lives in the
      // sessions view, and importing it from shared/ would close a cycle.
      window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug: pop.dataset.previewPop ?? "" } }));
      return;
    }
    const summary = (e.target as HTMLElement).closest<HTMLElement>("[data-preview-toggle]");
    const card = summary?.closest<HTMLElement>(".msg.preview-card");
    if (card) card.classList.toggle("open");
  };
}

export function createHandleToolChipClick(_renderer: ChatRenderer): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".tool-chip");
    if (!chip) return;
    const strip = chip.closest<HTMLElement>(".tool-strip");
    const panel = strip?.nextElementSibling as HTMLElement | null;
    if (!strip || !panel?.classList.contains("tool-strip-panel")) return;

    const tool = chip.dataset.tool;
    const wasActive = chip.classList.contains("tool-chip--active");

    // Scope to DIRECT-child chips/groups so a click at one nesting level never
    // toggles a deeper level's chips/buckets (3-level: Subagent > subagent >
    // tool).
    strip.querySelectorAll<HTMLElement>(":scope > .tool-chip").forEach(c => c.classList.remove("tool-chip--active"));
    for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
      grp.hidden = true;
    }

    if (!wasActive && tool) {
      chip.classList.add("tool-chip--active");
      for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
        grp.hidden = grp.dataset.tool !== tool;
      }
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  };
}
