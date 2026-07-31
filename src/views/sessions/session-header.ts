import { escapeHtml } from "../../shared/escape-html";
import { projBadgeHtml } from "./sidebar-row-visuals";

export interface SessionHeaderBindOpts {
  sessionId: string;
  readOnly: boolean;
  charId?: string | null;
  charUrl?: string | null;
  charStatus?: string;
  cwd?: string | null;
  autoAcceptOn?: boolean;
}

/**
 * The session pane header - avatar, title/meta, and discard button (drafts).
 * The per-session more-btn and changes-btn have moved to the top-right view-more
 * menu ("This chat" section and Chat submenu respectively).
 */
export class SessionHeader {
  readonly el: HTMLElement;

  private readonly _wrap: HTMLElement;
  private readonly _titleEl: HTMLElement;
  private readonly _metaEl: HTMLElement;

  private readonly _onDiscard: (() => void) | undefined;

  onChangesClick: (() => void) | null = null;
  onCharClick: (() => void) | null = null;

  constructor(opts: { title: string; meta: string; onDiscard?: () => void }) {
    this._onDiscard = opts.onDiscard;

    const el = document.createElement("header");
    el.className = "session-header";
    el.innerHTML = [
      `<span class="session-header-avatar-wrap">`,
      `  <div class="session-header-avatar">?</div>`,
      `</span>`,
      `<div class="session-header-text">`,
      `  <span class="title">${escapeHtml(opts.title)}</span>`,
      `  <span class="meta">${escapeHtml(opts.meta)}</span>`,
      `</div>`,
      `<button class="icon-btn discard-btn" title="Discard draft">`,
      `  <i class="ph ph-x-circle"></i>`,
      `</button>`,
    ].join("");

    this.el = el;
    this._wrap = el.querySelector(".session-header-avatar-wrap")!;
    this._titleEl = el.querySelector(".title")!;
    this._metaEl = el.querySelector(".meta")!;

    el.querySelector<HTMLButtonElement>(".discard-btn")?.addEventListener("click", () => {
      this._onDiscard?.();
    });

    // Char-click delegate on the header element so it survives avatar swaps.
    el.addEventListener("click", (e) => {
      if (!(e.target as Element).closest(".header-char-clickable")) return;
      this.onCharClick?.();
    });
  }

  setTitle(text: string): void { this._titleEl.textContent = text; }
  setMeta(text: string): void { this._metaEl.textContent = text; }

  setRemote(isRemote: boolean): void {
    const existing = this.el.querySelector(".session-header-remote-badge");
    if (isRemote && !existing) {
      const icon = document.createElement("i");
      icon.className = "ph ph-device-mobile session-header-remote-badge";
      icon.title = "Remote chat";
      this._titleEl.appendChild(icon);
    } else if (!isRemote && existing) {
      existing.remove();
    }
  }

  /** No-op kept for call-site compatibility. Changes badge moved to view-more menu. */
  setChangesBadge(_n: number): void {
    // The badge counter previously shown on the header changes-btn is gone.
    // pending-pane.ts and active-session.ts still call this; it is a no-op so
    // they don't need changes.
  }

  setAvatar(charId: string | null, url: string | null, status: string, cwd?: string | null): void {
    const badge = projBadgeHtml(cwd ?? null, "session-header-proj-badge");
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
      this.setAvatar(opts.charId ?? null, opts.charUrl ?? null, opts.charStatus, opts.cwd);
    }
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
