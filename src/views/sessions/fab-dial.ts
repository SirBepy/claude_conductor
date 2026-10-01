// The chat pane's FAB: tap to fan out Ask / Todos / Drafts / Preview, pick one,
// and it opens in an in-app window over the transcript (Joe, 2026-08-24 - the
// rail stealing layout width was the complaint). Windows float, snap to a
// corner, dock beside the chat as a split, and trade tabs: pane-windows/.

import type { Unlisten } from "../../shared/transport";
import { watchDrafts } from "./fab-dial-drafts-watch";
import { PaneWindows } from "./pane-windows/manager";
import { PANEL_META, type PanelKey } from "./pane-windows/layout";
import type { PanelDeps } from "./pane-windows/panels";
import type { PreviewController } from "./preview-panel";
import "./fab-dial.css";
import "./pane-windows/pane-windows.css";

export interface FabDialDeps {
  /** Ask's hand-off target: fills the real composer, unsent. */
  onDraft(text: string): void;
  /** Mounts the Preview tab; null where this pane has no preview. */
  mountPreview: PanelDeps["mountPreview"];
}

export interface FabDialHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  /** Re-append the host after a pane innerHTML rebuild has detached it. */
  reattach(): void;
  /** Open straight onto one draft - the ⤢ on an inline draft card. */
  openDraft(id: string): void;
  /** What the rest of the view drives Preview through. */
  previewController(): PreviewController;
  close(): void;
  destroy(): void;
}

const DIAL: PanelKey[] = ["ask", "todos", "drafts"];

class FabDial implements FabDialHandle {
  private pane: HTMLElement;
  private host: HTMLElement;
  private chrome: HTMLElement;
  private windows: PaneWindows;
  private dialOpen = false;
  private hasPreview: boolean;
  private sessionId: string | null = null;
  private liftObs: ResizeObserver | null = null;
  private draftsUnlisten: Unlisten | null = null;

  constructor(pane: HTMLElement, deps: FabDialDeps) {
    this.pane = pane;
    this.hasPreview = !!deps.mountPreview;
    this.host = document.createElement("div");
    this.host.className = "fab-dial-host";
    const layer = document.createElement("div");
    layer.className = "pw-layer";
    // display:contents, so the dial and FAB keep their host-relative layout.
    this.chrome = document.createElement("div");
    this.chrome.className = "fab-dial-chrome";
    this.host.append(layer, this.chrome);
    this.chrome.addEventListener("click", this.onClick);
    document.addEventListener("keydown", this.onKeydown);
    this.windows = new PaneWindows(pane, layer, {
      onDraft: deps.onDraft,
      mountPreview: deps.mountPreview,
      onChange: () => this.renderChrome(),
    });
    // Auto-open predicate lives in fab-dial-drafts-watch.ts; "open" here means
    // the window Drafts lives in is up, on whatever tab he left it.
    void watchDrafts(
      () => ({ sessionId: this.sessionId, cardOpen: this.windows.isWindowOpen("drafts") }),
      (draftId) => this.windows.openDraft(draftId),
    ).then((unlisten) => { this.draftsUnlisten = unlisten; });
    this.renderChrome();
  }

  /** active-session.ts rewrites the pane's innerHTML on every chat switch,
   *  which detaches this host - so re-attach instead of caching an element. */
  private attach(): void {
    if (this.host.parentElement !== this.pane) this.pane.appendChild(this.host);
    this.watchLift();
  }

  /** The FAB rests at the pane's bottom-right, which is the composer's Send
   *  split at phone width and on any pane under ~924px. --fab-lift raises it
   *  and the dial to the shell's top edge, set only on a real intersection so
   *  a wide pane's gutter-parked FAB stays put. */
  private syncLift = (): void => {
    const shell = this.pane.querySelector<HTMLElement>(".composer-shell");
    if (!shell) {
      this.host.style.setProperty("--fab-lift", "0px");
      return;
    }
    const fab = this.host.querySelector<HTMLElement>(".fab-dial-fab");
    if (!fab) return;
    const paneBox = this.pane.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const fabBox = fab.getBoundingClientRect();
    const overlapsX = fabBox.right > shellBox.left && fabBox.left < shellBox.right;
    const lift = overlapsX ? Math.max(0, paneBox.bottom - shellBox.top) : 0;
    this.host.style.setProperty("--fab-lift", `${Math.round(lift)}px`);
  };

  /** Re-observed on every attach: the pane's innerHTML rebuild replaces the
   *  shell, so a cached observation would be measuring a detached node. */
  private watchLift(): void {
    this.liftObs?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    this.liftObs = new ResizeObserver(this.syncLift);
    this.liftObs.observe(this.pane);
    const shell = this.pane.querySelector<HTMLElement>(".composer-shell");
    if (shell) this.liftObs.observe(shell);
  }

  setSessionScope(sessionId: string | null, cwd: string | null): void {
    this.sessionId = sessionId;
    this.dialOpen = false;
    // No chat mounted means no transcript to ask about, so the FAB goes away
    // rather than floating over an empty pane.
    if (!sessionId) {
      this.windows.setSessionScope(null, null);
      this.liftObs?.disconnect();
      this.liftObs = null;
      this.host.remove();
      return;
    }
    this.attach();
    // Each chat lands the way he left it: its own windows, where he put them.
    this.windows.setSessionScope(sessionId, cwd);
    this.renderChrome();
  }

  /** Callers rebuild the pane AFTER setSessionScope has already attached, so
   *  the host is orphaned by the time the new DOM lands. The host keeps its own
   *  subtree while detached, so re-appending restores it without a re-render. */
  reattach(): void {
    if (this.sessionId) this.attach();
  }

  openDraft(id: string): void {
    this.windows.openDraft(id);
  }

  previewController(): PreviewController {
    return this.windows.previewController();
  }

  close(): void {
    if (this.dialOpen) {
      this.dialOpen = false;
      this.renderChrome();
      return;
    }
    this.windows.closeFront();
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-fab-toggle]")) {
      this.dialOpen = !this.dialOpen;
      this.renderChrome();
      return;
    }
    const item = el.closest<HTMLElement>("[data-dial]");
    if (!item) return;
    const target = item.dataset.dial as PanelKey;
    this.dialOpen = false;
    // Preview is a state toggle in the dial; the rest always bring theirs up.
    if (target === "preview") this.previewController().toggle();
    else this.windows.openPanel(target);
    this.renderChrome();
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    // Never swallow Escape from a text field inside a window.
    const t = ev.target as HTMLElement | null;
    if (t?.matches("input, textarea")) return;
    this.close();
  };

  private renderChrome(): void {
    this.host.dataset.surface = this.dialOpen ? "dial" : "rest";
    const previewOn = this.hasPreview && this.windows.previewController().isOpen();
    const items = DIAL.map(
      (d) =>
        `<button type="button" class="fab-dial-item" data-dial="${d}">` +
          `<span class="fab-dial-lb">${PANEL_META[d].label}</span>` +
          `<span class="fab-dial-ic"><i class="ph ${PANEL_META[d].icon}"></i></span>` +
        `</button>`,
    ).join("");
    const preview = this.hasPreview
      ? `<button type="button" class="fab-dial-item is-toggle${previewOn ? " is-on" : ""}" data-dial="preview">` +
          `<span class="fab-dial-lb">Preview</span>` +
          `<span class="fab-dial-ic"><i class="ph ph-monitor-play"></i></span>` +
        `</button>`
      : "";
    this.chrome.innerHTML =
      `<div class="fab-dial">${items}${preview}</div>` +
      `<button type="button" class="fab-dial-fab" data-fab-toggle title="Ask, Todos, Drafts, Preview" ` +
        `aria-label="Ask, Todos, Drafts, Preview"><i class="ph ph-list"></i></button>`;
    this.syncLift();
  }

  destroy(): void {
    this.windows.destroy();
    this.liftObs?.disconnect();
    this.liftObs = null;
    if (this.draftsUnlisten) {
      try { this.draftsUnlisten(); } catch { /* ignore */ }
      this.draftsUnlisten = null;
    }
    this.chrome.removeEventListener("click", this.onClick);
    document.removeEventListener("keydown", this.onKeydown);
    this.host.remove();
  }
}

export function mountFabDial(pane: HTMLElement, deps: FabDialDeps): FabDialHandle {
  return new FabDial(pane, deps);
}
