// The right-hand rail (todo 702, split out of preview-panel.ts). It owns the
// host element, the dragged width, and the two rail-wide buttons (pop-out /
// restore, close). Preview is its only content: Todos moved to the chat pane's
// FAB (Joe, 2026-08-24), which took the tab strip with it.

import { invoke } from "../../shared/ipc";
import { listen } from "../../shared/events";
import { wireResizeHandle, clampPanelWidth, splittableWidth } from "./preview-panel-resize";

export type RailMode = "panel" | "window";

/** What a tab body may ask of the rail around it. */
export interface RailTabDeps {
  /** The rail's saved open flag, which stays true while popped out. */
  isOpen(): boolean;
  /** Open AND showing here, so a popped-out rail reports false. */
  isVisible(): boolean;
  /** Opens the rail on this tab's behalf, e.g. a live preview push. */
  requestOpen(snapshotId?: string): void;
  /** Flags another chat's rail open, so it reopens there next time. */
  markOpenFor(sessionId: string): void;
}

/** Mount contract for the rail's content, plus the popover teardown a chat
 *  switch needs (it fires no outside click). */
export interface RailTabHandle {
  setSessionScope(sessionId: string | null): void;
  refresh(opts?: { selectId?: string }): void;
  closeMenus(): void;
  destroy(): void;
}

export type RailTabMount = (root: HTMLElement, deps: RailTabDeps) => RailTabHandle;

export interface RailController {
  toggle(): void;
  open(snapshotId?: string): void;
  close(): void;
  isOpen(): boolean;
  /** Scopes the rail to one chat, INCLUDING its open/closed state (each chat
   *  remembers its own independently); call on every active-session switch
   *  (see state.ts). */
  setSessionScope(sessionId: string | null): void;
  /** Relocates this chat's rail to its own OS window (todo 290, panel mode
   *  only). Docked view stays scoped but hidden until dockBack. */
  popOut(): void;
  /** Pop-out window's own restore path (window mode only) - clears the popped
   *  flag and closes the OS window, so the docked rail takes it back. */
  dockBack(): void;
  destroy(): void;
}

// ── Persistence. Open state is keyed per session id (Joe, 2026-08-01: opening
// the panel in one chat must not show it open in another), the same shape as
// composer-persistence.ts's draftKey. Width stays a single global key; a
// dragged panel width isn't a per-chat preference. ──────────────────────────
const LS_OPEN_PREFIX = "cc_preview_panel_open:";
const LS_RATIO_KEY = "cc_preview_panel_ratio";
/** Superseded by LS_RATIO_KEY, dropped on read: an absolute px width survived
 *  a window shrink and pushed the close button off screen (Joe, 2026-08-19). */
const LS_LEGACY_WIDTH_KEY = "cc_preview_panel_width";
const LS_POPPED_PREFIX = "cc_preview_panel_popped:";
// `cc_rail_tab:<id>` used to persist which tab each chat was on. Nothing reads
// it now that Preview is the rail's only content, so any stored "todos" is
// inert rather than pointing at a tab that no longer exists.

function openKey(sessionId: string): string {
  return LS_OPEN_PREFIX + sessionId;
}

function loadOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(openKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function saveOpen(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(openKey(sessionId), open ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

function poppedKey(sessionId: string): string {
  return LS_POPPED_PREFIX + sessionId;
}

function loadPopped(sessionId: string): boolean {
  try {
    return localStorage.getItem(poppedKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

/** Shared localStorage; the constructor's `storage` listener is what makes
 *  the OTHER window's docked instance react to a flip (separate realms). */
function savePopped(sessionId: string, popped: boolean): void {
  try {
    localStorage.setItem(poppedKey(sessionId), popped ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

/** Share (0-1) of the split from a past drag, or null for an even 50/50 (Joe,
 *  2026-07-20). A share, not px, so a dragged panel follows the window. */
function loadRatio(): number | null {
  try {
    localStorage.removeItem(LS_LEGACY_WIDTH_KEY);
    const n = parseFloat(localStorage.getItem(LS_RATIO_KEY) ?? "");
    if (Number.isFinite(n) && n > 0 && n < 1) return n;
  } catch {
    /* ignore */
  }
  return null;
}

function saveRatio(ratio: number): void {
  try {
    localStorage.setItem(LS_RATIO_KEY, ratio.toFixed(4));
  } catch {
    /* ignore */
  }
}

class RailPanel implements RailController {
  private root: HTMLElement;
  private mode: RailMode;
  private openState: boolean;
  private ratio: number | null;
  /** Without it a dragged width just kept its old px as the window changed. */
  private layoutObserver: ResizeObserver | null = null;
  private currentSessionId: string | null = null;
  private preview: RailTabHandle | null = null;
  private resizeCleanup: (() => void) | null = null;
  /** Panel-mode only: set once popOut() relocates this session's view to its
   *  own OS window; docked host stays scoped but hidden until dockBack(). */
  private popped = false;
  private storageHandler: ((e: StorageEvent) => void) | null = null;
  private unlistenDocked: (() => void) | null = null;
  private destroyed = false;

  constructor(root: HTMLElement, mode: RailMode, mountPreview: RailTabMount) {
    this.root = root;
    this.mode = mode;
    this.ratio = loadRatio();
    // Open state is per-session (see LS_OPEN_PREFIX); unknown until
    // setSessionScope runs, which sessions.ts calls synchronously right
    // after construction - start closed so there's no flash of the wrong
    // chat's open state in between.
    this.openState = false;

    this.applyWidth();
    this.renderShell();
    const previewHost = this.root.querySelector<HTMLElement>('[data-tab-body="preview"]');
    if (previewHost) this.preview = mountPreview(previewHost, this.tabDeps());
    this.wireEvents();
    this.resizeCleanup = wireResizeHandle(this.root, (px, splittable) => {
      if (splittable <= 0) return;
      this.ratio = px / splittable;
      saveRatio(this.ratio);
      this.applyWidth();
    });
    if (this.mode === "panel" && typeof ResizeObserver !== "undefined" && this.root.parentElement) {
      this.layoutObserver = new ResizeObserver(() => this.applyWidth());
      this.layoutObserver.observe(this.root.parentElement);
    }

    if (this.mode === "panel") {
      this.storageHandler = (e: StorageEvent) => {
        if (!this.currentSessionId || e.key !== poppedKey(this.currentSessionId)) return;
        this.popped = e.newValue === "1";
        if (this.popped) this.root.hidden = true;
        else this.applyOpenFromStorage();
      };
      window.addEventListener("storage", this.storageHandler);
      // The pop-out's OS close is a Rust-side hide, not a real close, so that
      // realm gets no chance to write storage - this event is the only signal
      // that the window is gone. Without it the popped flag outlives the
      // window and the rail refuses to show in either place (Joe, 2026-09-23).
      void listen<{ sessionId: string }>("preview-window-docked", (p) => {
        if (!p?.sessionId) return;
        savePopped(p.sessionId, false);
        if (p.sessionId !== this.currentSessionId) return;
        this.popped = false;
        this.applyOpenFromStorage();
      }).then((un) => {
        if (this.destroyed) un();
        else this.unlistenDocked = un;
      });
    }

    this.root.hidden = true;
  }

  private tabDeps(): RailTabDeps {
    return {
      isOpen: () => this.openState,
      isVisible: () => this.openState && !this.popped,
      requestOpen: (snapshotId) => this.open(snapshotId),
      markOpenFor: (sessionId) => saveOpen(sessionId, true),
    };
  }

  /** Flex sizing on the host: even 50/50 by default, else the dragged share
   *  resolved to px on every layout change so it follows the window. */
  private applyWidth(): void {
    // Window mode has no chat pane to split against, and no host flex to set.
    if (this.mode !== "panel") return;
    if (this.ratio === null) {
      this.root.style.flex = "1 1 0%";
      return;
    }
    const splittable = splittableWidth(this.root);
    // Pre-paint the whole view is display:none; the observer re-runs us later.
    if (splittable <= 0) return;
    const px = clampPanelWidth(this.ratio * splittable, splittable);
    this.root.style.flex = `0 0 ${Math.round(px)}px`;
  }

  /** Re-derives visibility from THIS chat's saved open flag. Used by the two
   *  paths that learn the rail stopped being popped out, where the in-memory
   *  openState can't be trusted: the pop-out writes the flag it wants (closed
   *  for its X, open for its restore button) just before the window goes. */
  private applyOpenFromStorage(): void {
    const sid = this.currentSessionId;
    this.openState = !!sid && loadOpen(sid);
    this.root.hidden = !this.openState;
    if (!this.openState) return;
    this.applyWidth();
    this.preview?.refresh();
  }

  // ── Public controller API ────────────────────────────────────────────────

  toggle(): void {
    // Popped out, so there is no docked host to toggle - surface that window
    // instead. Also the only escape when a popped flag outlives its window
    // (app restart while popped), which otherwise leaves the dial inert.
    if (this.mode === "panel" && this.popped) { this.popOut(); return; }
    if (this.openState) this.close();
    else this.open();
  }

  open(snapshotId?: string): void {
    this.openState = true;
    if (this.currentSessionId) saveOpen(this.currentSessionId, true);
    // Relocated to its own window (panel mode only) - stay scoped, stay
    // hidden, until dockBack() clears the flag.
    if (this.mode === "panel" && this.popped) return;
    this.root.hidden = false;
    // Covers the bail above: constructed before the view had a measurable split.
    this.applyWidth();
    this.preview?.refresh(snapshotId ? { selectId: snapshotId } : {});
  }

  close(): void {
    this.openState = false;
    if (this.currentSessionId) saveOpen(this.currentSessionId, false);
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return this.openState;
  }

  setSessionScope(sessionId: string | null): void {
    if (this.currentSessionId === sessionId) return;
    this.currentSessionId = sessionId;
    this.popped = this.mode === "panel" && !!sessionId && loadPopped(sessionId);
    // Each chat's open/closed state is independent (loadOpen defaults false
    // for an id with no saved key yet, e.g. one that's never had the panel
    // opened) - re-derive from THIS chat's key, never carry over the
    // previous chat's this.openState.
    if (sessionId && loadOpen(sessionId) && !this.popped) {
      this.openState = true;
      this.root.hidden = false;
      this.applyWidth();
    } else {
      // Popped: still "open" per the saved flag (dockBack needs to know to
      // re-show it), just relocated to its own window - see the class doc.
      this.openState = this.popped && !!sessionId && loadOpen(sessionId);
      this.root.hidden = true;
    }
    // After the flags above, so each tab can read isVisible() and decide
    // whether to fetch or just baseline.
    this.preview?.setSessionScope(sessionId);
  }

  popOut(): void {
    if (this.mode !== "panel" || !this.currentSessionId) return;
    this.popped = true;
    savePopped(this.currentSessionId, true);
    this.root.hidden = true;
    void invoke("open_preview_window", { sessionId: this.currentSessionId }).catch((err) => {
      console.error("[rail-panel] open_preview_window failed", err);
    });
  }

  dockBack(): void {
    if (this.mode !== "window" || !this.currentSessionId) return;
    savePopped(this.currentSessionId, false);
    void invoke("close_preview_window").catch((err) => {
      console.error("[rail-panel] close_preview_window failed", err);
    });
  }

  /** Window mode's X: the preview is dismissed, not relocated, so the docked
   *  rail must come back CLOSED. Both flags are written before the close is
   *  requested, because `preview-window-docked` reads them back. */
  private closePreview(): void {
    if (this.mode !== "window" || !this.currentSessionId) return;
    saveOpen(this.currentSessionId, false);
    savePopped(this.currentSessionId, false);
    void invoke("close_preview_window").catch((err) => {
      console.error("[rail-panel] close_preview_window failed", err);
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.unlistenDocked) { this.unlistenDocked(); this.unlistenDocked = null; }
    if (this.resizeCleanup) { this.resizeCleanup(); this.resizeCleanup = null; }
    if (this.layoutObserver) { this.layoutObserver.disconnect(); this.layoutObserver = null; }
    if (this.storageHandler) {
      window.removeEventListener("storage", this.storageHandler);
      this.storageHandler = null;
    }
    this.preview?.destroy();
    this.preview = null;
  }

  // ── Rendering + events ───────────────────────────────────────────────────

  /** The strip's first button is the mode's own inverse: pop out when docked,
   *  restore when windowed. It used to be `hidden` in window mode, which did
   *  nothing - `.icon-btn-sq { display: grid }` is an AUTHOR rule and beats
   *  the UA `[hidden] { display: none }`, so it stayed visible and dead
   *  (Joe, 2026-09-23). Rendering the real action leaves nothing to hide. */
  private renderShell(): void {
    const win = this.mode === "window";
    this.root.innerHTML = `
      <div class="preview-panel" data-mode="${this.mode}">
        <div class="pv-resize-handle" data-resize title="Drag to resize"></div>
        <div class="rail-strip">
          <span class="rail-strip-title">Preview</span>
          <span class="rail-strip-grow"></span>
          <button type="button" class="icon-btn-sq pv-icon-btn" data-act="${win ? "restore" : "popout"}" title="${win ? "Put it back in the chat window" : "Pop out into its own window"}"><i class="ph ${win ? "ph-arrows-in-simple" : "ph-arrows-out-simple"}"></i></button>
          <button type="button" class="icon-btn-sq pv-icon-btn" data-act="close" title="${win ? "Close preview" : "Close panel"}"><i class="ph ph-x"></i></button>
        </div>
        <div class="rail-tab-body" data-tab-body="preview"></div>
      </div>
    `;
  }

  /** Rail-level clicks only; each tab body listens on its own subtree for the
   *  buttons it owns. */
  private wireEvents(): void {
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      const actBtn = target.closest<HTMLElement>("[data-act]");
      if (!actBtn) return;
      switch (actBtn.dataset.act) {
        case "popout": this.popOut(); return;
        case "restore": this.dockBack(); return;
        // The strip's close acts on the whole rail (Joe: "the x button closes
        // the entire window"), and in window mode it dismisses the preview
        // rather than relocating it - that's what `restore` above is for.
        case "close": if (this.mode === "window") this.closePreview(); else this.close(); return;
        default: return;
      }
    });
  }
}

export function mountRail(
  root: HTMLElement,
  opts: { mode: RailMode; mountPreview: RailTabMount },
): RailController {
  return new RailPanel(root, opts.mode, opts.mountPreview);
}
