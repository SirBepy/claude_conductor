// The chat pane's panels on desktop (Joe, 2026-10-25): one panel at
// a time fills a split beside the chat, behind a draggable divider, and a
// narrow icon strip on the far right swaps which one. This replaced the
// floating / snapped / docked pane windows as the desktop home of Preview,
// Drafts, Todos and Ask; the phone keeps those as full-screen covers
// (pane-windows/manager.ts), picked once in fab-dial.ts.
//
// Everything here lives in the FAB host, which is absolutely positioned over
// the pane; the chat itself gives up its width through the pane's
// padding-right, the same lever the pane-window docks pulled, so
// active-session.ts's innerHTML rewrites never touch the split.

import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import type { RailTabDeps } from "../rail-panel";
import { loadPopped, savePopped, saveOpen as savePreviewOpen, loadOpen as loadPreviewOpen } from "../rail-panel";
import type { PreviewController } from "../preview-panel";
import {
  mountPanel, PANEL_KEYS, PANEL_META, type MountedPanels, type PanelDeps, type PanelHandle, type PanelHost, type PanelHostDeps, type PanelKey,
} from "../pane-windows/panels";
import { forgetActive, recallActive, rememberActive, loadFraction, saveFraction } from "./memory";
import "./split.css";

/** Top to bottom, as Joe picked it in the split mockup. */
const STRIP_ORDER: readonly PanelKey[] = ["preview", "drafts", "todos", "ask"];
const STRIP_W = 44;
const DIVIDER_W = 6;
/** Below these the split cannot keep both sides usable, so the panel covers
 *  the chat instead. 420px of chat keeps a message line near 60 characters. */
const MIN_PANEL = 320;
const MIN_CHAT = 420;

export class SplitPanels implements PanelHost {
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private active: PanelKey | null = null;
  private readonly panels: PanelKey[];
  private handles = new Map<PanelKey, PanelHandle>();
  private roots = new Map<PanelKey, HTMLElement>();
  private mounted: MountedPanels = { drafts: null, preview: null };
  private readonly strip: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private fraction = loadFraction();
  private draftsCount = 0;
  /** Preview relocated to its own OS window for this chat (rail-panel.ts's
   *  `cc_preview_panel_popped:<id>`); the split stops showing it. */
  private popped = false;
  /** Whether Preview was on screen after the last change; its body only
   *  fetches when it comes into view (or on a push), so the edge matters. */
  private previewShown = false;
  /** The snapshot an open asked for, applied when Preview next comes into view. */
  private pendingSnapshot: string | undefined;
  /** A push landed while another panel filled the split: Preview's icon
   *  carries a dot until it is shown, rather than yanking that panel away. */
  private previewUnseen = false;
  private resizeObs: ResizeObserver | null = null;
  private storageHandler: ((e: StorageEvent) => void) | null = null;
  private unlistenDocked: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly pane: HTMLElement,
    layer: HTMLElement,
    private readonly deps: PanelHostDeps,
  ) {
    this.panels = PANEL_KEYS.filter((p) => p !== "preview" || !!deps.mountPreview);
    layer.classList.add("sp-layer");
    this.strip = document.createElement("nav");
    this.strip.className = "sp-strip";
    this.strip.setAttribute("aria-label", "Panels");
    this.divider = document.createElement("div");
    this.divider.className = "sp-divider";
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-orientation", "vertical");
    this.divider.title = "Drag to resize";
    this.panelEl = document.createElement("section");
    this.panelEl.className = "sp-panel";
    this.head = document.createElement("header");
    this.head.className = "sp-head";
    this.body = document.createElement("div");
    this.body.className = "sp-body";
    this.panelEl.append(this.head, this.body);
    layer.append(this.divider, this.panelEl, this.strip);

    this.strip.addEventListener("click", this.onStripClick);
    this.head.addEventListener("click", this.onHeadClick);
    this.divider.addEventListener("pointerdown", this.onDividerDown);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.paint());
      this.resizeObs.observe(pane);
    }
    // Preview must hear a push for a chat whose Preview is closed in order
    // to open it, and Drafts' count shows on the strip before it is opened.
    for (const p of this.panels) if (p === "preview" || p === "drafts") this.ensureMounted(p);
    if (deps.mountPreview) this.watchPopOut();
    // Not apply(): its onChange would reach the FAB before it holds this host.
    this.renderStrip();
    this.paint();
  }

  // ── Public ───────────────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null, cwd: string | null): void {
    const changed = sessionId !== this.sessionId;
    this.sessionId = sessionId;
    this.cwd = cwd;
    if (changed) {
      this.popped = !!sessionId && !!this.deps.mountPreview && loadPopped(sessionId);
      this.pendingSnapshot = undefined;
      this.previewUnseen = false;
      // Each chat lands the way he left it. Preview's open flag can also be
      // set from another chat (a push there, markOpenFor), so it is read too.
      const wantsPreview = !!sessionId && !this.popped && this.panels.includes("preview") && loadPreviewOpen(sessionId);
      let next = sessionId ? recallActive(sessionId) : null;
      if (next && !this.panels.includes(next)) next = null;
      if (next === "preview" && this.popped) next = null;
      if (!next && wantsPreview) next = "preview";
      else if (next && next !== "preview" && wantsPreview) this.previewUnseen = true;
      this.active = next;
      if (next) this.ensureMounted(next);
    }
    // Before apply(): a newly-shown Preview must fetch for the new chat.
    for (const h of this.handles.values()) h.setSessionScope(sessionId, cwd);
    this.apply(changed);
  }

  openPanel(panel: PanelKey): void {
    if (panel === "preview") return this.openPreview(undefined, true);
    this.show(panel);
  }

  /** Brings Ask up with its input prefilled. */
  askAbout(text: string): void {
    this.show("ask");
    this.handles.get("ask")?.seed?.(text);
  }

  openDraft(id: string): void {
    this.show("drafts");
    this.mounted.drafts?.openDraft(id);
  }

  closeFront(): boolean {
    if (!this.active) return false;
    this.close();
    return true;
  }

  /** The pane's PreviewController: what sessions.ts, the overflow menu and
   *  state.ts hold Preview as. */
  previewController(): PreviewController {
    return {
      toggle: () => {
        // Popped out, so there is nothing here to toggle - surface that window.
        if (this.popped) return this.popOut();
        if (this.active === "preview") this.close();
        else this.openPreview(undefined, true);
      },
      open: (snapshotId?: string) => this.openPreview(snapshotId, true),
      close: () => {
        if (this.active === "preview") this.close();
      },
      isOpen: () => this.previewOpen(),
      // FabDial scopes this whole host; state.ts calling it too is a no-op.
      setSessionScope: () => {},
      popOut: () => this.popOut(),
      dockBack: () => {},
      destroy: () => {},
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObs?.disconnect();
    if (this.storageHandler) window.removeEventListener("storage", this.storageHandler);
    this.unlistenDocked?.();
    this.strip.removeEventListener("click", this.onStripClick);
    this.head.removeEventListener("click", this.onHeadClick);
    this.divider.removeEventListener("pointerdown", this.onDividerDown);
    for (const h of this.handles.values()) h.destroy();
    this.handles.clear();
    this.clearPaneInset();
  }

  // ── Showing ──────────────────────────────────────────────────────────────

  private show(panel: PanelKey): void {
    if (!this.panels.includes(panel)) return;
    this.ensureMounted(panel);
    this.active = panel;
    this.apply(false);
  }

  private close(): void {
    this.active = null;
    this.apply(false);
  }

  private ensureMounted(panel: PanelKey): void {
    if (this.handles.has(panel)) return;
    const root = document.createElement("div");
    root.className = "pw-panel sp-pane";
    root.dataset.panel = panel;
    root.hidden = true;
    this.body.appendChild(root);
    this.roots.set(panel, root);
    const deps: PanelDeps = {
      onDraft: this.deps.onDraft,
      mountPreview: this.deps.mountPreview,
      previewDeps: this.previewDeps(),
      onDraftsCount: (n) => {
        if (n === this.draftsCount) return;
        this.draftsCount = n;
        this.renderStrip();
      },
    };
    const h = mountPanel(panel, root, deps, this.mounted);
    this.handles.set(panel, h);
    h.setSessionScope(this.sessionId, this.cwd);
  }

  /** Puts the DOM in line with `active`, then runs Preview's on-screen edge
   *  and remembers the choice for this chat. */
  private apply(scoping: boolean): void {
    for (const [k, root] of this.roots) root.hidden = k !== this.active;
    this.panelEl.dataset.active = this.active ?? "";
    this.renderHead();
    this.paint();

    const shown = !this.popped && this.active === "preview";
    // A chat switch is the body's own setSessionScope's to fetch for.
    if (shown && !this.previewShown && !scoping) {
      const id = this.pendingSnapshot;
      this.mounted.preview?.refresh(id ? { selectId: id } : {});
    }
    if (shown) {
      this.pendingSnapshot = undefined;
      this.previewUnseen = false;
    }
    this.previewShown = shown;
    if (this.sessionId) {
      if (this.active) rememberActive(this.sessionId, this.active);
      else forgetActive(this.sessionId);
      // Only an explicit show/close writes the flag. A chat switch lands on
      // another panel while a Preview pushed behind it is still pending, and
      // writing `shown=false` then would erase that pending state.
      if (!scoping && !this.popped && this.panels.includes("preview")) savePreviewOpen(this.sessionId, shown);
    }
    this.renderStrip();
    this.deps.onChange();
  }

  /** Sizes the panel from the remembered fraction, clamped so neither side
   *  drops under its minimum; the chat yields through the pane's padding. */
  private paint(): void {
    // No chat, no host on the pane (fab-dial.ts), so nothing may hold width.
    if (!this.sessionId) {
      this.panelEl.hidden = true;
      this.divider.hidden = true;
      this.clearPaneInset();
      return;
    }
    const total = this.pane.clientWidth;
    const open = this.active !== null && total > 0;
    this.panelEl.hidden = !open;
    let panelW = 0;
    let overlay = false;
    if (open) {
      const avail = total - STRIP_W - DIVIDER_W;
      if (avail < MIN_PANEL + MIN_CHAT) {
        overlay = true;
        panelW = total - STRIP_W;
      } else {
        panelW = Math.round(Math.min(avail - MIN_CHAT, Math.max(MIN_PANEL, avail * this.fraction)));
      }
    }
    this.divider.hidden = !open || overlay;
    this.panelEl.toggleAttribute("data-overlay", overlay);
    this.panelEl.style.width = `${panelW}px`;
    this.divider.style.right = `${STRIP_W + panelW}px`;
    const inset = STRIP_W + (open && !overlay ? panelW + DIVIDER_W : 0);
    this.pane.style.paddingRight = `${inset}px`;
    // The FAB and the read-only prompt card ride the chat column's corner.
    this.pane.style.setProperty("--pw-dock-r", `${inset}px`);
  }

  private clearPaneInset(): void {
    this.pane.style.paddingRight = "";
    this.pane.style.removeProperty("--pw-dock-r");
  }

  private renderHead(): void {
    const k = this.active;
    if (!k) {
      this.head.innerHTML = "";
      return;
    }
    // Preview's own head carries its title, version and kebab, so this one
    // shrinks to its buttons and sits at the end of that row (split.css).
    const title =
      k === "preview"
        ? ""
        : `<span class="sp-title"><i class="ph ${PANEL_META[k].icon}"></i><span>${PANEL_META[k].label}</span></span>`;
    const popout =
      k === "preview"
        ? `<button type="button" class="sp-btn" data-sp-act="popout" title="Pop out into its own window">` +
          `<i class="ph ph-arrow-square-out"></i></button>`
        : "";
    this.head.innerHTML =
      `${title}<span class="sp-grow"></span>${popout}` +
      `<button type="button" class="sp-btn" data-sp-act="close" title="Close" aria-label="Close ${PANEL_META[k].label}">` +
      `<i class="ph ph-x"></i></button>`;
  }

  private renderStrip(): void {
    // Not a panel: it hands the whole pane over to Code mode, so it sits above
    // the panel tabs and never shows as pressed.
    const code = this.deps.onCode
      ? `<button type="button" class="sp-tab" data-sp-code title="Code mode (Ctrl+Shift+E)" aria-label="Code mode">` +
        `<i class="ph ph-code"></i></button>`
      : "";
    this.strip.innerHTML = code + STRIP_ORDER.filter((k) => this.panels.includes(k))
      .map((k) => {
        const on = k === this.active;
        const { label, icon } = PANEL_META[k];
        // Quiet marks only (Joe's rule): a small number, a small dot.
        const mark =
          k === "drafts" && this.draftsCount > 0
            ? `<span class="sp-count" aria-label="${this.draftsCount} open">${this.draftsCount}</span>`
            : k === "preview" && this.previewUnseen
              ? `<span class="sp-dot" aria-label="New preview"></span>`
              : "";
        return (
          `<button type="button" class="sp-tab${on ? " is-on" : ""}" data-sp-k="${k}" title="${label}" ` +
          `aria-label="${label}" aria-pressed="${on}"><i class="ph ${icon}"></i>${mark}</button>`
        );
      })
      .join("");
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private onStripClick = (ev: MouseEvent): void => {
    if ((ev.target as HTMLElement).closest("[data-sp-code]")) return this.deps.onCode?.();
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-sp-k]");
    if (!btn) return;
    const k = btn.dataset.spK as PanelKey;
    if (k === "preview" && this.popped) return this.popOut();
    if (this.active === k) this.close();
    else if (k === "preview") this.openPreview(undefined, true);
    else this.show(k);
  };

  private onHeadClick = (ev: MouseEvent): void => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-sp-act]")?.dataset.spAct;
    if (act === "close") this.close();
    else if (act === "popout") this.popOut();
  };

  private onDividerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const div = this.divider;
    div.setPointerCapture?.(ev.pointerId);
    div.classList.add("is-dragging");
    // The iframe under the pointer would swallow the moves mid-drag.
    this.panelEl.classList.add("is-resizing");
    const move = (e: PointerEvent) => {
      const box = this.pane.getBoundingClientRect();
      const avail = box.width - STRIP_W - DIVIDER_W;
      if (avail <= 0) return;
      const panelW = box.right - STRIP_W - e.clientX - DIVIDER_W / 2;
      this.fraction = Math.min(1, Math.max(0, panelW / avail));
      this.paint();
    };
    const up = () => {
      div.classList.remove("is-dragging");
      this.panelEl.classList.remove("is-resizing");
      div.removeEventListener("pointermove", move);
      div.removeEventListener("pointerup", up);
      div.removeEventListener("pointercancel", up);
      // Stored clamped, so a drag past a minimum doesn't leave a value the
      // next wider window would honour literally.
      const avail = this.pane.clientWidth - STRIP_W - DIVIDER_W;
      if (avail > MIN_PANEL + MIN_CHAT) {
        this.fraction = Math.min((avail - MIN_CHAT) / avail, Math.max(MIN_PANEL / avail, this.fraction));
      }
      saveFraction(this.fraction);
    };
    div.addEventListener("pointermove", move);
    div.addEventListener("pointerup", up);
    div.addEventListener("pointercancel", up);
  };

  // ── Preview ──────────────────────────────────────────────────────────────

  private previewDeps(): RailTabDeps {
    return {
      isOpen: () => this.previewOpen(),
      isVisible: () => !this.popped && this.active === "preview",
      // A push: it may not take the split from a panel he is using.
      requestOpen: (id) => this.openPreview(id, false),
      markOpenFor: (sid) => savePreviewOpen(sid, true),
    };
  }

  /** Popped still counts as open: the pop-out's restore needs to know to
   *  bring it back. */
  private previewOpen(): boolean {
    if (this.popped) return !!this.sessionId && loadPreviewOpen(this.sessionId);
    return this.active === "preview";
  }

  /** `explicit` is a click on something that names Preview; a push is not,
   *  and lands as a dot when another panel fills the split. */
  private openPreview(snapshotId: string | undefined, explicit: boolean): void {
    if (!this.panels.includes("preview")) return;
    if (this.popped) {
      if (!this.sessionId) return;
      savePreviewOpen(this.sessionId, true);
      // Already popped out: focus that window and tell it which snapshot to
      // show, rather than leaving it on whatever it last had selected.
      void invoke("open_preview_window", { sessionId: this.sessionId, snapshotId }).catch((err) => {
        console.error("[split-panels] open_preview_window failed", err);
      });
      return;
    }
    if (!explicit && this.active && this.active !== "preview") {
      this.previewUnseen = true;
      // The flag outlives a chat switch; previewUnseen alone would not.
      if (this.sessionId) savePreviewOpen(this.sessionId, true);
      if (snapshotId) this.pendingSnapshot = snapshotId;
      this.renderStrip();
      return;
    }
    if (this.previewShown) {
      this.mounted.preview?.refresh(snapshotId ? { selectId: snapshotId } : {});
      return;
    }
    if (snapshotId) this.pendingSnapshot = snapshotId;
    this.show("preview");
  }

  private popOut(): void {
    const sid = this.sessionId;
    if (!sid) return;
    this.popped = true;
    savePopped(sid, true);
    savePreviewOpen(sid, true);
    if (this.active === "preview") this.active = null;
    this.apply(false);
    void invoke("open_preview_window", { sessionId: sid }).catch((err) => {
      console.error("[split-panels] open_preview_window failed", err);
    });
  }

  /** The pop-out's close is a Rust-side hide that writes nothing, so this
   *  event is the only signal it is gone; the storage flip covers the
   *  pop-out's own restore and X, which write the flags before closing. */
  private watchPopOut(): void {
    const back = (sid: string) => {
      if (sid !== this.sessionId) return;
      this.popped = false;
      if (loadPreviewOpen(sid)) this.show("preview");
      else this.apply(false);
    };
    this.storageHandler = (e: StorageEvent) => {
      const sid = this.sessionId;
      if (!sid || e.key !== `cc_preview_panel_popped:${sid}`) return;
      if (e.newValue === "1") {
        this.popped = true;
        if (this.active === "preview") this.active = null;
        this.apply(false);
      } else back(sid);
    };
    window.addEventListener("storage", this.storageHandler);
    void listen<{ sessionId: string }>("preview-window-docked", (p) => {
      if (!p?.sessionId) return;
      savePopped(p.sessionId, false);
      back(p.sessionId);
    }).then((un) => {
      if (this.destroyed) un();
      else this.unlistenDocked = un;
    });
  }
}
