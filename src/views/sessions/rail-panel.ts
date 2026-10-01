// Preview's pop-out OS window shell (todo 290), plus the contract Preview's
// body is mounted under. The docked half of the old right-hand rail is gone:
// in the chat window Preview is a pane window (pane-windows/), and this file
// keeps only the strip the standalone window wears (restore / close) and the
// per-chat flags both realms share through localStorage.

import { invoke } from "../../shared/ipc";

/** What a Preview body may ask of whatever is hosting it. */
export interface RailTabDeps {
  /** The saved open flag, which stays true while popped out. */
  isOpen(): boolean;
  /** Open AND showing here, so a popped-out Preview reports false. */
  isVisible(): boolean;
  /** Opens Preview on the body's behalf, e.g. a live preview push. */
  requestOpen(snapshotId?: string): void;
  /** Flags another chat's Preview open, so it reopens there next time. */
  markOpenFor(sessionId: string): void;
}

/** Mount contract for Preview's body, plus the popover teardown a chat
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
  /** Scopes Preview to one chat, INCLUDING its open/closed state (each chat
   *  remembers its own independently). */
  setSessionScope(sessionId: string | null): void;
  /** Relocates this chat's Preview to its own OS window (todo 290). */
  popOut(): void;
  /** The pop-out window's own restore path - clears the popped flag and
   *  closes the OS window, so the chat window takes Preview back. */
  dockBack(): void;
  destroy(): void;
}

// ── Per-chat flags, shared by the chat window and the pop-out through
// localStorage (Joe, 2026-08-01: opening Preview in one chat must not show it
// open in another). The pop-out writes them right before it closes; the chat
// window reads them back on `preview-window-docked`. ─────────────────────────
const LS_OPEN_PREFIX = "cc_preview_panel_open:";
const LS_POPPED_PREFIX = "cc_preview_panel_popped:";

export function loadOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(LS_OPEN_PREFIX + sessionId) === "1";
  } catch {
    return false;
  }
}

export function saveOpen(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(LS_OPEN_PREFIX + sessionId, open ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

export function loadPopped(sessionId: string): boolean {
  try {
    return localStorage.getItem(LS_POPPED_PREFIX + sessionId) === "1";
  } catch {
    return false;
  }
}

/** Shared localStorage; the chat window's `storage` listener is what makes it
 *  react to a flip made here (separate realms). */
export function savePopped(sessionId: string, popped: boolean): void {
  try {
    localStorage.setItem(LS_POPPED_PREFIX + sessionId, popped ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

/** The pop-out window's controller. Its strip has two ways out: restore puts
 *  Preview back in the chat window, X dismisses it entirely. */
class PreviewWindowShell implements RailController {
  private root: HTMLElement;
  private sessionId: string | null = null;
  private preview: RailTabHandle | null = null;

  constructor(root: HTMLElement, mountPreview: RailTabMount) {
    this.root = root;
    this.root.innerHTML = `
      <div class="preview-panel" data-mode="window">
        <div class="rail-strip">
          <span class="rail-strip-title">Preview</span>
          <span class="rail-strip-grow"></span>
          <button type="button" class="icon-btn-sq pv-icon-btn" data-act="restore" title="Put it back in the chat window"><i class="ph ph-arrows-in-simple"></i></button>
          <button type="button" class="icon-btn-sq pv-icon-btn" data-act="close" title="Close preview"><i class="ph ph-x"></i></button>
        </div>
        <div class="rail-tab-body" data-tab-body="preview"></div>
      </div>
    `;
    const body = this.root.querySelector<HTMLElement>('[data-tab-body="preview"]')!;
    this.preview = mountPreview(body, {
      isOpen: () => true,
      isVisible: () => true,
      requestOpen: (id) => this.open(id),
      markOpenFor: (sid) => saveOpen(sid, true),
    });
    this.root.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "restore") this.dockBack();
      else if (act === "close") this.close();
    });
  }

  toggle(): void {}

  open(snapshotId?: string): void {
    this.preview?.refresh(snapshotId ? { selectId: snapshotId } : {});
  }

  /** Dismissed, not relocated: the chat window must bring Preview back
   *  CLOSED. Both flags are written before the close is requested, because
   *  `preview-window-docked` reads them back. */
  close(): void {
    if (!this.sessionId) return;
    saveOpen(this.sessionId, false);
    savePopped(this.sessionId, false);
    this.sendClose();
  }

  isOpen(): boolean {
    return true;
  }

  setSessionScope(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.preview?.setSessionScope(sessionId);
  }

  popOut(): void {}

  dockBack(): void {
    if (!this.sessionId) return;
    savePopped(this.sessionId, false);
    this.sendClose();
  }

  private sendClose(): void {
    void invoke("close_preview_window").catch((err) => {
      console.error("[rail-panel] close_preview_window failed", err);
    });
  }

  destroy(): void {
    this.preview?.destroy();
    this.preview = null;
  }
}

export function mountPreviewWindowShell(root: HTMLElement, mountPreview: RailTabMount): RailController {
  return new PreviewWindowShell(root, mountPreview);
}
