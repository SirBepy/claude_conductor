// "Drafts" pane-window body: the project's draft messages, opened on
// people rather than on every message ever written. This chat's open drafts
// are pinned on top, then one row per person, then one section per platform
// for drafts with no person. One line per draft: state is an icon, never a
// word, and the text itself only shows once a draft is opened. Grouping rules
// live in drafts-grouping.ts; this module owns the list and the person view,
// drafts-editor.ts one open card.

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { escapeHtml } from "../../shared/escape-html";
import { DraftsEditor } from "./drafts-editor";
import { currentVersion } from "../../shared/message-draft-utils";
import { groupDrafts, isOpen, variantFor, type PersonGroup, type PlatformGroup } from "./drafts-grouping";
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

/** "today", else "Oct 7". */
export function shortDate(iso: string, now: number): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (t.toDateString() === new Date(now).toDateString()) return "today";
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A stable pastel per name, so a person keeps one colour everywhere. */
function avatarHtml(name: string, big = false): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letter = escapeHtml(name.trim().charAt(0).toUpperCase() || "?");
  return `<span class="dr-av${big ? " lg" : ""}" style="--dr-av-hue:${h}" aria-hidden="true">${letter}</span>`;
}

type View = { kind: "list" } | { kind: "person"; key: string };

class DraftsPanel implements DraftsPanelHandle {
  private root: HTMLElement;
  private drafts: MessageDraft[] = [];
  private people: Person[] = [];
  private sessionId: string | null = null;
  private view: View = { kind: "list" };
  /** Folds the user opened, by key, for this panel's lifetime only. */
  private unfolded = new Set<string>();
  private openId: string | null = null;
  private pendingOpenId: string | null = null;
  private editor: DraftsEditor | null = null;
  /** What the list/person view last wrote into `root`; null while the editor owns it. */
  private lastHtml: string | null = null;
  private unlisten: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
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
    this.unfolded.clear();
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
    const html = this.view.kind === "person" ? this.personHtml(this.view.key) : this.listHtml();
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

  private groups() {
    return groupDrafts(this.drafts, this.people, this.sessionId, Date.now());
  }

  private listHtml(): string {
    if (this.drafts.length === 0) {
      return (
        `<div class="dr-empty">` +
          `<i class="ph ph-note-pencil"></i>` +
          `<p>No drafts yet.</p>` +
          `<p class="dr-empty-hint">Ask for a message to someone and it lands here, editable, instead of in the transcript.</p>` +
        `</div>`
      );
    }
    const g = this.groups();
    let html = "";
    const now = Date.now();
    const anyOpen = g.mine.length > 0 || g.people.some((p) => p.open > 0) ||
      g.platforms.some((x) => x.drafts.some((d) => isOpen(d, now)));
    if (!anyOpen) html += `<p class="dr-allclear"><i class="ph ph-check-circle"></i>All clear</p>`;
    if (g.mine.length) {
      html += `<h3 class="dr-group">From this chat</h3>` + g.mine.map((d) => this.cardHtml(d)).join("");
    }
    if (g.people.length || g.quietPeople.length) {
      html += `<h3 class="dr-group">People</h3>` + g.people.map((p) => this.personRowHtml(p)).join("");
      html += this.foldHtml("people", g.quietPeople.length, `${g.quietPeople.length} more ${g.quietPeople.length === 1 ? "person" : "people"}`,
        () => g.quietPeople.map((p) => this.personRowHtml(p)).join(""));
    }
    // Every platform keeps its own heading, even with nothing open: there are
    // few of them, and each folds its own old drafts already.
    html += g.platforms.map((x) => this.platformHtml(x)).join("");
    return html;
  }

  /** One platform's section: open drafts as cards, the rest one click away. */
  private platformHtml(section: PlatformGroup): string {
    const now = Date.now();
    const open = section.drafts.filter((d) => isOpen(d, now));
    const rest = section.drafts.filter((d) => !isOpen(d, now));
    return (
      `<h3 class="dr-group">${escapeHtml(section.name)}</h3>` +
      open.map((d) => this.cardHtml(d, section.key)).join("") +
      this.foldHtml(section.key, rest.length, `${rest.length} older`,
        () => rest.map((d) => this.cardHtml(d, section.key)).join(""))
    );
  }

  /** One line that expands in place; renders nothing when there is nothing to
   *  hide, so an empty fold never appears. */
  private foldHtml(key: string, count: number, label: string, body: () => string): string {
    if (count === 0) return "";
    const isOpenFold = this.unfolded.has(key);
    return (
      `<button type="button" class="dr-fold" data-fold="${escapeHtml(key)}" aria-expanded="${isOpenFold}">` +
        `<i class="ph ph-caret-right"></i>${escapeHtml(label)}` +
      `</button>` +
      (isOpenFold ? `<div class="dr-folded">${body()}</div>` : "")
    );
  }

  private personRowHtml(p: PersonGroup): string {
    const count = p.open > 0
      ? `<span class="dr-count" title="${p.open} not sent yet"><span class="dr-pending"></span>${p.open}</span>`
      : "";
    return (
      `<button type="button" class="dr-person" data-person="${escapeHtml(p.key)}"` +
        `${p.relationship ? ` title="${escapeHtml(p.relationship)}"` : ""}>` +
        avatarHtml(p.name, true) +
        `<span class="dr-person-text"><span class="dr-person-name">${escapeHtml(p.name)}</span></span>` +
        count +
      `</button>`
    );
  }

  private personHtml(key: string): string {
    const g = this.groups();
    const p = [...g.people, ...g.quietPeople].find((x) => x.key === key);
    if (!p) {
      // The last draft for this person went away underneath us.
      this.view = { kind: "list" };
      return this.listHtml();
    }
    const now = Date.now();
    const open = p.drafts.filter((d) => isOpen(d, now));
    const rest = p.drafts.filter((d) => !isOpen(d, now));
    const sub = p.personId ? p.relationship : "Not in your vault";
    return (
      `<div class="dr-head">` +
        `<button type="button" class="icon-btn-sq dr-icon" data-list title="Back to drafts"><i class="ph ph-arrow-left"></i></button>` +
        avatarHtml(p.name, true) +
        `<span class="dr-person-text">` +
          `<span class="dr-title">${escapeHtml(p.name)}</span>` +
          (sub ? `<span class="dr-person-sub">${escapeHtml(sub)}</span>` : "") +
        `</span>` +
      `</div>` +
      `<h3 class="dr-group">Open</h3>` +
      (open.length ? open.map((d) => this.cardHtml(d, key)).join("") : `<p class="dr-none">Nothing open.</p>`) +
      this.foldHtml(`sent:${key}`, rest.length, `${rest.length} older`,
        () => rest.map((d) => this.cardHtml(d, key)).join(""))
    );
  }

  /** One line: topic, state marks, date. Who it is for lives in the hover
   *  title, since a person's own view already says who. `groupKey` picks
   *  whose variant counts as "your edit" on a multi-person card. */
  private cardHtml(d: MessageDraft, groupKey?: string): string {
    const variant = groupKey ? variantFor(d, groupKey) : d.variants[0];
    const edited = variant ? currentVersion(variant)?.author === "user" : false;
    const now = Date.now();
    const live = isOpen(d, now);
    const mark = (icon: string, label: string) =>
      `<i class="ph ${icon} dr-mark" title="${label}" aria-label="${label}"></i>`;
    // A folded draft says why it folded: sent, put away, or just left unsent.
    const state = d.state === "archived" ? mark("ph-archive", "Archived")
      : d.state === "copied" ? mark("ph-paper-plane-tilt", "Sent")
      : live ? "" : mark("ph-hourglass-simple", "Never sent");
    const who = d.variants.map((v) => v.recipient).join(", ");
    const from = d.origin_session_id === this.sessionId ? "" : ` - from ${d.origin_label}`;
    return (
      `<button type="button" class="dr-card${live ? "" : " past"}" data-open="${escapeHtml(d.id)}" ` +
        `title="${escapeHtml(`To ${who}${from}`)}">` +
        `<span class="dr-card-top">` +
          (live && d.state === "needs-you" ? `<span class="dr-pending" title="Not sent yet"></span>` : "") +
          `<span class="dr-topic">${escapeHtml(d.topic)}</span>` +
          (edited ? mark("ph-pencil-simple", "Your edit") : "") +
          state +
          `<span class="dr-when">${shortDate(d.updated_at, now)}</span>` +
        `</span>` +
      `</button>`
    );
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    const fold = el.closest<HTMLElement>("[data-fold]");
    if (fold) {
      const key = fold.dataset.fold!;
      if (!this.unfolded.delete(key)) this.unfolded.add(key);
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

export function mountDraftsPanel(root: HTMLElement): DraftsPanelHandle {
  return new DraftsPanel(root);
}
