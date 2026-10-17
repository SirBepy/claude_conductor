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
import { escapeHtml } from "../../shared/escape-html";
import { DraftsEditor } from "./drafts-editor";
import { currentVersion } from "../../shared/message-draft-utils";
import {
  groupDrafts,
  groupKeyOf,
  isOpen,
  variantFor,
  variantOn,
  withoutTicket,
  type DraftGroups,
  type PersonGroup,
  type PlatformGroup,
  type TicketGroup,
} from "./drafts-grouping";
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

const PLATFORM_ICON: Record<string, string> = {
  shortcut: "ph-ticket",
  linear: "ph-kanban",
  slack: "ph-slack-logo",
  discord: "ph-discord-logo",
  email: "ph-envelope-simple",
  github: "ph-github-logo",
  standup: "ph-users-three",
  prompts: "ph-chat-circle-dots",
};

/** A place's round badge, same footprint as a person's avatar. */
function glyphHtml(platform: string, big = false): string {
  const icon = PLATFORM_ICON[platform.trim().toLowerCase()] ?? "ph-hash";
  return `<span class="dr-glyph${big ? " lg" : ""}" aria-hidden="true"><i class="ph ${icon}"></i></span>`;
}

type View =
  | { kind: "list" }
  | { kind: "person"; key: string }
  | { kind: "ticket"; key: string };

/** Card options: whose variant counts as "your edit", and whether a ticket
 *  view's line shows who it went to and drops the ticket id it already shows. */
interface CardOpts {
  groupKey?: string;
  face?: boolean;
  ticket?: string | null;
  /** A ticket view's tracker: picks the variant posted there. */
  tracker?: string;
}

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
    const html = this.view.kind === "person" ? this.personHtml(this.view.key)
      : this.view.kind === "ticket" ? this.ticketHtml(this.view.key)
      : this.listHtml();
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

  private groups(): DraftGroups {
    return groupDrafts(this.drafts, this.people, this.sessionId, Date.now());
  }

  /** The eye, or nothing when there is nothing done to reveal. */
  private eyeHtml(anyDone: boolean, extra = ""): string {
    if (!anyDone) return "";
    const on = this.showDone;
    const label = on ? "Hide sent and archived drafts" : "Show sent and archived drafts";
    return (
      `<button type="button" class="icon-btn-sq dr-icon dr-eye${on ? " on" : ""}${extra}" data-eye ` +
        `aria-pressed="${on}" title="${label}" aria-label="${label}">` +
        `<i class="ph ${on ? "ph-eye" : "ph-eye-slash"}"></i>` +
      `</button>`
    );
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
    const tracker = g.trackers.find((t) => t.key === this.tab);
    if (!tracker) this.tab = "people";
    const now = Date.now();
    const anyDone = tracker
      ? tracker.tickets.some((t) => t.drafts.some((d) => !isOpen(d, now)))
      : this.drafts.some((d) => !isOpen(d, now));
    let html = "";
    if (g.trackers.length) {
      const tabs = [{ key: "people", name: "People", open: 0 }, ...g.trackers];
      html +=
        `<div class="dr-tabs" role="tablist">` +
          tabs.map((t) =>
            `<button type="button" class="dr-tab${this.tab === t.key ? " on" : ""}" role="tab" ` +
              `aria-selected="${this.tab === t.key}" data-tab="${escapeHtml(t.key)}">${escapeHtml(t.name)}</button>`).join("") +
          this.eyeHtml(anyDone) +
        `</div>`;
    } else {
      html += this.eyeHtml(anyDone, " floating");
    }
    return html + (tracker ? this.trackerListHtml(tracker.tickets) : this.peopleListHtml(g));
  }

  private peopleListHtml(g: DraftGroups): string {
    const livePeople = g.people.filter((p) => p.open > 0);
    const livePlaces = g.places.filter((x) => x.open > 0);
    let html = "";
    if (!g.mine.length && !livePeople.length && !livePlaces.length) {
      html += `<p class="dr-allclear"><i class="ph ph-check-circle"></i>All clear</p>`;
    }
    if (g.mine.length) {
      html += `<h3 class="dr-group">From this chat</h3>` + g.mine.map((d) => this.cardHtml(d)).join("");
    }
    if (livePeople.length) html += `<h3 class="dr-group">People</h3>` + livePeople.map((p) => this.personRowHtml(p)).join("");
    if (livePlaces.length) html += `<h3 class="dr-group">Places</h3>` + livePlaces.map((x) => this.placeRowHtml(x)).join("");
    return html + this.quietHtml([
      ...g.people.filter((p) => p.open === 0).map((p) => this.personRowHtml(p)),
      ...g.places.filter((x) => x.open === 0).map((x) => this.placeRowHtml(x)),
    ]);
  }

  private trackerListHtml(tickets: TicketGroup[]): string {
    const live = tickets.filter((t) => t.open > 0);
    const head = live.length
      ? `<div class="dr-gap"></div>` + live.map((t) => this.ticketRowHtml(t)).join("")
      : `<p class="dr-allclear"><i class="ph ph-check-circle"></i>All clear</p>`;
    return head + this.quietHtml(tickets.filter((t) => t.open === 0).map((t) => this.ticketRowHtml(t)));
  }

  /** Everything with nothing open, after a hairline, only with the eye on.
   *  Never a fold: the eye is the one control. */
  private quietHtml(items: string[]): string {
    if (!this.showDone || items.length === 0) return "";
    return `<div class="dr-quiet">${items.join("")}</div>`;
  }

  private countHtml(open: number): string {
    return open > 0
      ? `<span class="dr-count" title="${open} not sent yet"><span class="dr-pending"></span>${open}</span>`
      : "";
  }

  private personRowHtml(p: PersonGroup): string {
    return (
      `<button type="button" class="dr-person" data-person="${escapeHtml(p.key)}"` +
        `${p.relationship ? ` title="${escapeHtml(p.relationship)}"` : ""}>` +
        avatarHtml(p.name, true) +
        `<span class="dr-person-text"><span class="dr-person-name">${escapeHtml(p.name)}</span></span>` +
        this.countHtml(p.open) +
      `</button>`
    );
  }

  private placeRowHtml(x: PlatformGroup): string {
    return (
      `<button type="button" class="dr-person" data-person="${escapeHtml(x.key)}">` +
        glyphHtml(x.name, true) +
        `<span class="dr-person-text"><span class="dr-person-name">${escapeHtml(x.name)}</span></span>` +
        this.countHtml(x.open) +
      `</button>`
    );
  }

  /** Ticket id, what the newest comment is about, then who it went to. */
  private ticketRowHtml(t: TicketGroup): string {
    const faces = t.people.slice(0, 3).map((n) => avatarHtml(n)).join("");
    return (
      `<button type="button" class="dr-person dr-ticket" data-ticket="${escapeHtml(t.key)}" title="${escapeHtml(t.people.join(", "))}">` +
        `<span class="dr-glyph lg" aria-hidden="true"><i class="ph ph-ticket"></i></span>` +
        `<span class="dr-ticket-id">${escapeHtml(t.ticket ?? "No ticket")}</span>` +
        `<span class="dr-ticket-label">${t.ticket ? escapeHtml(t.label) : ""}</span>` +
        (faces ? `<span class="dr-faces">${faces}</span>` : "") +
        this.countHtml(t.open) +
      `</button>`
    );
  }

  /** Header for a person, place or ticket view; the eye sits on its right. */
  private headHtml(lead: string, title: string, sub: string, anyDone: boolean): string {
    return (
      `<div class="dr-head">` +
        `<button type="button" class="icon-btn-sq dr-icon" data-list title="Back to drafts"><i class="ph ph-arrow-left"></i></button>` +
        lead +
        `<span class="dr-person-text">` +
          `<span class="dr-title">${escapeHtml(title)}</span>` +
          (sub ? `<span class="dr-person-sub">${escapeHtml(sub)}</span>` : "") +
        `</span>` +
        this.eyeHtml(anyDone) +
      `</div>`
    );
  }

  /** Open drafts as cards, then, with the eye on, the done ones as lines. */
  private draftsHtml(drafts: MessageDraft[], opts: CardOpts): string {
    const now = Date.now();
    const open = drafts.filter((d) => isOpen(d, now));
    const done = drafts.filter((d) => !isOpen(d, now));
    return (
      `<div class="dr-gap"></div>` +
      (open.length ? open.map((d) => this.cardHtml(d, opts)).join("") : `<p class="dr-none">Nothing open.</p>`) +
      this.quietHtml(done.map((d) => this.lineHtml(d, opts)))
    );
  }

  private personHtml(key: string): string {
    const g = this.groups();
    const p = g.people.find((x) => x.key === key);
    const x = p ? undefined : g.places.find((y) => y.key === key);
    if (!p && !x) {
      // The last draft for this person went away underneath us.
      this.view = { kind: "list" };
      return this.listHtml();
    }
    const now = Date.now();
    const drafts = (p ?? x)!.drafts;
    const anyDone = drafts.some((d) => !isOpen(d, now));
    const head = p
      ? this.headHtml(avatarHtml(p.name, true), p.name, p.personId ? p.relationship : "Not in your vault", anyDone)
      : this.headHtml(glyphHtml(x!.name, true), x!.name, "", anyDone);
    return head + this.draftsHtml(drafts, { groupKey: key });
  }

  private ticketHtml(key: string): string {
    const t = this.groups().trackers.flatMap((k) => k.tickets).find((x) => x.key === key);
    if (!t) {
      this.view = { kind: "list" };
      return this.listHtml();
    }
    const anyDone = t.drafts.some((d) => !isOpen(d, Date.now()));
    const lead = `<span class="dr-glyph lg" aria-hidden="true"><i class="ph ph-ticket"></i></span>`;
    return this.headHtml(lead, t.ticket ?? "No ticket", t.people.join(", "), anyDone) +
      this.draftsHtml(t.drafts, { face: true, ticket: t.ticket, tracker: t.tracker });
  }

  /** A ticket view's lines say who each went to; a ticket-wide comment shows
   *  its platform instead of a face. */
  private faceHtml(d: MessageDraft, opts: CardOpts): string {
    const v = this.variantOf(d, opts);
    if (!v) return "";
    if (v.platform && groupKeyOf(v).startsWith("x:")) return glyphHtml(v.platform);
    const vault = v.person ? this.people.find((p) => p.id === v.person) : undefined;
    return avatarHtml(vault?.name ?? v.person ?? v.recipient);
  }

  /** The variant a row speaks for: the person's or place's in their view,
   *  the one posted on the tracker in a ticket view, else the first. */
  private variantOf(d: MessageDraft, opts: CardOpts) {
    if (opts.groupKey) return variantFor(d, opts.groupKey);
    if (opts.tracker) return variantOn(d, opts.tracker);
    return d.variants[0];
  }

  private marks(d: MessageDraft, opts: CardOpts): { edited: string; state: string } {
    const variant = this.variantOf(d, opts);
    const mark = (icon: string, label: string) =>
      `<i class="ph ${icon} dr-mark" title="${label}" aria-label="${label}"></i>`;
    const edited = variant && currentVersion(variant)?.author === "user" ? mark("ph-pencil-simple", "Your edit") : "";
    // A done draft says why it is done: sent, put away, or left unsent a week.
    const state = d.state === "archived" ? mark("ph-archive", "Archived")
      : d.state === "copied" ? mark("ph-paper-plane-tilt", "Sent")
      : isOpen(d, Date.now()) ? "" : mark("ph-hourglass-simple", "Outdated: a week untouched, never sent");
    return { edited, state };
  }

  private titleOf(d: MessageDraft): string {
    const who = d.variants.map((v) => v.recipient).join(", ");
    const from = d.origin_session_id === this.sessionId ? "" : ` - from ${d.origin_label}`;
    return escapeHtml(`To ${who}${from}`);
  }

  /** One line: topic, state marks, date. Who it is for lives in the hover
   *  title, since a person's own view already says who. `groupKey` picks
   *  whose variant counts as "your edit" on a multi-person card. */
  private cardHtml(d: MessageDraft, opts: CardOpts = {}): string {
    const { edited, state } = this.marks(d, opts);
    const topic = opts.ticket !== undefined ? withoutTicket(d.topic, opts.ticket) : d.topic;
    return (
      `<button type="button" class="dr-card" data-open="${escapeHtml(d.id)}" title="${this.titleOf(d)}">` +
        `<span class="dr-card-top">` +
          (d.state === "needs-you" ? `<span class="dr-pending" title="Not sent yet"></span>` : "") +
          (opts.face ? this.faceHtml(d, opts) : "") +
          `<span class="dr-topic">${escapeHtml(topic)}</span>` +
          edited +
          state +
          `<span class="dr-when">${shortDate(d.updated_at, Date.now())}</span>` +
        `</span>` +
      `</button>`
    );
  }

  /** A done draft revealed by the eye: no card, one small grey line. */
  private lineHtml(d: MessageDraft, opts: CardOpts): string {
    const { edited, state } = this.marks(d, opts);
    const topic = opts.ticket !== undefined ? withoutTicket(d.topic, opts.ticket) : d.topic;
    return (
      `<button type="button" class="dr-line" data-open="${escapeHtml(d.id)}" title="${this.titleOf(d)}">` +
        (opts.face ? this.faceHtml(d, opts) : "") +
        `<span class="dr-line-topic">${escapeHtml(topic)}</span>` +
        edited +
        state +
        `<span class="dr-when">${shortDate(d.updated_at, Date.now())}</span>` +
      `</button>`
    );
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

export function mountDraftsPanel(root: HTMLElement): DraftsPanelHandle {
  return new DraftsPanel(root);
}
