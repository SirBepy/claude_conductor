// The chat pane's panel registry for the kit's pane windows
// (vendor/tauri_kit/frontend/pane-windows/): Ask / Todos / Drafts / Preview,
// and what each tab mounts. Panels are mounted once per pane and kept alive
// while their window is closed or the tab is hidden, so Ask keeps its thread,
// Drafts its open card, and Preview keeps listening for pushes.

import { mountAskPanel } from "../ask-panel";
import { mountTodosPanel } from "../todos-panel";
import { mountDraftsPanel, type DraftsPanelHandle } from "../drafts-panel";
import type { RailTabDeps, RailTabHandle } from "../rail-panel";
import type { PreviewController } from "../preview-panel";
import type { PanelMeta } from "../../../../vendor/tauri_kit/frontend/pane-windows/layout";

export type PanelKey = "ask" | "todos" | "drafts" | "preview";

export const PANEL_KEYS: readonly PanelKey[] = ["ask", "todos", "drafts", "preview"];

export const PANEL_META: Record<PanelKey, PanelMeta> = {
  ask: { label: "Ask", icon: "ph-chat-teardrop-dots" },
  todos: { label: "Todos", icon: "ph-list-checks" },
  drafts: { label: "Drafts", icon: "ph-note-pencil" },
  preview: { label: "Preview", icon: "ph-monitor-play" },
};

export interface PanelHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  /** Only Ask takes seed text. */
  seed?(text: string): void;
  destroy(): void;
}

export interface PanelDeps {
  /** Ask's hand-off target: fills the real composer, unsent. */
  onDraft(text: string): void;
  /** Preview's mount, absent where this pane has no preview (detached chats). */
  mountPreview: ((root: HTMLElement, deps: RailTabDeps) => RailTabHandle) | null;
  previewDeps: RailTabDeps;
  /** Drafts' open count after each fetch; only the split's strip shows it. */
  onDraftsCount?(n: number): void;
}

/** What either panel host needs from the FAB. */
export interface PanelHostDeps {
  /** Ask's hand-off target: fills the real composer, unsent. */
  onDraft(text: string): void;
  mountPreview: PanelDeps["mountPreview"];
  /** Enters Code mode; only the desktop split gives it a strip button, the
   *  phone reaches it through the FAB dial. */
  onCode?(): void;
  /** Fired after every change, so the dial can repaint its state. */
  onChange(): void;
}

/** What the FAB drives the panels through: the desktop split (split-panels/)
 *  or the phone's full-screen pane windows (pane-windows/manager.ts). */
export interface PanelHost {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  openPanel(panel: PanelKey): void;
  askAbout(text: string): void;
  openDraft(id: string): void;
  /** Escape: closes the front-most panel. False when none was open. */
  closeFront(): boolean;
  previewController(): PreviewController;
  destroy(): void;
}

export interface MountedPanels {
  drafts: DraftsPanelHandle | null;
  preview: RailTabHandle | null;
}

export function mountPanel(key: PanelKey, root: HTMLElement, deps: PanelDeps, out: MountedPanels): PanelHandle {
  switch (key) {
    case "ask": {
      const ask = mountAskPanel(root, { onDraft: deps.onDraft });
      return {
        setSessionScope: (sid, cwd) => {
          ask.setCwd(cwd);
          ask.setSessionScope(sid);
        },
        seed: (text) => ask.seed(text),
        destroy: () => ask.destroy(),
      };
    }
    case "todos": {
      const todos = mountTodosPanel(root);
      return { setSessionScope: (sid) => todos.setSessionScope(sid), destroy: () => todos.destroy() };
    }
    case "drafts": {
      const drafts = mountDraftsPanel(root, deps.onDraftsCount);
      out.drafts = drafts;
      return {
        setSessionScope: (sid) => drafts.setSessionScope(sid),
        destroy: () => {
          out.drafts = null;
          drafts.destroy();
        },
      };
    }
    case "preview": {
      // The rail's body expects its own data-tab-body host, which its CSS keys on.
      root.innerHTML = `<div class="preview-panel" data-mode="pane"><div class="rail-tab-body" data-tab-body="preview"></div></div>`;
      const body = root.querySelector<HTMLElement>('[data-tab-body="preview"]')!;
      const preview = deps.mountPreview!(body, deps.previewDeps);
      out.preview = preview;
      return {
        setSessionScope: (sid) => preview.setSessionScope(sid),
        destroy: () => {
          out.preview = null;
          preview.destroy();
        },
      };
    }
  }
}
