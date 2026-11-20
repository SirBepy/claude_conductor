// The Attachments card's Previews tab data and tiles for one chat dashboard: the family's
// preview list (list_previews scoped to the main chat), its live updates, and
// each tile's staged page. Owns that state like AnswersCard and SubsCard own
// theirs, so chat-dashboard.ts only asks for a draw (dashboard-zones.ts).

import { invoke } from "../../../shared/ipc";
import { getTransport } from "../../../shared/transport";
import { buildPreviewDocumentHtml } from "../preview-panel-document";
import { ownerTag, scopeRoot } from "../shared-mockup-scope";
import type { PreviewMeta, PreviewSnapshot } from "../../../types/ipc.generated";

export interface PreviewTilesHost {
  /** The chat's id; null until the renderer knows it (attach() sets it after the dashboard is built). */
  sessionId(): string | null;
  /** Asks the dashboard for a redraw. */
  schedule(): void;
}

export class PreviewTiles {
  /** The family's previews, newest first; the Previews tab keeps this chat's own and folds the rest. */
  list: PreviewMeta[] = [];
  /** The list is read once the renderer knows its chat. */
  private asked = false;
  private unlisten: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Staged tile documents by `id@version`: a redraw of the card reuses the
   *  address instead of fetching and staging the page again. */
  private readonly tileSrc = new Map<string, string>();
  private readonly tileLoading = new Set<string>();

  constructor(private readonly host: PreviewTilesHost) {}

  /** A sub by its name; the main chat as such, since a sub read in place sees its parent's previews too. */
  readonly ownerName = (owner: string): string =>
    ownerTag(owner)?.name ?? (owner === scopeRoot(this.host.sessionId()) ? "Main chat" : "Another chat");

  /** Any push re-reads the list; a burst (a shared mockup's parts) is one read. */
  async subscribe(): Promise<void> {
    try {
      const un = await getTransport().listen("preview", () => {
        if (this.timer !== null) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.load();
        }, 150);
      });
      if (this.disposed) un();
      else this.unlisten = un;
    } catch (err) {
      console.warn("[chat-dashboard] listen(preview) failed", err);
    }
  }

  /** Reads the list the first time the chat's id is known. */
  ensureLoaded(): void {
    if (this.asked || !this.host.sessionId()) return;
    this.asked = true;
    void this.load();
  }

  private async load(): Promise<void> {
    const sid = this.host.sessionId();
    if (!sid) return;
    try {
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId: scopeRoot(sid) });
      if (this.disposed) return;
      this.list = Array.isArray(list) ? list : [];
      this.host.schedule();
    } catch (err) {
      console.warn("[chat-dashboard] list_previews failed", err);
    }
  }

  /** Points each tile's frame at its staged page. The frame is new after every
   *  redraw of the card, so this runs after every render and costs a lookup
   *  once the page is staged. The page is drawn at a fixed size and scaled to
   *  the tile, so the tile reads as the real preview in miniature. */
  mount(root: HTMLElement): void {
    for (const tile of root.querySelectorAll<HTMLElement>(".cdash-pv-tile")) {
      const id = tile.dataset.pvId ?? "";
      const key = `${id}@${tile.dataset.pvVersion ?? ""}`;
      const frame = tile.querySelector<HTMLIFrameElement>(".cdash-pv-frame");
      if (!frame) continue;
      const width = tile.clientWidth;
      if (width > 0) tile.style.setProperty("--pv-scale", String(width / 1280));
      const cached = this.tileSrc.get(key);
      if (cached) {
        if (frame.getAttribute("src") !== cached) frame.src = cached;
        continue;
      }
      if (this.tileLoading.has(key)) continue;
      this.tileLoading.add(key);
      void this.stage(key, id);
    }
  }

  private async stage(key: string, id: string): Promise<void> {
    try {
      const snap = await invoke<PreviewSnapshot>("get_preview", { id, sessionId: scopeRoot(this.host.sessionId()) });
      const src = await invoke<string>("render_preview_doc", { html: buildPreviewDocumentHtml(snap.html) });
      this.tileSrc.set(key, src);
      if (!this.disposed) this.host.schedule();
    } catch (err) {
      console.warn("[chat-dashboard] preview tile failed", err);
    } finally {
      this.tileLoading.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
