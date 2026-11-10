// The chat pane's FAB: tap to fan out Todos / Drafts / Backlog / Code / Preview.
// What a pick opens depends on the screen: on desktop a split beside the chat
// with an icon strip on the far right (split-panels/), on the
// phone a full-screen cover (pane-windows/).

import { isRemote } from "../../shared/transport";
import { isSettingsPopupOpen } from "../../shared/settings-popup";
import { DEFAULT_COMPACT_QUERY } from "../../../vendor/tauri_kit/frontend/pane-windows/manager";
import { PaneWindows } from "./pane-windows/manager";
import { PANEL_META, type PanelDeps, type PanelHost, type PanelKey } from "./pane-windows/panels";
import { SplitPanels } from "./split-panels/split";
import type { PreviewController } from "./preview-panel";
import "./fab-dial.css";
import "../../../vendor/tauri_kit/frontend/pane-windows/pane-windows.css";
import "./pane-windows/pane-windows.css";

export interface FabDialDeps {
  /** Mounts the Preview tab; null where this pane has no preview. */
  mountPreview: PanelDeps["mountPreview"];
  /** Enters Code mode for this chat. */
  onCode(): void;
}

export interface FabDialHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  /** Re-append the host after a pane innerHTML rebuild has detached it. */
  reattach(): void;
  /** Open straight onto one draft - the ⤢ on an inline draft card. */
  openDraft(id: string): void;
  /** Bring one panel up, e.g. Backlog from the phone's todos chip. */
  openPanel(panel: PanelKey): void;
  /** What the rest of the view drives Preview through. */
  previewController(): PreviewController;
  close(): void;
  destroy(): void;
}

const DIAL: PanelKey[] = ["todos", "drafts", "backlog"];

class FabDial implements FabDialHandle {
  private pane: HTMLElement;
  private host: HTMLElement;
  private chrome: HTMLElement;
  private windows: PanelHost;
  private dialOpen = false;
  private hasPreview: boolean;
  private onCode: () => void;
  private sessionId: string | null = null;
  private liftObs: ResizeObserver | null = null;
  private keepObs: MutationObserver | null = null;
  private split = false;

  constructor(pane: HTMLElement, deps: FabDialDeps) {
    this.pane = pane;
    this.hasPreview = !!deps.mountPreview;
    this.onCode = deps.onCode;
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
    const hostDeps = {
      mountPreview: deps.mountPreview,
      onChange: () => {
        this.syncHost();
        this.renderChrome();
      },
    };
    // The split's icon strip already offers every dial entry, so on desktop
    // the FAB would only duplicate it; Code moves into the strip instead.
    this.split = usesSplit();
    this.windows = this.split ? new SplitPanels(pane, layer, { ...hostDeps, onCode: deps.onCode }) : new PaneWindows(pane, layer, hostDeps);
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
    // rather than floating over an empty pane. The desktop split can ask to
    // stay (a Dashboard panel open beside the empty pane), which syncHost()
    // decides from inside this call, through onChange.
    if (!sessionId) {
      this.windows.setSessionScope(null, null);
      this.syncHost();
      return;
    }
    this.keepObs?.disconnect();
    this.keepObs = null;
    this.attach();
    // Each chat lands the way he left it: its own windows, where he put them.
    this.windows.setSessionScope(sessionId, cwd);
    this.renderChrome();
  }

  /** Callers rebuild the pane AFTER setSessionScope has already attached, so
   *  the host is orphaned by the time the new DOM lands. The host keeps its own
   *  subtree while detached, so re-appending restores it without a re-render. */
  reattach(): void {
    if (this.sessionId || this.windows.wantsHost?.()) this.attach();
  }

  /** With no chat the host is on the pane only while the split wants it. The
   *  empty states rewrite the pane's children without calling reattach(), so a
   *  kept host is watched and put back. */
  private syncHost(): void {
    if (this.sessionId) return;
    if (this.windows.wantsHost?.()) {
      this.attach();
      if (!this.keepObs && typeof MutationObserver !== "undefined") {
        this.keepObs = new MutationObserver(() => {
          if (this.host.parentElement !== this.pane) this.pane.appendChild(this.host);
        });
        this.keepObs.observe(this.pane, { childList: true });
      }
      return;
    }
    this.keepObs?.disconnect();
    this.keepObs = null;
    this.liftObs?.disconnect();
    this.liftObs = null;
    this.host.remove();
  }

  openDraft(id: string): void {
    this.windows.openDraft(id);
  }

  openPanel(panel: PanelKey): void {
    this.windows.openPanel(panel);
    this.renderChrome();
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
    else if ((item.dataset.dial as string) === "code") this.onCode();
    else this.windows.openPanel(target);
    this.renderChrome();
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    // This Escape closes the Settings popup over the chat, not a panel under it.
    if (isSettingsPopupOpen()) return;
    // Never swallow Escape from a text field inside a window.
    const t = ev.target as HTMLElement | null;
    if (t?.matches("input, textarea")) return;
    this.close();
  };

  private renderChrome(): void {
    if (this.split) {
      this.chrome.innerHTML = "";
      return;
    }
    this.host.dataset.surface = this.dialOpen ? "dial" : "rest";
    const previewOn = this.hasPreview && this.windows.previewController().isOpen();
    const items = DIAL.map(
      (d) =>
        `<button type="button" class="fab-dial-item" data-dial="${d}">` +
          `<span class="fab-dial-lb">${PANEL_META[d].label}</span>` +
          `<span class="fab-dial-ic"><i class="ph ${PANEL_META[d].icon}"></i></span>` +
        `</button>`,
    ).join("");
    // Not a PanelKey window: it hands the whole pane over to Code mode.
    const code =
      `<button type="button" class="fab-dial-item" data-dial="code" title="Code mode (Ctrl+Shift+E)">` +
        `<span class="fab-dial-lb">Code</span>` +
        `<span class="fab-dial-ic"><i class="ph ph-code"></i></span>` +
      `</button>`;
    const preview = this.hasPreview
      ? `<button type="button" class="fab-dial-item is-toggle${previewOn ? " is-on" : ""}" data-dial="preview">` +
          `<span class="fab-dial-lb">Preview</span>` +
          `<span class="fab-dial-ic"><i class="ph ph-monitor-play"></i></span>` +
        `</button>`
      : "";
    this.chrome.innerHTML =
      `<div class="fab-dial">${items}${code}${preview}</div>` +
      `<button type="button" class="fab-dial-fab" data-fab-toggle title="Todos, Drafts, Backlog, Code, Preview" ` +
        `aria-label="Todos, Drafts, Backlog, Code, Preview"><i class="ph ph-list"></i></button>`;
    this.syncLift();
  }

  destroy(): void {
    this.windows.destroy();
    this.keepObs?.disconnect();
    this.liftObs?.disconnect();
    this.liftObs = null;
    this.chrome.removeEventListener("click", this.onClick);
    document.removeEventListener("keydown", this.onKeydown);
    this.host.remove();
  }
}

/** Decided once per mount: the phone (and a window already phone-narrow when
 *  the pane mounts) gets the pane windows' full-screen covers, with their
 *  swipe and back-button handling; a desktop window later dragged narrow keeps
 *  the split, which then covers the chat instead of squeezing it (split.ts). */
function usesSplit(): boolean {
  if (isRemote()) return false;
  return !(typeof window.matchMedia === "function" && window.matchMedia(DEFAULT_COMPACT_QUERY).matches);
}

export function mountFabDial(pane: HTMLElement, deps: FabDialDeps): FabDialHandle {
  return new FabDial(pane, deps);
}
