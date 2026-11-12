// Alt-click (desktop) or long-press (phone) on an element of the shared mockup
// opens a small box next to the click that messages the chat owning that element.
// The composed page reports the nearest `data-part` region, or "shell", with the
// click position (see ELEMENT_SCRIPT in daemon/preview/shared.rs); the daemon
// picks the recipient from it, so there is no recipient picker here and only the
// text is sent. A failed send keeps the text and shows the error inline.

import "./shared-mockup.css";
import { escapeHtml } from "../../shared/escape-html";
import type { PreviewSnapshot } from "../../types/ipc.generated";
import { boxOrigin, clampPos, elementLabel, elementTarget } from "./shared-mockup-model";

export interface ElementMessageHost {
  frame(): HTMLIFrameElement | null;
  /** The preview in view; the box only opens while it is a shared mockup. */
  snapshot(): PreviewSnapshot | null;
  /** Sends `text` about `element` of preview `id`; resolves to the recipient's name. */
  send(id: string, element: string, text: string): Promise<{ target_name: string }>;
}

export class ElementMessenger {
  private box: HTMLElement | null = null;
  private element = "";
  private previewId = "";
  private pos = { x: 0, y: 0 };
  private busy = false;
  private readonly onMessage = (e: MessageEvent): void => {
    const frame = this.host.frame();
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as { cc?: string; region?: unknown; x?: unknown; y?: unknown } | null;
    if (d?.cc !== "element") return;
    const snap = this.host.snapshot();
    if (!snap?.shared) return;
    const x = Number(d.x);
    const y = Number(d.y);
    this.open(snap.id, elementTarget(d.region), Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, frame);
  };
  private readonly onResize = (): void => this.place();

  constructor(private readonly root: HTMLElement, private readonly host: ElementMessageHost) {
    window.addEventListener("message", this.onMessage);
    window.addEventListener("resize", this.onResize);
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("resize", this.onResize);
    this.close();
  }

  /** Drops the box when the preview in view changes: its text was about another page. */
  reset(snapId: string | null): void {
    if (this.box && this.previewId !== snapId) this.close();
  }

  private open(id: string, element: string, x: number, y: number, frame: HTMLIFrameElement): void {
    const fr = frame.getBoundingClientRect();
    const pr = this.root.getBoundingClientRect();
    this.pos = boxOrigin({ x, y }, fr, pr);
    this.previewId = id;
    this.element = element;
    if (!this.box) {
      const box = document.createElement("div");
      box.className = "pvm-box";
      box.addEventListener("click", (ev) => this.onClick(ev));
      box.addEventListener("keydown", (ev) => this.onKey(ev));
      this.root.appendChild(box);
      this.box = box;
    }
    this.box.innerHTML = `<div class="pvm-head"><span class="pvm-to">${escapeHtml(elementLabel(element))}</span><button type="button" class="pvs-x" data-close title="Close"><i class="ph ph-x"></i></button></div>
      <textarea class="pvm-text" rows="3" placeholder="Tell them what to change"></textarea>
      <div class="pvm-foot"><span class="pvm-status" role="status"></span><button type="button" class="pvm-send" data-send>Send</button></div>`;
    this.place();
    this.box.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") this.close();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.submit();
  }

  private onClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest("[data-close]")) this.close();
    else if (el.closest("[data-send]")) void this.submit();
  }

  private async submit(): Promise<void> {
    const box = this.box;
    if (!box || this.busy) return;
    const ta = box.querySelector<HTMLTextAreaElement>("textarea")!;
    const status = box.querySelector<HTMLElement>(".pvm-status")!;
    const text = ta.value.trim();
    if (!text) {
      this.say(status, "Write a message first.", true);
      return;
    }
    this.busy = true;
    this.say(status, "Sending...", false);
    try {
      const res = await this.host.send(this.previewId, this.element, text);
      // The text is kept in the box on failure; on success the box has done its job.
      ta.value = "";
      ta.disabled = true;
      box.querySelector<HTMLButtonElement>("[data-send]")!.disabled = true;
      this.say(status, `Sent to ${res.target_name}.`, false);
      status.dataset.ok = "true";
    } catch (err) {
      this.say(status, err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  private say(status: HTMLElement, text: string, error: boolean): void {
    status.textContent = text;
    status.dataset.error = String(error);
    delete status.dataset.ok;
    this.place();
  }

  /** Keeps the box inside the panel at its real size, as the controls popover does. */
  private place(): void {
    const box = this.box;
    if (!box) return;
    this.pos = clampPos(this.pos, { w: box.offsetWidth, h: box.offsetHeight }, { w: this.root.clientWidth, h: this.root.clientHeight });
    box.style.left = `${this.pos.x}px`;
    box.style.top = `${this.pos.y}px`;
  }

  private close(): void {
    this.box?.remove();
    this.box = null;
  }
}
