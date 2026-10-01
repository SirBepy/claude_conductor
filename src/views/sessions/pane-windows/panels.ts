// What each pane-window tab mounts. Panels are mounted once per pane and kept
// alive while their window is closed or the tab is hidden, so Ask keeps its
// thread, Drafts its open card, and Preview keeps listening for pushes.

import { mountAskPanel } from "../ask-panel";
import { mountTodosPanel } from "../todos-panel";
import { mountDraftsPanel, type DraftsPanelHandle } from "../drafts-panel";
import type { RailTabDeps, RailTabHandle } from "../rail-panel";
import type { PanelKey } from "./layout";

export interface PanelHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  destroy(): void;
}

export interface PanelDeps {
  /** Ask's hand-off target: fills the real composer, unsent. */
  onDraft(text: string): void;
  /** Preview's mount, absent where this pane has no preview (detached chats). */
  mountPreview: ((root: HTMLElement, deps: RailTabDeps) => RailTabHandle) | null;
  previewDeps: RailTabDeps;
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
        destroy: () => ask.destroy(),
      };
    }
    case "todos": {
      const todos = mountTodosPanel(root);
      return { setSessionScope: (sid) => todos.setSessionScope(sid), destroy: () => todos.destroy() };
    }
    case "drafts": {
      const drafts = mountDraftsPanel(root);
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
