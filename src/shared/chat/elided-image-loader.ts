// Fetches the bytes of images a history page elided (see elided-image.ts)
// through `load_event_detail`, the same lookup a truncated text result's
// "Load full output" uses. A placeholder loads when it scrolls near view;
// clicking one retries after a failure.

import { invoke } from "../ipc";
import type { ChatEvent } from "../../types/ipc.generated";
import { renderBlocks } from "./chat-transforms";
import { getScreenshotRowShots } from "./screenshot-row";
import type { ChatRenderer } from "./chat-renderer";

const SELECTOR = "[data-elided-image]";
/** Fetches in flight at once. A row of screenshots scrolling into view would
 *  otherwise fire one multi-MB IPC call per thumbnail together. */
const MAX_IN_FLIGHT = 3;
/** Start loading a little before the placeholder is actually visible. */
const MARGIN_PX = 300;
const ROOT_MARGIN = `${MARGIN_PX}px 0px`;
/** How long a placeholder must have been near view before it loads. */
const SETTLE_MS = 250;

export class ElidedImageLoader {
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private queue: HTMLElement[] = [];
  private inFlight = 0;

  constructor(private readonly renderer: ChatRenderer) {}

  /** (Re-)arm over the renderer's container. `root` is the scroll ancestor
   *  (null = viewport). Skips quietly where observers don't exist (jsdom). */
  install(root: HTMLElement | null): void {
    this.dispose();
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
    const container = this.renderer.container;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          io.unobserve(el);
          // A chat opens painted from the top and only then pins to the
          // bottom (chat-scroll.ts scrollToBottomWhenSettled), so an image
          // near the top of the page is "in view" for a moment it never is
          // on screen. Load only if it is still near after that settles;
          // otherwise watch it again.
          setTimeout(() => {
            if (this.io !== io || !el.isConnected) return;
            if (this.isNearRoot(el, root)) this.enqueue(el);
            else io.observe(el);
          }, SETTLE_MS);
        }
      },
      { root, rootMargin: ROOT_MARGIN },
    );
    this.io = io;
    const observeWithin = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(SELECTOR)) io.observe(node);
      for (const el of node.querySelectorAll<HTMLElement>(SELECTOR)) io.observe(el);
    };
    const unobserveWithin = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(SELECTOR)) io.unobserve(node);
      for (const el of node.querySelectorAll<HTMLElement>(SELECTOR)) io.unobserve(el);
    };
    this.mo = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.removedNodes) unobserveWithin(node);
        for (const node of rec.addedNodes) observeWithin(node);
      }
    });
    this.mo.observe(container, { childList: true, subtree: true });
    observeWithin(container);
  }

  private isNearRoot(el: HTMLElement, root: HTMLElement | null): boolean {
    const rect = el.getBoundingClientRect();
    const rootRect = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    return rect.bottom > rootRect.top - MARGIN_PX && rect.top < rootRect.bottom + MARGIN_PX;
  }

  dispose(): void {
    try { this.io?.disconnect(); } catch { /* ignore */ }
    try { this.mo?.disconnect(); } catch { /* ignore */ }
    this.io = null;
    this.mo = null;
    this.queue = [];
  }

  /** Load now, ahead of the queue. Used by a click, so a retry after a
   *  failure does not wait behind the scroll-driven fetches. */
  hydrate(el: HTMLElement): void {
    if (el.dataset.elidedState === "loading") return;
    void this.fetch(el);
  }

  private enqueue(el: HTMLElement): void {
    if (el.dataset.elidedState === "loading" || !el.isConnected) return;
    this.queue.push(el);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT) {
      const el = this.queue.shift();
      if (!el) return;
      if (!el.isConnected || el.dataset.elidedState === "loading") continue;
      this.inFlight++;
      void this.fetch(el).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async fetch(el: HTMLElement): Promise<void> {
    const sessionId = el.dataset.originSession || this.renderer.sessionId;
    const toolUseId = el.dataset.toolUseId;
    const seq = Number(el.dataset.seq);
    if (!sessionId || !toolUseId || !Number.isFinite(seq)) return;
    el.dataset.elidedState = "loading";
    try {
      const ev = await invoke<ChatEvent>("load_event_detail", {
        sessionId,
        cwd: this.renderer.paginator.cwdHint,
        seq,
        toolUseId,
      });
      if (ev.type !== "tool_result" || ev.output.type !== "image" || ev.output.data === "") {
        throw new Error("unexpected detail for an elided image");
      }
      this.apply(toolUseId, seq, ev.output);
    } catch (err) {
      console.error("[chat-renderer] load_event_detail failed for an elided image", err);
      el.dataset.elidedState = "error";
      el.title = "Failed to load - click to retry";
    }
  }

  /** Put the real bytes into the message (so a gallery open or a rebuild of
   *  the screenshot row reads them) and into every placeholder showing it. */
  private apply(toolUseId: string, seq: number, output: { type: "image"; mime: string; data: string }): void {
    for (const m of this.renderer.messages) {
      if (m.kind !== "tool_result" || m.tool_use_id !== toolUseId || m.fullSeq !== seq) continue;
      m.output = output;
      m.outputTruncated = false;
      m.fullSeq = undefined;
      m.outputBytes = undefined;
    }
    const els = this.renderer.container.querySelectorAll<HTMLElement>(SELECTOR);
    for (const el of els) {
      if (el.dataset.toolUseId !== toolUseId || Number(el.dataset.seq) !== seq) continue;
      const thumb = el.closest<HTMLElement>(".screenshot-thumb");
      if (thumb) {
        this.fillThumb(thumb, output);
        continue;
      }
      el.outerHTML = renderBlocks([output]);
    }
  }

  private fillThumb(thumb: HTMLElement, output: { mime: string; data: string }): void {
    const row = thumb.closest<HTMLElement>(".screenshot-row");
    const shot = row ? getScreenshotRowShots(row)?.[Number(thumb.dataset.shotIndex)] : undefined;
    if (shot) {
      shot.data = output.data;
      shot.elided = undefined;
    }
    const img = document.createElement("img");
    // base64's alphabet can't contain a quote, so the src needs no escaping.
    img.src = `data:${output.mime};base64,${output.data}`;
    img.alt = shot?.title ?? "";
    thumb.querySelector(".elided-thumb-body")?.remove();
    thumb.appendChild(img);
    for (const attr of ["data-elided-image", "data-tool-use-id", "data-seq", "data-origin-session", "data-elided-state"]) {
      thumb.removeAttribute(attr);
    }
    thumb.classList.remove("elided-thumb");
  }
}
