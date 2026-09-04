// The chat pane's FAB: tap to fan out Ask / Todos / Drafts / Preview, pick one,
// and it opens in a card floating OVER the transcript (Joe, 2026-08-24 - the
// rail stealing layout width was the complaint). Preview is the odd one out: it
// toggles the docked rail instead, so the dial is one door to all four.

import { mountAskPanel, type AskPanelHandle } from "./ask-panel";
import { mountTodosPanel, type TodosPanelHandle } from "./todos-panel";
import { mountDraftsPanel, type DraftsPanelHandle } from "./drafts-panel";
import type { PreviewController } from "./preview-panel";
import "./fab-dial.css";

/** What the card can hold. Preview is reachable from the dial but never lives
 *  in the card - it stays docked, so it is not a CardPanel. */
export type CardPanel = "ask" | "todos" | "drafts";

type Surface = "rest" | "dial" | "card";

export interface FabDialDeps {
  /** Ask's hand-off target: fills the real composer, unsent. */
  onDraft(text: string): void;
  /** Toggles the docked Preview rail; null when this window has no rail. */
  preview: PreviewController | null;
}

export interface FabDialHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  /** Re-append the host after a pane innerHTML rebuild has detached it. */
  reattach(): void;
  close(): void;
  destroy(): void;
}

const DIAL = [
  { target: "ask", icon: "ph-chat-teardrop-dots", label: "Ask" },
  { target: "todos", icon: "ph-list-checks", label: "Todos" },
  { target: "drafts", icon: "ph-note-pencil", label: "Drafts" },
] as const;

class FabDial implements FabDialHandle {
  private pane: HTMLElement;
  private host: HTMLElement;
  private deps: FabDialDeps;
  private surface: Surface = "rest";
  private panel: CardPanel = "ask";
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private ask: AskPanelHandle | null = null;
  private todos: TodosPanelHandle | null = null;
  private drafts: DraftsPanelHandle | null = null;
  private liftObs: ResizeObserver | null = null;

  constructor(pane: HTMLElement, deps: FabDialDeps) {
    this.pane = pane;
    this.deps = deps;
    this.host = document.createElement("div");
    this.host.className = "fab-dial-host";
    this.host.addEventListener("click", this.onClick);
    document.addEventListener("keydown", this.onKeydown);
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
    // Absent while the card surface hides it; keep the last measurement so the
    // dial does not drop onto the composer for a frame.
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
    this.cwd = cwd;
    // No chat mounted means no transcript to ask about, so the FAB goes away
    // rather than floating over an empty pane.
    if (!sessionId) {
      this.surface = "rest";
      this.disposeBodies();
      this.liftObs?.disconnect();
      this.liftObs = null;
      this.host.remove();
      return;
    }
    // Always land closed: a card carried across a switch would be showing the
    // previous chat's threads. render() remounts the body at the new scope.
    this.surface = "rest";
    this.attach();
    this.render();
  }

  /** Callers rebuild the pane AFTER setSessionScope has already attached, so
   *  the host is orphaned by the time the new DOM lands. The host keeps its own
   *  subtree while detached, so re-appending restores it without a re-render. */
  reattach(): void {
    if (this.sessionId) this.attach();
  }

  close(): void {
    if (this.surface === "rest") return;
    this.surface = "rest";
    this.render();
  }

  private open(panel: CardPanel): void {
    this.panel = panel;
    this.surface = "card";
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-fab-toggle]")) {
      this.surface = this.surface === "rest" ? "dial" : "rest";
      this.render();
      return;
    }
    const item = el.closest<HTMLElement>("[data-dial]");
    if (item) {
      const target = item.dataset.dial!;
      if (target === "preview") {
        this.deps.preview?.toggle();
        this.surface = "rest";
        this.render();
        return;
      }
      this.open(target as CardPanel);
      return;
    }
    const spine = el.closest<HTMLElement>("[data-spine]");
    if (spine) {
      this.open(spine.dataset.spine as CardPanel);
      return;
    }
    if (el.closest("[data-card-close]")) this.close();
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || this.surface === "rest") return;
    // Never swallow Escape from a text field inside the card.
    const t = ev.target as HTMLElement | null;
    if (t?.matches("input, textarea")) return;
    this.close();
  };

  /** Rebuilds chrome, then mounts the card body only when it is actually
   *  shown - so a chat that never opens Ask never spawns its panel. */
  private render(): void {
    const railOpen = !!this.deps.preview?.isOpen();
    this.host.dataset.surface = this.surface;
    this.host.innerHTML =
      `<div class="fab-dial">` +
        DIAL.map(
          (d) =>
            `<button type="button" class="fab-dial-item" data-dial="${d.target}">` +
              `<span class="fab-dial-lb">${d.label}</span>` +
              `<span class="fab-dial-ic"><i class="ph ${d.icon}"></i></span>` +
            `</button>`,
        ).join("") +
        `<button type="button" class="fab-dial-item is-toggle${railOpen ? " is-on" : ""}" data-dial="preview">` +
          `<span class="fab-dial-lb">Preview<span class="fab-dial-side">side panel</span></span>` +
          `<span class="fab-dial-ic"><i class="ph ph-monitor-play"></i></span>` +
        `</button>` +
      `</div>` +
      (this.surface === "card" ? this.cardHtml() : "") +
      `<button type="button" class="fab-dial-fab" data-fab-toggle title="Ask, Todos, Drafts, Preview" ` +
        `aria-label="Ask, Todos, Drafts, Preview"><i class="ph ph-list"></i></button>`;

    this.disposeBodies();
    if (this.surface === "card") this.mountBody();
    // The FAB node above is brand new, so the last measurement is stale.
    this.syncLift();
  }

  private cardHtml(): string {
    const spine = DIAL.map(
      (d) =>
        `<button type="button" class="fab-spine-btn${this.panel === d.target ? " on" : ""}" ` +
          `data-spine="${d.target}" title="${d.label}"><i class="ph ${d.icon}"></i></button>`,
    ).join("");
    return (
      `<div class="fab-card">` +
        `<div class="fab-spine">${spine}<span class="fab-spine-grow"></span>` +
          `<button type="button" class="icon-btn-sq fab-spine-close" data-card-close title="Close">` +
            `<i class="ph ph-x"></i></button>` +
        `</div>` +
        `<div class="fab-card-body"></div>` +
      `</div>`
    );
  }

  private mountBody(): void {
    const body = this.host.querySelector<HTMLElement>(".fab-card-body");
    if (!body) return;
    if (this.panel === "ask") {
      this.ask = mountAskPanel(body, { onDraft: this.deps.onDraft });
      this.ask.setCwd(this.cwd);
      this.ask.setSessionScope(this.sessionId);
    } else if (this.panel === "drafts") {
      this.drafts = mountDraftsPanel(body);
      this.drafts.setSessionScope(this.sessionId);
    } else {
      this.todos = mountTodosPanel(body);
      this.todos.setSessionScope(this.sessionId);
    }
  }

  private disposeBodies(): void {
    this.ask?.destroy();
    this.ask = null;
    this.todos?.destroy();
    this.todos = null;
    this.drafts?.destroy();
    this.drafts = null;
  }

  destroy(): void {
    this.disposeBodies();
    this.liftObs?.disconnect();
    this.liftObs = null;
    this.host.removeEventListener("click", this.onClick);
    document.removeEventListener("keydown", this.onKeydown);
    this.host.remove();
  }
}

export function mountFabDial(pane: HTMLElement, deps: FabDialDeps): FabDialHandle {
  return new FabDial(pane, deps);
}
