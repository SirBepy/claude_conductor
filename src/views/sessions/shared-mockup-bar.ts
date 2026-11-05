// The shared mockup's row of subs and the draggable controls popover. The row
// sits between the panel header and the canvas; clicking a sub opens that sub's
// controls (a dropdown per choice, a switch per yes/no) in a popover that stays
// inside the panel. A change is posted into the already-staged frame, so the
// page never reloads. Control values live in this object only: nothing here
// needs to outlive the panel.

import "./shared-mockup.css";
import { escapeHtml } from "../../shared/escape-html";
import type { PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";
import { clampPos, controlKey, controlValue, freshChips, ownerChips, type OwnerChip, type OwnerControl } from "./shared-mockup-model";
import { familySubs, ownerTag } from "./shared-mockup-scope";
import { subInitials } from "./sub-list";

export interface SharedBarHost {
  /** The frame the page is staged in, or null before it exists. */
  frame(): HTMLIFrameElement | null;
  /** The scope the panel covers, for the row's dashed chips. */
  scope(): string | null;
  /** A sub's own (dedicated) previews, for the link at the popover's foot. */
  dedicatedOf(ownerId: string): PreviewMeta[];
  open(previewId: string): void;
}

export class SharedBar {
  private readonly strip: HTMLElement;
  private pop: HTMLElement | null = null;
  private snap: PreviewSnapshot | null = null;
  private chips: OwnerChip[] = [];
  private openId: string | null = null;
  private pos: { x: number; y: number } | null = null;
  private readonly values = new Map<string, string>();
  /** Per page: the chips already looked at, so a later push puts a dot on a new one. */
  private readonly seen = new Map<string, Set<string>>();
  private fresh = new Set<string>();
  private readonly onResize = (): void => this.clamp();

  constructor(private readonly root: HTMLElement, private readonly host: SharedBarHost) {
    this.strip = root.querySelector<HTMLElement>(".pv-shared")!;
    this.strip.addEventListener("click", (e) => this.onStripClick(e));
    window.addEventListener("resize", this.onResize);
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.closePop();
  }

  /** Draws the row for `snap`, or hides it for an ordinary preview. */
  render(snap: PreviewSnapshot | null): void {
    if (!snap?.shared) {
      this.snap = null;
      this.strip.hidden = true;
      this.strip.replaceChildren();
      this.closePop();
      return;
    }
    const sameSnap = this.snap?.id === snap.id;
    this.snap = snap;
    this.chips = ownerChips(snap.shared, familySubs(this.host.scope()));
    const seen = this.seen.get(snap.id);
    if (!seen) {
      // First look at this page: nothing on it is news.
      this.seen.set(snap.id, new Set(this.chips.filter((c) => c.controls.length > 0).map((c) => c.id)));
      this.fresh = new Set();
    } else {
      this.fresh = new Set([...this.fresh, ...freshChips(this.chips, seen, this.openId)]);
    }
    if (!sameSnap) this.closePop();
    if (this.openId && !this.chips.some((c) => c.id === this.openId && c.controls.length > 0)) this.closePop();
    this.drawStrip();
    if (this.openId) this.drawPop();
  }

  /** Re-applies every control Joe changed to a freshly staged frame. */
  replay(): void {
    if (!this.snap?.shared) return;
    for (const chip of this.chips) {
      for (const oc of chip.controls) {
        const v = this.values.get(controlKey(this.snap.id, oc.partId, oc.control.id));
        if (v !== undefined) this.post(oc, v);
      }
    }
  }

  private post(oc: OwnerControl, value: string): void {
    this.host.frame()?.contentWindow?.postMessage({ cc: "control", part: oc.partId, id: oc.control.id, value }, "*");
  }

  private drawStrip(): void {
    this.strip.hidden = false;
    const chips = this.chips.map((c) => {
      const tag = ownerTag(c.id);
      const dot = tag?.avatarHtml ?? `<span class="sub-dot pvs-dot">${escapeHtml(subInitials(c.name))}</span>`;
      if (c.controls.length === 0) {
        return `<span class="pvs-chip idle" data-owner="${escapeHtml(c.id)}" title="${escapeHtml(c.name)} has not added any controls yet">${dot}${escapeHtml(c.name)}</span>`;
      }
      const cls = `pvs-chip${this.openId === c.id ? " open" : ""}${this.fresh.has(c.id) ? " fresh" : ""}`;
      return `<button type="button" class="${cls}" data-owner="${escapeHtml(c.id)}" aria-expanded="${this.openId === c.id}">${dot}${escapeHtml(c.name)}</button>`;
    });
    this.strip.innerHTML = `<i class="ph ph-tree-structure" title="Subchats on this page"></i>${chips.join("")}`;
  }

  private onStripClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button.pvs-chip");
    const id = btn?.dataset.owner;
    if (!id) return;
    if (this.openId === id) {
      this.closePop();
      this.drawStrip();
      return;
    }
    this.openId = id;
    this.seen.get(this.snap!.id)?.add(id);
    this.fresh.delete(id);
    this.drawStrip();
    this.drawPop();
  }

  private fieldHtml(oc: OwnerControl): string {
    const { control } = oc;
    const key = `data-part="${escapeHtml(oc.partId)}" data-ctl="${escapeHtml(control.id)}"`;
    const value = controlValue(this.values, this.snap!.id, oc);
    if (control.kind === "select") {
      const opts = control.options.map((o) => `<option value="${escapeHtml(o)}"${o === value ? " selected" : ""}>${escapeHtml(o)}</option>`).join("");
      return `<label class="pvs-field"><span>${escapeHtml(control.label)}</span><select ${key}>${opts}</select></label>`;
    }
    return `<button type="button" role="switch" aria-checked="${value === "on"}" class="pvs-tg${value === "on" ? " on" : ""}" ${key}><span class="pvs-sw"></span>${escapeHtml(control.label)}</button>`;
  }

  private drawPop(): void {
    const chip = this.chips.find((c) => c.id === this.openId);
    if (!chip || !this.snap) return;
    const dedicated = this.host.dedicatedOf(chip.id);
    const links = dedicated
      .map((m) => `<button type="button" class="pvs-link" data-open="${escapeHtml(m.id)}"><i class="ph ph-lock-simple"></i>${escapeHtml(m.slug)}<i class="ph ph-caret-right"></i></button>`)
      .join("");
    let pop = this.pop;
    const fresh = !pop;
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "pvs-pop";
      pop.addEventListener("click", (e) => this.onPopClick(e));
      pop.addEventListener("change", (e) => this.onPopChange(e));
      pop.addEventListener("pointerdown", (e) => this.onGrip(e));
      this.root.appendChild(pop);
      this.pop = pop;
    }
    pop.innerHTML = `<div class="pvs-grip" data-grip title="Drag"><i class="ph ph-dots-six"></i><button type="button" class="pvs-x" data-close title="Close"><i class="ph ph-x"></i></button></div>
      <div class="pvs-fields">${chip.controls.map((oc) => this.fieldHtml(oc)).join("")}</div>${links}`;
    if (fresh && !this.pos) {
      // Clear of the row, so the other chips stay clickable.
      const x = Math.max(0, this.root.clientWidth - pop.offsetWidth - 12);
      this.pos = { x, y: this.strip.offsetTop + this.strip.offsetHeight + 8 };
    }
    this.clamp();
  }

  private onPopClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest("[data-close]")) {
      this.closePop();
      this.drawStrip();
      return;
    }
    const open = el.closest<HTMLElement>("[data-open]");
    if (open?.dataset.open) {
      this.host.open(open.dataset.open);
      return;
    }
    const tg = el.closest<HTMLElement>(".pvs-tg");
    if (tg) {
      const oc = this.find(tg.dataset.part!, tg.dataset.ctl!);
      if (oc) this.set(oc, controlValue(this.values, this.snap!.id, oc) === "on" ? "off" : "on");
    }
  }

  private onPopChange(e: Event): void {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-ctl]");
    if (!sel) return;
    const oc = this.find(sel.dataset.part!, sel.dataset.ctl!);
    if (oc) this.set(oc, sel.value);
  }

  private find(partId: string, ctl: string): OwnerControl | undefined {
    return this.chips.flatMap((c) => c.controls).find((oc) => oc.partId === partId && oc.control.id === ctl);
  }

  private set(oc: OwnerControl, value: string): void {
    this.values.set(controlKey(this.snap!.id, oc.partId, oc.control.id), value);
    this.post(oc, value);
    // Redraw so a switch shows its new state; the popover's size may change, so clamp again.
    this.drawPop();
  }

  private onGrip(e: PointerEvent): void {
    const grip = (e.target as HTMLElement).closest<HTMLElement>("[data-grip]");
    if (!grip || (e.target as HTMLElement).closest("[data-close]") || !this.pop) return;
    const pop = this.pop;
    const dx = e.clientX - pop.offsetLeft;
    const dy = e.clientY - pop.offsetTop;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
    const move = (m: PointerEvent): void => {
      this.pos = { x: m.clientX - dx, y: m.clientY - dy };
      this.clamp();
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  /** Keeps the popover inside the panel at its real size, on every open, change,
   *  drag and resize. A popover taller than the panel makes the panel grow. */
  private clamp(): void {
    const pop = this.pop;
    if (!pop || !this.pos) return;
    this.root.style.minHeight = `${pop.offsetHeight + 8}px`;
    this.pos = clampPos(this.pos, { w: pop.offsetWidth, h: pop.offsetHeight }, { w: this.root.clientWidth, h: this.root.clientHeight });
    pop.style.left = `${this.pos.x}px`;
    pop.style.top = `${this.pos.y}px`;
  }

  private closePop(): void {
    this.pop?.remove();
    this.pop = null;
    this.openId = null;
    this.root.style.minHeight = "";
  }
}

/** The header's lock tag and back arrow: a dedicated mockup says whose it is and
 *  leads back to the shared page. Plain previews of the main chat show neither. */
export function renderKindTag(root: HTMLElement, snap: PreviewSnapshot | null, hasShared: boolean, scope: string | null): void {
  const back = root.querySelector<HTMLElement>(".pv-back");
  const kind = root.querySelector<HTMLElement>(".pv-kind");
  if (!back || !kind) return;
  if (snap?.shared) {
    back.hidden = true;
    kind.hidden = false;
    kind.className = "pv-kind shared";
    kind.innerHTML = `<i class="ph ph-tree-structure"></i><b>Shared</b>`;
    return;
  }
  const tag = snap ? ownerTag(snap.session_id) : null;
  if (!snap || !tag || !scope) {
    back.hidden = true;
    kind.hidden = true;
    return;
  }
  back.hidden = !hasShared;
  kind.hidden = false;
  kind.className = "pv-kind";
  kind.innerHTML = `${tag.avatarHtml}<b>Only ${escapeHtml(tag.name)}</b>`;
}
