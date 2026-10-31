// The rail's Preview tab body (ai_todo 138; rail shell split out to
// rail-panel.ts by todo 702). Renders the daemon's one global preview
// timeline, filtered to the active chat, so a snapshot pushed with no
// session_id matches no scope and never appears (accepted, not a bug).
//
// This file is the DOM, RPC and menu wiring; which page is in view and why
// lives in preview-panel-selection.ts, the header markup in
// preview-panel-header.ts.

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import type { PreviewMeta } from "../../types/ipc.generated";
import { canPublish, publishIcon, publishLabel, publishTitle, publishToClaudeAi } from "../../shared/claude-ai-publish";
import { togglePvMoreMenu, closePvMoreMenu, type DeviceWidth, type PvMoreMenuDeps } from "./preview-panel-more-menu";
import { togglePvPicker, closePvHistory, type PvPickerDeps } from "./preview-panel-history";
import { mountPvComposer, type PvComposerDeps, type PvComposerHandle } from "./preview-panel-composer";
import { PreviewSelection } from "./preview-panel-selection";
import { renderShell, renderHeader, renderHeaderEmpty, renderCanvasEmpty } from "./preview-panel-header";
import { mountPreviewWindowShell, type RailController, type RailTabDeps, type RailTabHandle } from "./rail-panel";
import { isMirrored } from "./sessions-helpers";
import { state } from "./state";
import { mountPreviewStage } from "./preview-canvas";
import { applyPreviewTemplate } from "./preview-panel-document";
import "../../shared/chat/caret-popup/popup.css";
import "../../shared/chat/composer.css";

/** What callers drive Preview through, in a pane window or the pop-out. */
export type PreviewController = RailController;

class PreviewTab implements RailTabHandle {
  private root: HTMLElement;
  private deps: RailTabDeps;
  private sel: PreviewSelection;
  private deviceWidth: DeviceWidth = "desktop";
  private unlistenPreview: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;
  /** Reply composer docked at the tab's bottom (see preview-panel-composer.ts).
   *  Mounted once in the constructor: unlike the AUQ card, this tab's own
   *  DOM is never innerHTML-rebuilt (renderIframe/renderHeader
   *  only touch their own sub-elements), so there's no per-render remount. */
  private composer: PvComposerHandle | null = null;

  constructor(root: HTMLElement, deps: RailTabDeps) {
    this.root = root;
    this.deps = deps;
    this.sel = new PreviewSelection(deps, {
      renderHeader: () => renderHeader(this.root, this.sel),
      renderPage: () => void this.renderIframe(),
      renderEmpty: () => this.renderEmpty(),
    });

    renderShell(this.root);
    this.composer = mountPvComposer(this.root, this.pvComposerDeps());
    this.root.addEventListener("click", (e) => this.onClick(e));
    void this.subscribeLive();

    this.focusHandler = () => {
      if (this.deps.isOpen()) void this.sel.refreshList();
      else void this.sel.checkForUnseen();
    };
    window.addEventListener("focus", this.focusHandler);

    this.renderEmpty();
  }

  // ── Rail tab handle ──────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null): void {
    if (this.sel.sessionId === sessionId) return;
    this.closeMenus();
    this.sel.switchTo(sessionId);
    if (this.deps.isVisible()) {
      void this.sel.refreshList();
      return;
    }
    this.sel.clear();
    this.renderEmpty();
    // Baseline only - the chat just switched into may already have older
    // previews; those shouldn't force-open the panel, only a push that
    // arrives *after* this baseline should (see checkForUnseen doc).
    void this.sel.checkForUnseen({ allowOpen: false });
  }

  refresh(opts: { selectId?: string } = {}): void {
    void this.sel.refreshList(opts);
  }

  closeMenus(): void {
    closePvMoreMenu();
    closePvHistory();
  }

  destroy(): void {
    if (this.unlistenPreview) {
      try { this.unlistenPreview(); } catch { /* ignore */ }
      this.unlistenPreview = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
    this.composer?.destroy();
    this.composer = null;
    closePvHistory();
  }

  private async subscribeLive(): Promise<void> {
    try {
      this.unlistenPreview = await getTransport().listen<{ snapshot: PreviewMeta }>(
        "preview",
        (payload) => this.sel.onLivePush(payload?.snapshot),
      );
    } catch (err) {
      console.warn("[preview-panel] listen(preview) failed", err);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private openInBrowser(): void {
    const selected = this.sel.selected;
    if (!selected) return;
    // Windows' ShellExecuteW has no protocol handler for data: URLs, so we
    // write a real temp .html file and open that path instead.
    void (async () => {
      try {
        const path = await invoke<string>("write_temp_html", { html: applyPreviewTemplate(selected.html) });
        await invoke("open_external", { url: path });
      } catch (err) {
        console.error("[preview-panel] open_external failed", err);
      }
    })();
  }

  private setDeviceWidth(w: DeviceWidth): void {
    // Segmented buttons live in the shared menu now, not this.root.
    this.deviceWidth = w;
    const frame = this.root.querySelector<HTMLElement>(".pv-frame");
    if (frame) frame.dataset.w = w;
  }

  private pvComposerDeps(): PvComposerDeps {
    return { getSelected: () => this.sel.selected };
  }

  private pvMoreMenuDeps(): PvMoreMenuDeps {
    const { selected, selectedVersion } = this.sel;
    return {
      onRefresh: () => void this.sel.refreshList(),
      onOpenBrowser: () => this.openInBrowser(),
      onSetDeviceWidth: (w) => this.setDeviceWidth(w),
      getDeviceWidth: () => this.deviceWidth,
      // Publish reads the LOCAL preview store, which never holds a mirrored
      // chat's snapshots (they live on the machine hosting the chat), and it
      // publishes the latest page, so an older version in view must not offer it.
      publish: selected && selectedVersion === null && canPublish() && !this.chatIsMirrored()
        ? {
            label: publishLabel(selected.published, selected.version),
            icon: publishIcon(selected.published, selected.version),
            title: publishTitle(selected.published, selected.version),
            onClick: () => this.publish(),
          }
        : undefined,
    };
  }

  private pvPickerDeps(): PvPickerDeps {
    return {
      getSnapshots: () => this.sel.snapshots,
      getSelectedId: () => this.sel.selected?.id,
      getSelectedVersion: () => this.sel.selectedVersion,
      onSelectPreview: (id) => void this.sel.selectSnapshot(id),
      onSelectVersion: (version) => { if (this.sel.selected) void this.sel.selectSnapshot(this.sel.selected.id, version); },
    };
  }

  private chatIsMirrored(): boolean {
    return isMirrored(state.sessions.find((s) => s.session_id === this.sel.sessionId));
  }

  private publish(): void {
    const snap = this.sel.selected;
    if (!snap) return;
    void publishToClaudeAi(snap.id, snap.published, snap.version).then((link) => {
      // Read the selection again: the user may have moved to another page.
      const current = this.sel.selected;
      if (!link || current?.id !== snap.id) return;
      current.published = link;
    });
  }

  private onClick(e: MouseEvent): void {
    const actBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!actBtn) return;
    switch (actBtn.dataset.act) {
      case "more": togglePvMoreMenu(actBtn as HTMLButtonElement, this.pvMoreMenuDeps()); return;
      case "previews": togglePvPicker("previews", actBtn, this.pvPickerDeps()); return;
      case "versions": togglePvPicker("versions", actBtn, this.pvPickerDeps()); return;
      default: return;
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderEmpty(): void {
    renderHeaderEmpty(this.root);
    renderCanvasEmpty(this.root);
  }

  // No re-entry guard like chat-preview-card.ts's mountPreviewFrame: this
  // rebuilds .pv-canvas fresh on every snapshot selection, so its iframe
  // is never stale.
  private async renderIframe(): Promise<void> {
    const selected = this.sel.selected;
    if (!selected) return;
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    const stage = mountPreviewStage(canvas, this.deviceWidth, selected.html);
    if (!stage) return;
    await stage.ready;
  }
}

/** Preview's body, mounted into a pane window (pane-windows/panels.ts) or the
 *  pop-out window's shell. */
export function mountPreviewTab(root: HTMLElement, deps: RailTabDeps): RailTabHandle {
  return new PreviewTab(root, deps);
}

/** Pop-out window bootstrap (todo 290), called from main.ts's boot branch.
 *  Repopulates state.sessions (separate JS module realm) so the reply
 *  composer can resolve the session to send to. */
export async function mountPreviewWindow(root: HTMLElement, sessionId: string): Promise<PreviewController> {
  const { refreshSessions } = await import("./sidebar");
  await refreshSessions();
  const controller = mountPreviewWindowShell(root, mountPreviewTab);
  controller.setSessionScope(sessionId);
  controller.open();
  // The chat window re-invokes `open_preview_window` to focus this window
  // rather than re-sending a snapshot straight to it (separate realm, no
  // other channel) - see `open_preview_window`'s doc for why this is needed
  // even while already open.
  const { listen } = await import("../../shared/events");
  void listen<{ sessionId?: string; snapshotId?: string }>("preview-window-set-session", (p) => {
    if (!p?.sessionId) return;
    controller.setSessionScope(p.sessionId);
    controller.open(p.snapshotId);
  });
  return controller;
}
