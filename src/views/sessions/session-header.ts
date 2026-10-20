import { escapeHtml } from "../../shared/escape-html";
import { modelLabel as shortModelName } from "../../shared/model-name";
import { projBadgeHtml } from "./sidebar-row-visuals";

export interface SessionHeaderBindOpts {
  sessionId: string;
  readOnly: boolean;
  charId?: string | null;
  charUrl?: string | null;
  charStatus?: string;
  cwd?: string | null;
  /** Set only for a session mirrored in from a paired peer machine (multi-
   *  machine federation); undefined/null for every locally-hosted session. */
  machineId?: string | null;
  autoAcceptOn?: boolean;
  wrapUpOnDoneOn?: boolean;
}

/** Shared with sidebar-rows.ts's chip and chat-menu-items.ts's menu item so
 *  the same toggle reads the same explanation everywhere it surfaces. */
export function wrapUpTooltip(on: boolean): string {
  const base = on
    ? "Wrap up when done: ON (Ctrl+Shift+W)"
    : "Wrap up when done (Ctrl+Shift+W)";
  const body = on
    ? "once nothing more is needed from you, Claude self-verifies, commits, and closes this chat on its own - then it's off, since the chat is gone"
    : "turn on to have Claude self-verify, commit, and close this chat on its own once nothing more is needed from you";
  return `${base} - ${body}`;
}

/** Live-updates the mounted header's "Wrap up when done" button for
 *  `sessionId`, if `selectedId` (the caller's own `state.selectedId`) says
 *  that session's pane is the one currently on screen - no-op otherwise
 *  (toggled from the menu/shortcut on a backgrounded chat). Takes
 *  `selectedId` as a plain argument rather than reading `state` itself, so
 *  this file - otherwise a dependency-free presentational module - doesn't
 *  pull every caller into importing the much heavier `active-session.ts`
 *  just to reach one DOM update. The header button's OWN click handler
 *  updates itself directly via `setWrapUpOnDone` instead of going through
 *  this; this is for the other two trigger paths (chat-menu-items.ts's menu
 *  item, session-controls.ts's keyboard shortcut), neither of which holds a
 *  `SessionHeader` instance. */
export function refreshWrapUpIndicator(selectedId: string | null, sessionId: string, on: boolean): void {
  if (selectedId !== sessionId) return;
  const btn = document.querySelector<HTMLButtonElement>(".session-pane .wrap-up-btn");
  if (!btn) return;
  btn.classList.toggle("is-on", on);
  btn.title = wrapUpTooltip(on);
}

/**
 * The session pane header - avatar, title/meta, the `</>` Code mode button, and
 * the discard button (drafts). The per-session more-btn moved to the top-right
 * view-more menu ("This chat" section).
 */
export class SessionHeader {
  readonly el: HTMLElement;

  private readonly _wrap: HTMLElement;
  private readonly _titleEl: HTMLElement;
  private readonly _projEl: HTMLElement;
  private readonly _cfgModelEl: HTMLElement;
  private readonly _cfgSepEl: HTMLElement;
  private readonly _cfgEffortEl: HTMLElement;

  private readonly _onDiscard: (() => void) | undefined;

  /** The `</>` button: enter Code mode for this chat. */
  onCodeModeClick: (() => void) | null = null;
  /** The flag button: toggle "Wrap up when done" for this chat. */
  onWrapUpToggleClick: (() => void) | null = null;
  onCharClick: (() => void) | null = null;
  /** Opens the statusbar's model / effort slider popover on the header's own
   *  text. The statusbar owns both popovers and the commit path, so the header
   *  only hands it which one and where to anchor. */
  onConfigClick: ((which: "model" | "effort", anchor: HTMLElement) => void) | null = null;

  constructor(opts: { title: string; meta: string; onDiscard?: () => void }) {
    this._onDiscard = opts.onDiscard;

    const el = document.createElement("header");
    el.className = "session-header";
    // The two slots stay empty on desktop; mobile-header-merge.ts relocates the
    // live back / overflow buttons into them so the phone shows one band rather
    // than a near-empty .view-header stacked above this one.
    el.innerHTML = [
      `<span class="session-header-lead"></span>`,
      `<span class="session-header-avatar-wrap">`,
      `  <div class="session-header-avatar">?</div>`,
      `</span>`,
      `<div class="session-header-text">`,
      `  <span class="title">${escapeHtml(opts.title)}</span>`,
      `  <span class="meta">`,
      `    <span class="meta-proj">${escapeHtml(opts.meta)}</span>`,
      `    <span class="meta-cfg">`,
      `      <span class="meta-cfg-model"></span>`,
      `      <span class="meta-cfg-sep" hidden>·</span>`,
      `      <span class="meta-cfg-effort"></span>`,
      `    </span>`,
      `  </span>`,
      `</div>`,
      `<button class="icon-btn wrap-up-btn" title="${escapeHtml(wrapUpTooltip(false))}" aria-label="Wrap up when done">`,
      `  <i class="ph-bold ph-flag-checkered"></i>`,
      `</button>`,
      `<button class="icon-btn code-mode-btn" title="Code mode (Ctrl+Shift+E)" aria-label="Code mode">`,
      `  <i class="ph ph-code"></i>`,
      `</button>`,
      `<button class="icon-btn discard-btn" title="Discard draft">`,
      `  <i class="ph ph-x-circle"></i>`,
      `</button>`,
      `<span class="session-header-trail"></span>`,
    ].join("");

    this.el = el;
    this._wrap = el.querySelector(".session-header-avatar-wrap")!;
    this._titleEl = el.querySelector(".title")!;
    this._projEl = el.querySelector(".meta-proj")!;
    this._cfgModelEl = el.querySelector(".meta-cfg-model")!;
    this._cfgSepEl = el.querySelector(".meta-cfg-sep")!;
    this._cfgEffortEl = el.querySelector(".meta-cfg-effort")!;

    el.querySelector<HTMLButtonElement>(".code-mode-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onCodeModeClick?.();
    });

    el.querySelector<HTMLButtonElement>(".wrap-up-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onWrapUpToggleClick?.();
    });

    el.querySelector<HTMLButtonElement>(".discard-btn")?.addEventListener("click", () => {
      this._onDiscard?.();
    });

    // Char-click delegate on the header element so it survives avatar swaps.
    el.addEventListener("click", (e) => {
      const cfg = (e.target as Element).closest<HTMLElement>(".meta-cfg-btn");
      if (cfg) {
        // Same stop as the statusline chips: the popover shell closes on a
        // document-level click, which would fight the toggle below.
        e.stopPropagation();
        this.onConfigClick?.(cfg === this._cfgModelEl ? "model" : "effort", cfg);
        return;
      }
      if (!(e.target as Element).closest(".header-char-clickable")) return;
      this.onCharClick?.();
    });

    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const cfg = (e.target as Element).closest<HTMLElement>(".meta-cfg-btn");
      if (!cfg) return;
      e.preventDefault();
      this.onConfigClick?.(cfg === this._cfgModelEl ? "model" : "effort", cfg);
    });
  }

  setTitle(text: string): void { this._titleEl.textContent = text; }
  setMeta(text: string): void { this._projEl.textContent = text; }

  /** Model and effort as text at the far right of the meta line, each its own
   *  hit target opening the statusbar's slider popover. The three spans are
   *  built once in the constructor and only ever have their text swapped: the
   *  statusbar re-emits config on every render, and replacing the nodes would
   *  detach a popover the user still has open. */
  setConfig(model: string | null, effort: string, effortEditable = true): void {
    const modelText = model ? shortModelName(model) : "";
    this.setConfigPart(this._cfgModelEl, modelText, !!modelText, "Change model");
    this.setConfigPart(this._cfgEffortEl, effort, !!effort && effortEditable, "Change effort");
    this._cfgSepEl.hidden = !(modelText && effort);
  }

  private setConfigPart(el: HTMLElement, text: string, clickable: boolean, title: string): void {
    el.textContent = text;
    el.classList.toggle("meta-cfg-btn", clickable);
    el.title = clickable ? title : "";
    if (clickable) {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
    } else {
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
    }
  }

  setAvatar(charId: string | null, url: string | null, status: string, cwd?: string | null, machineId?: string | null): void {
    const badge = projBadgeHtml(cwd ?? null, "session-header-proj-badge", machineId);
    if (charId) {
      const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${escapeHtml(charId)}"` : "";
      this._wrap.innerHTML = [
        `<span class="session-header-avatar header-char-clickable ${escapeHtml(status)}" title="Change character" role="button" tabindex="0">`,
        `  <img class="char-avatar session-header-backdrop" data-character-id="${escapeHtml(charId)}"${preload} alt="" aria-hidden="true">`,
        `  <img class="char-avatar session-header-char" data-character-id="${escapeHtml(charId)}"${preload} alt="">`,
        `</span>`,
        badge,
      ].join("");
    } else {
      this._wrap.innerHTML = [
        `<div class="session-header-avatar session-header-char-placeholder header-char-clickable ${escapeHtml(status)}" title="Change character" role="button" tabindex="0">?</div>`,
        badge,
      ].join("");
    }
  }

  /**
   * Upgrade from draft to live session. Removes the discard button.
   * More-btn and changes-btn are in the view-more-menu; nothing to show here.
   */
  bindSession(opts: SessionHeaderBindOpts): void {
    this.el.querySelector(".discard-btn")?.remove();

    if (opts.charId !== undefined && opts.charStatus !== undefined) {
      this.setAvatar(opts.charId ?? null, opts.charUrl ?? null, opts.charStatus, opts.cwd, opts.machineId);
    }

    // Read-only (external/automated) sessions aren't driven by this app's own
    // turns, so the toggle has nothing to act on - same gate as auto-accept.
    const wrapUpBtn = this.el.querySelector<HTMLButtonElement>(".wrap-up-btn");
    if (wrapUpBtn) wrapUpBtn.hidden = opts.readOnly;
    this.setWrapUpOnDone(!!opts.wrapUpOnDoneOn);
  }

  /** Reflects the current toggle state on the header's flag button - its own
   *  click handler calls this directly; the menu item and the keyboard
   *  shortcut go through `active-session.ts`'s `refreshWrapUpIndicator`
   *  instead, since they don't hold a `SessionHeader` reference. */
  setWrapUpOnDone(on: boolean): void {
    const btn = this.el.querySelector<HTMLButtonElement>(".wrap-up-btn");
    if (!btn) return;
    btn.classList.toggle("is-on", on);
    btn.title = wrapUpTooltip(on);
  }

  /**
   * Append a kebab (⋮) button to the header - the Jarvis detached window's
   * only menu affordance (it has no view-level header of its own to hold one,
   * unlike the main window). The caller gates when this is invoked (only for
   * a jarvis-flagged session inside a detached window - see
   * `active-session.ts`'s `selectSession`); this method itself has no opinion
   * on that and will happily add the button to any header.
   */
  addKebabButton(onClick: (btn: HTMLButtonElement) => void): void {
    if (this.el.querySelector(".jarvis-kebab-btn")) return;
    const btn = document.createElement("button");
    btn.className = "icon-btn more-btn jarvis-kebab-btn";
    btn.title = "More options";
    btn.innerHTML = `<i class="ph ph-dots-three-vertical"></i>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(btn);
    });
    this.el.appendChild(btn);
  }
}
