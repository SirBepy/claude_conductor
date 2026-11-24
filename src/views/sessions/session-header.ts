import { escapeHtml } from "../../shared/escape-html";
import { typeSwap } from "../../shared/title-typewriter";
import { modelLabel as shortModelName } from "../../shared/model-name";
import { modelRankIcon } from "./sidebar-row-visuals";
import { tintedEffort } from "../../shared/chat/dashboard/subs-model";
import { projBadgeHtml } from "./sidebar-row-visuals";
import { isProjectMainChat } from "./chat-heads-model";
import { state } from "./state";
import { PopoverShell } from "./statusbar-popover-shell";

// Phone effort label: 3-4 letters because the header row has no room for the word.
const EFFORT_SHORT: Record<string, string> = { low: "low", medium: "mid", high: "high", xhigh: "xhi", max: "max" };

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
}

/**
 * The session pane header - avatar and title/meta. A draft is deleted from the
 * view-more menu's "Delete draft", not from here (Joe, 2026-10-23: no quick X).
 * Code mode lives in the chat FAB menu. The per-session more-btn moved to the top-right
 * view-more menu ("This chat" section).
 */
/** The header's project-name click for a started chat. None for a chat
 *  mirrored from a paired machine: its folder is on that machine, which this
 *  daemon's dashboard cannot read. Loaded lazily: the dashboard page imports
 *  the chat-pane modules that build this header. */
export function projectDashboardOpener(sess: { cwd: unknown, project_id?: string | null, machine?: unknown }): (() => void) | null {
  const cwd = sess.cwd ? String(sess.cwd) : "";
  if (!cwd || sess.machine) return null;
  return () => {
    void import("./project-dashboard/dashboard-page").then((m) => m.openDashboardPage(cwd, sess.project_id || null));
  };
}

export class SessionHeader {
  readonly el: HTMLElement;

  private readonly _wrap: HTMLElement;
  private readonly _titleEl: HTMLElement;
  private readonly _projEl: HTMLElement;
  private readonly _cfgModelEl: HTMLElement;
  private readonly _cfgModelTextEl: HTMLElement;
  private readonly _cfgModelBatteryEl: HTMLElement;
  private readonly _cfgSepEl: HTMLElement;
  private readonly _cfgEffortFullEl: HTMLElement;
  private readonly _cfgEffortShortEl: HTMLElement;
  private readonly _cfgEffortEl: HTMLElement;
  private readonly _comboEl: HTMLElement;
  private readonly _comboBatteryEl: HTMLElement;
  private readonly _comboShell = new PopoverShell();
  private _comboHtml = "";
  private _comboOutside: ((e: MouseEvent) => void) | null = null;
  private _comboGone: MutationObserver | null = null;
  /** What the desktop battery says, kept so its popover can repaint in place when the statusbar re-emits config. */
  private _cfg: { model: string; effort: string; effortEditable: boolean } = { model: "", effort: "", effortEditable: true };

  onCharClick: (() => void) | null = null;
  private _onProjectClick: (() => void) | null = null;
  /** Opens the statusbar's model / effort slider popover on the header's own
   *  text. The statusbar owns both popovers and the commit path, so the header
   *  only hands it which one and where to anchor. */
  onConfigClick: ((which: "model" | "effort", anchor: HTMLElement) => void) | null = null;

  constructor(opts: { title: string; meta: string }) {
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
      // Desktop's one model+effort control (the two spans below are the phone's and stay in the DOM, hidden by CSS).
      `      <button type="button" class="meta-cfg-combo" aria-haspopup="dialog" aria-expanded="false" hidden><i class="ph-bold meta-cfg-combo-battery"></i></button>`,
      `      <span class="meta-cfg-anchor" aria-hidden="true"></span>`,
      `      <span class="meta-cfg-model"><span class="meta-cfg-model-text"></span><i class="ph-bold meta-cfg-model-battery"></i></span>`,
      `      <span class="meta-cfg-sep" hidden>·</span>`,
      `      <span class="meta-cfg-effort"><span class="meta-cfg-effort-full"></span><span class="meta-cfg-effort-short"></span></span>`,
      `    </span>`,
      `  </span>`,
      `</div>`,
      `<span class="session-header-trail"></span>`,
    ].join("");

    this.el = el;
    this._wrap = el.querySelector(".session-header-avatar-wrap")!;
    this._titleEl = el.querySelector(".title")!;
    this._projEl = el.querySelector(".meta-proj")!;
    this._cfgModelEl = el.querySelector(".meta-cfg-model")!;
    this._cfgModelTextEl = el.querySelector(".meta-cfg-model-text")!;
    this._cfgModelBatteryEl = el.querySelector(".meta-cfg-model-battery")!;
    this._cfgSepEl = el.querySelector(".meta-cfg-sep")!;
    this._cfgEffortFullEl = el.querySelector(".meta-cfg-effort-full")!;
    this._cfgEffortShortEl = el.querySelector(".meta-cfg-effort-short")!;
    this._cfgEffortEl = el.querySelector(".meta-cfg-effort")!;
    this._comboEl = el.querySelector(".meta-cfg-combo")!;
    this._comboBatteryEl = el.querySelector(".meta-cfg-combo-battery")!;
    // detail 0 is a keyboard activation (Enter or Space on the button).
    this._comboEl.addEventListener("click", (e) => this.toggleComboPopover(e.detail === 0));
    // A slider's Escape hands focus back to its anchor; the anchor is a plain overlay span, so it forwards that to the battery.
    const anchor = el.querySelector<HTMLElement>(".meta-cfg-anchor")!;
    anchor.focus = () => this._comboEl.focus();

    // Char-click delegate on the header element so it survives avatar swaps.
    el.addEventListener("click", (e) => {
      if (this._onProjectClick && (e.target as Element).closest(".meta-proj")) {
        this._onProjectClick();
        return;
      }
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
      if (this._onProjectClick && (e.target as Element).closest(".meta-proj")) {
        e.preventDefault();
        this._onProjectClick();
        return;
      }
      const cfg = (e.target as Element).closest<HTMLElement>(".meta-cfg-btn");
      if (!cfg) return;
      e.preventDefault();
      this.onConfigClick?.(cfg === this._cfgModelEl ? "model" : "effort", cfg);
    });
  }

  /** Left of the avatar. Empty on the desktop; the phone's list-back joins it, so a
   *  sub's own back arrow shares it (subchat-view.ts hides the list-back there). */
  get leadSlot(): HTMLElement { return this.el.querySelector<HTMLElement>(".session-header-lead")!; }

  /** Right end of the header: the sub count on a main chat. The phone's live ⋮
   *  joins it. Hidden on desktop, whose chat page lists the subs itself. */
  get trailSlot(): HTMLElement { return this.el.querySelector<HTMLElement>(".session-header-trail")!; }

  /** Sets the title outright. Goes through the typewriter module so a swap still
   *  typing on this element is cancelled instead of painting over the new text. */
  setTitle(text: string): void { typeSwap(this._titleEl, text, { animate: false }); }

  /** Fades the title and project line in again. A draft calls it as it becomes
   *  its chat, so the project name it opened on hands over to the chat's name. */
  playTextSwap(): void {
    this.el.classList.remove("is-swapping");
    // Restarts the animation if a swap is still running.
    void this.el.offsetWidth;
    this.el.classList.add("is-swapping");
    this._titleEl.addEventListener("animationend", () => this.el.classList.remove("is-swapping"), { once: true });
  }
  setMeta(text: string): void { this._projEl.textContent = text; }

  /** Makes the project name a button (opens the project's dashboard page). A
   *  draft leaves it plain: its pane already shows that dashboard. */
  set onProjectClick(fn: (() => void) | null) {
    this._onProjectClick = fn;
    this._projEl.classList.toggle("is-link", !!fn);
    if (fn) {
      this._projEl.setAttribute("role", "button");
      this._projEl.tabIndex = 0;
      this._projEl.title = "Project dashboard (Ctrl+Shift+D)";
    } else {
      this._projEl.removeAttribute("role");
      this._projEl.removeAttribute("tabindex");
      this._projEl.removeAttribute("title");
    }
  }

  /** Model and effort at the far right of the header. The phone shows each as its
   *  own hit target opening the statusbar's slider popover: the model as the chat
   *  list's rank battery, effort as a 3-4 letter word. Desktop shows one battery
   *  for both (`setCombo`). CSS picks which of the two is visible. The spans are
   *  built once in the constructor and only ever have their text/icon swapped:
   *  the statusbar re-emits config on every render, and replacing the nodes
   *  would detach a popover the user still has open. */
  setConfig(model: string | null, effort: string, effortEditable = true): void {
    const modelText = model ? shortModelName(model) : "";
    this._cfgModelTextEl.textContent = modelText;
    const rankIcon = modelRankIcon(model ?? "");
    this._cfgModelBatteryEl.className = `ph-bold meta-cfg-model-battery ${rankIcon}`;
    // The phone shows the model as this glyph, so effort tints it (effort-battery.css).
    const tint = tintedEffort(effort);
    if (tint) this._cfgModelBatteryEl.dataset.batteryEffort = tint;
    else delete this._cfgModelBatteryEl.dataset.batteryEffort;
    // An unranked family has no battery glyph, so the phone shows the name
    // instead of an empty, still-clickable span.
    this._cfgModelEl.classList.toggle("no-rank", !rankIcon);
    this._cfgModelEl.hidden = !modelText;
    this.setConfigPart(this._cfgModelEl, !!modelText, `${modelText}: change model`, modelText);
    this._cfgEffortFullEl.textContent = effort;
    this._cfgEffortShortEl.textContent = EFFORT_SHORT[effort] ?? effort;
    this._cfgEffortEl.hidden = !effort;
    this._cfgEffortEl.dataset.effort = effort;
    this.setConfigPart(this._cfgEffortEl, !!effort && effortEditable, `Effort ${effort}: change effort`, effort ? `Effort ${effort}` : "");
    this._cfgSepEl.hidden = !(modelText && effort);
    this.setCombo(modelText, rankIcon, tint, effort, effortEditable);
  }

  /** The desktop battery: the model's rank as the fill, effort as the tint, both named
   *  in its tooltip and, on click, in a popover that also opens either slider. */
  private setCombo(modelText: string, rankIcon: string, tint: string | null, effort: string, effortEditable: boolean): void {
    this._cfg = { model: modelText, effort, effortEditable };
    this._comboEl.hidden = !modelText && !effort;
    this._comboBatteryEl.className = `ph-bold meta-cfg-combo-battery ${rankIcon || "ph-battery-empty"}`;
    if (tint) this._comboBatteryEl.dataset.batteryEffort = tint;
    else delete this._comboBatteryEl.dataset.batteryEffort;
    const tip = [modelText, effort].filter(Boolean).join(" · ");
    this._comboEl.dataset.tip = tip;
    this._comboEl.setAttribute("aria-label", `${tip}. Show model and effort`);
    // The statusbar re-emits config on every render: only a changed popover is rebuilt, so a
    // row under the pointer or focus is not swapped out mid-click.
    if (this._comboEl.hidden) this._comboShell.close();
    else if (this._comboShell.isOpen && this.comboPopoverHtml() !== this._comboHtml) {
      // A keyboard user inside the popover keeps their row across the rebuild.
      const held = document.activeElement?.closest<HTMLElement>(".meta-cfg-popover .mcp-row[data-which]")?.dataset.which;
      this.openComboPopover(false);
      if (held) document.querySelector<HTMLElement>(`.meta-cfg-popover .mcp-row[data-which="${held}"]`)?.focus();
    }
  }

  private toggleComboPopover(byKeyboard: boolean): void {
    if (this._comboShell.isOpen) this._comboShell.close();
    else this.openComboPopover(byKeyboard);
  }

  private comboPopoverHtml(): string {
    const { model, effort, effortEditable } = this._cfg;
    const row = (which: "model" | "effort", label: string, value: string, editable: boolean): string => {
      if (!value) return "";
      const body = `<span class="mcp-k">${label}</span><span class="mcp-v">${escapeHtml(value)}</span>`;
      return editable
        ? `<button type="button" class="mcp-row" data-which="${which}" title="Change ${label.toLowerCase()}">${body}<i class="ph ph-caret-right mcp-go"></i></button>`
        : `<div class="mcp-row is-locked">${body}</div>`;
    };
    return row("model", "Model", model, true) + row("effort", "Effort", effort, effortEditable);
  }

  /** `focusFirst`: a keyboard open moves focus into the popover (it is appended to the body,
   *  so Tab from the battery would not reach it). */
  private openComboPopover(focusFirst: boolean): void {
    this._comboHtml = this.comboPopoverHtml();
    this._comboEl.classList.add("on");
    this._comboEl.setAttribute("aria-expanded", "true");
    // The slider a row opens is anchored on a sibling that overlays the battery, never on the
    // battery or its wrapper: a click on an anchor's own tree counts as inside the slider, so a
    // second click on the battery would leave both popovers open.
    const sliderAnchor = this.el.querySelector<HTMLElement>(".meta-cfg-anchor") ?? this._comboEl;
    this._comboShell.open(this._comboEl, this._comboHtml, {
      className: "meta-cfg-popover",
      onClose: () => {
        this._comboEl.classList.remove("on");
        this._comboEl.setAttribute("aria-expanded", "false");
        if (this._comboOutside) document.removeEventListener("click", this._comboOutside, true);
        this._comboOutside = null;
        this._comboGone?.disconnect();
        this._comboGone = null;
      },
      wire: (pop) => {
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-label", "Model and effort");
        pop.querySelectorAll<HTMLElement>(".mcp-row[data-which]").forEach((btn) => {
          btn.addEventListener("click", () => {
            this._comboShell.close();
            this.onConfigClick?.(btn.dataset.which as "model" | "effort", sliderAnchor);
          });
        });
        if (focusFirst) pop.querySelector<HTMLElement>(".mcp-row[data-which]")?.focus();
      },
    });
    // A statusbar chip's click handler stops propagation, so the shell's own bubbling
    // outside-click never sees it; a capture listener does, and closes this one.
    if (!this._comboOutside) {
      this._comboOutside = (e: MouseEvent) => {
        const t = e.target as Node;
        if (this._comboEl.contains(t) || document.querySelector(".meta-cfg-popover")?.contains(t)) return;
        this._comboShell.close();
      };
      document.addEventListener("click", this._comboOutside, true);
    }
    // The popover lives on the body, so it outlives a header that is swapped out without a
    // click (a keyboard chat switch): close it the moment the battery leaves the document.
    if (!this._comboGone) {
      this._comboGone = new MutationObserver(() => {
        if (!this._comboEl.isConnected) this._comboShell.close();
      });
      this._comboGone.observe(document.body, { childList: true, subtree: true });
    }
  }

  private setConfigPart(el: HTMLElement, clickable: boolean, title: string, lockedTitle: string): void {
    el.classList.toggle("meta-cfg-btn", clickable);
    el.title = clickable ? title : lockedTitle;
    if (clickable) {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
    } else {
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
    }
  }

  /** Letters a character-less chat shows in its avatar instead of "?": a sub has no
   *  character, and the sub list stands initials in for one. Survives `setAvatar`. */
  private _initials: string | null = null;

  setAvatarInitials(initials: string | null): void {
    this._initials = initials;
    const placeholder = this._wrap.querySelector<HTMLElement>(".session-header-char-placeholder");
    if (placeholder) placeholder.textContent = initials ?? "?";
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
        `<div class="session-header-avatar session-header-char-placeholder header-char-clickable ${escapeHtml(status)}" title="Change character" role="button" tabindex="0">${escapeHtml(this._initials ?? "?")}</div>`,
        badge,
      ].join("");
    }
  }

  /** A project's main chat is the project itself: the chat heads draw it as the project's face
   *  with no character, and its name would only say "main chat of <project>", so the header
   *  shows the project's face and name and nothing else. The title stays in the DOM, hidden
   *  (session-header.css), so the title updates that run on every chat still have a target. */
  private showAsProjectMain(cwd: string | null, machineId: string | null): void {
    this.el.classList.add("is-project-main");
    const name = this._projEl.textContent ?? "";
    const machine = machineId ? ` data-proj-face-machine="${escapeHtml(machineId)}"` : "";
    const face = cwd
      ? `<span class="proj-face" data-proj-face="${escapeHtml(cwd)}" data-proj-mono="${escapeHtml(name)}"${machine}><i class="ph ph-folder"></i></span>`
      : `<span class="proj-face"><i class="ph ph-folder"></i></span>`;
    this._wrap.innerHTML = `<span class="session-header-project-face" aria-hidden="true">${face}</span>`;
  }

  /**
   * Upgrade from draft to live session.
   * More-btn and changes-btn are in the view-more-menu; nothing to show here.
   */
  bindSession(opts: SessionHeaderBindOpts): void {
    const sess = state.sessions.find((s) => s.session_id === opts.sessionId);
    if (sess && isProjectMainChat(sess, state.sessions)) {
      this.showAsProjectMain(opts.cwd ?? null, opts.machineId ?? null);
      return;
    }
    if (opts.charId !== undefined && opts.charStatus !== undefined) {
      this.setAvatar(opts.charId ?? null, opts.charUrl ?? null, opts.charStatus, opts.cwd, opts.machineId);
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
