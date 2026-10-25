// "Drafts" pane-window body: the project's draft messages, opened on
// people rather than on every message ever written. This chat's open drafts
// are pinned on top, then one row per person and per place; each ticket
// tracker in use (Shortcut, Linear) gets a tab with one row per ticket. Only
// open things show until the eye reveals the done ones, in place and quieter;
// there are no fold rows. One line per draft: state is an icon, never a word,
// and the text itself only shows once a draft is opened. Grouping rules live
// in drafts-grouping.ts; this module owns the list, the person and ticket
// views, drafts-editor.ts one open card.

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { DraftsEditor } from "./drafts-editor";
import { listHtml, personHtml, ticketHtml, type RenderCtx } from "./drafts-panel-render";
import { isOpen } from "./drafts-grouping";
import type { MessageDraft, Person } from "../../types/ipc.generated";
import "./drafts-panel.css";

export interface DraftsPanelHandle {
  setSessionScope(sessionId: string | null): void;
  openDraft(id: string): void;
  refresh(): void;
  destroy(): void;
}

interface DraftsView {
  drafts: MessageDraft[];
  people?: Person[];
}

type View =
  | { kind: "list" }
  | { kind: "person"; key: string }
  | { kind: "ticket"; key: string };

class DraftsPanel implements DraftsPanelHandle {
  private root: HTMLElement;
  private drafts: MessageDraft[] = [];
  private people: Person[] = [];
  private sessionId: string | null = null;
  private view: View = { kind: "list" };
  /** "people", or a tracker group's key. */
  private tab = "people";
  /** Done drafts stay hidden until the eye is on. Kept for this panel's
   *  lifetime only: a reopened panel starts on what is open. */
  private showDone = false;
  private openId: string | null = null;
  private pendingOpenId: string | null = null;
  private editor: DraftsEditor | null = null;
  /** What the list/person view last wrote into `root`; null while the editor owns it. */
  private lastHtml: string | null = null;
  private unlisten: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;
  /** Live view of this panel's state for the HTML builders. */
  private readonly renderCtx: RenderCtx = (() => {
    const panel = this;
    return {
      get drafts() { return panel.drafts; },
      get people() { return panel.people; },
      get sessionId() { return panel.sessionId; },
      get showDone() { return panel.showDone; },
      get tab() { return panel.tab; },
      resetTab() { panel.tab = "people"; },
      toList() { panel.view = { kind: "list" }; },
    };
  })();

  constructor(root: HTMLElement, private onOpenCount?: (n: number) => void) {
    this.root = root;
    this.root.classList.add("drafts-panel");
    this.root.addEventListener("click", this.onClick);
    void this.subscribeLive();
    this.focusHandler = () => this.refresh();
    window.addEventListener("focus", this.focusHandler);
    this.render();
  }

  setSessionScope(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.disposeEditor();
    this.sessionId = sessionId;
    this.drafts = [];
    this.people = [];
    this.view = { kind: "list" };
    this.tab = "people";
    this.showDone = false;
    this.openId = null;
    this.pendingOpenId = null;
    this.render();
    this.refresh();
  }

  /** Opens straight onto one card. The id has to survive the in-flight list
   *  fetch: at mount time nothing is loaded yet, and `render` drops an `openId`
   *  it cannot find, so it is applied once the drafts actually land. */
  openDraft(id: string): void {
    this.pendingOpenId = id;
    this.openId = null;
    this.refresh();
  }

  refresh(): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<DraftsView>("list_message_drafts", { sessionId: sid })
      .then((view) => {
        // A scope change mid-flight must not paint the previous project's cards.
        if (this.sessionId !== sid) return;
        this.drafts = Array.isArray(view?.drafts) ? view.drafts : [];
        this.people = Array.isArray(view?.people) ? view.people : [];
        const now = Date.now();
        this.onOpenCount?.(this.drafts.filter((d) => isOpen(d, now)).length);
        if (this.pendingOpenId) {
          const wanted = this.pendingOpenId;
          this.pendingOpenId = null;
          if (this.drafts.some((d) => d.id === wanted)) this.openId = wanted;
        }
        this.render();
      })
      .catch((err) => console.error("[drafts-panel] list_message_drafts failed", err));
  }

  destroy(): void {
    this.disposeEditor();
    this.root.removeEventListener("click", this.onClick);
    if (this.unlisten) {
      try { this.unlisten(); } catch { /* ignore */ }
      this.unlisten = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
  }

  private async subscribeLive(): Promise<void> {
    try {
      // Kebab, not the snake_case name it is published under: the daemon
      // renames it on the way out on both transports (`GLOBAL_EVENT_MAP`,
      // `handle_daemon_notification`), and the snake name silently matches
      // nothing.
      this.unlisten = await getTransport().listen<{ project_id?: string }>(
        "message-drafts-changed",
        () => this.refresh(),
      );
    } catch (err) {
      console.warn("[drafts-panel] listen(message-drafts-changed) failed", err);
    }
  }

  private disposeEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private render(): void {
    const open = this.drafts.find((d) => d.id === this.openId);
    if (this.openId && !open) {
      // Deleted underneath us, or a scope change: fall back to the list rather
      // than leaving a detached editor pointing at nothing.
      this.openId = null;
    }
    if (open && this.sessionId) {
      if (this.editor) {
        this.editor.update(open);
        return;
      }
      this.root.innerHTML = "";
      this.lastHtml = null;
      this.editor = new DraftsEditor(this.root, open, {
        sessionId: this.sessionId,
        onBack: () => this.closeEditor(),
        onChanged: () => this.refresh(),
      });
      return;
    }
    this.disposeEditor();
    const html = this.view.kind === "person" ? personHtml(this.renderCtx, this.view.key)
      : this.view.kind === "ticket" ? ticketHtml(this.renderCtx, this.view.key)
      : listHtml(this.renderCtx);
    // Clicking into an unfocused window fires `focus`, whose refresh lands
    // between mousedown and mouseup; replacing the row there swallows the
    // click. An unchanged list therefore keeps its DOM.
    if (html === this.lastHtml) return;
    const scroll = this.root.scrollTop;
    this.root.innerHTML = html;
    this.lastHtml = html;
    // A live refresh repaints the whole list; keep the reader where they were.
    this.root.scrollTop = scroll;
  }

  private closeEditor(): void {
    this.disposeEditor();
    this.openId = null;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-eye]")) {
      this.showDone = !this.showDone;
      this.render();
      return;
    }
    const tab = el.closest<HTMLElement>("[data-tab]");
    if (tab) {
      this.tab = tab.dataset.tab!;
      this.root.scrollTop = 0;
      this.render();
      return;
    }
    const person = el.closest<HTMLElement>("[data-person]");
    if (person) {
      this.view = { kind: "person", key: person.dataset.person! };
      this.root.scrollTop = 0;
      this.render();
      return;
    }
    const ticket = el.closest<HTMLElement>("[data-ticket]");
    if (ticket) {
      this.view = { kind: "ticket", key: ticket.dataset.ticket! };
      this.root.scrollTop = 0;
      this.render();
      return;
    }
    if (el.closest("[data-list]")) {
      this.view = { kind: "list" };
      this.render();
      return;
    }
    const card = el.closest<HTMLElement>("[data-open]");
    if (!card) return;
    this.openId = card.dataset.open ?? null;
    this.render();
  };
}

/** `onOpenCount` hears how many drafts are still open after every fetch: the
 *  split's strip shows it on the Drafts icon. */
export function mountDraftsPanel(root: HTMLElement, onOpenCount?: (n: number) => void): DraftsPanelHandle {
  return new DraftsPanel(root, onOpenCount);
}
