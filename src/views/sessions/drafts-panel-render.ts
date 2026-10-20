// The Drafts panel's HTML builders: pure functions of the panel's state, so
// drafts-panel.ts keeps only state, fetching and event wiring.

import { escapeHtml } from "../../shared/escape-html";
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

/** What the builders read from the panel. Live getters, not a snapshot: the
 *  list view resets `tab` and the person/ticket views reset `view` mid-build,
 *  and later reads in the same build must see the reset. */
export interface RenderCtx {
  readonly drafts: MessageDraft[];
  readonly people: Person[];
  readonly sessionId: string | null;
  readonly showDone: boolean;
  readonly tab: string;
  resetTab(): void;
  toList(): void;
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

/** Card options: whose variant counts as "your edit", and whether a ticket
 *  view's line shows who it went to and drops the ticket id it already shows. */
interface CardOpts {
  groupKey?: string;
  face?: boolean;
  ticket?: string | null;
  /** A ticket view's tracker: picks the variant posted there. */
  tracker?: string;
}

function groups(ctx: RenderCtx): DraftGroups {
  return groupDrafts(ctx.drafts, ctx.people, ctx.sessionId, Date.now());
}

/** The eye, or nothing when there is nothing done to reveal. */
function eyeHtml(ctx: RenderCtx, anyDone: boolean, extra = ""): string {
  if (!anyDone) return "";
  const on = ctx.showDone;
  const label = on ? "Hide sent and archived drafts" : "Show sent and archived drafts";
  return (
    `<button type="button" class="icon-btn-sq dr-icon dr-eye${on ? " on" : ""}${extra}" data-eye ` +
      `aria-pressed="${on}" title="${label}" aria-label="${label}">` +
      `<i class="ph ${on ? "ph-eye" : "ph-eye-slash"}"></i>` +
    `</button>`
  );
}

export function listHtml(ctx: RenderCtx): string {
  if (ctx.drafts.length === 0) {
    return (
      `<div class="dr-empty">` +
        `<i class="ph ph-note-pencil"></i>` +
        `<p>No drafts yet.</p>` +
        `<p class="dr-empty-hint">Ask for a message to someone and it lands here, editable, instead of in the transcript.</p>` +
      `</div>`
    );
  }
  const g = groups(ctx);
  const tracker = g.trackers.find((t) => t.key === ctx.tab);
  if (!tracker) ctx.resetTab();
  const now = Date.now();
  const anyDone = tracker
    ? tracker.tickets.some((t) => t.drafts.some((d) => !isOpen(d, now)))
    : ctx.drafts.some((d) => !isOpen(d, now));
  let html = "";
  if (g.trackers.length) {
    const tabs = [{ key: "people", name: "People", open: 0 }, ...g.trackers];
    html +=
      `<div class="dr-tabs" role="tablist">` +
        tabs.map((t) =>
          `<button type="button" class="dr-tab${ctx.tab === t.key ? " on" : ""}" role="tab" ` +
            `aria-selected="${ctx.tab === t.key}" data-tab="${escapeHtml(t.key)}">${escapeHtml(t.name)}</button>`).join("") +
        eyeHtml(ctx, anyDone) +
      `</div>`;
  } else {
    html += eyeHtml(ctx, anyDone, " floating");
  }
  return html + (tracker ? trackerListHtml(ctx, tracker.tickets) : peopleListHtml(ctx, g));
}

function peopleListHtml(ctx: RenderCtx, g: DraftGroups): string {
  const livePeople = g.people.filter((p) => p.open > 0);
  const livePlaces = g.places.filter((x) => x.open > 0);
  let html = "";
  if (!g.mine.length && !livePeople.length && !livePlaces.length) {
    html += `<p class="dr-allclear"><i class="ph ph-check-circle"></i>All clear</p>`;
  }
  if (g.mine.length) {
    html += `<h3 class="dr-group">From this chat</h3>` + g.mine.map((d) => cardHtml(ctx, d)).join("");
  }
  if (livePeople.length) html += `<h3 class="dr-group">People</h3>` + livePeople.map((p) => personRowHtml(p)).join("");
  if (livePlaces.length) html += `<h3 class="dr-group">Places</h3>` + livePlaces.map((x) => placeRowHtml(x)).join("");
  return html + quietHtml(ctx, [
    ...g.people.filter((p) => p.open === 0).map((p) => personRowHtml(p)),
    ...g.places.filter((x) => x.open === 0).map((x) => placeRowHtml(x)),
  ]);
}

function trackerListHtml(ctx: RenderCtx, tickets: TicketGroup[]): string {
  const live = tickets.filter((t) => t.open > 0);
  const head = live.length
    ? `<div class="dr-gap"></div>` + live.map((t) => ticketRowHtml(t)).join("")
    : `<p class="dr-allclear"><i class="ph ph-check-circle"></i>All clear</p>`;
  return head + quietHtml(ctx, tickets.filter((t) => t.open === 0).map((t) => ticketRowHtml(t)));
}

/** Everything with nothing open, after a hairline, only with the eye on.
 *  Never a fold: the eye is the one control. */
function quietHtml(ctx: RenderCtx, items: string[]): string {
  if (!ctx.showDone || items.length === 0) return "";
  return `<div class="dr-quiet">${items.join("")}</div>`;
}

function countHtml(open: number): string {
  return open > 0
    ? `<span class="dr-count" title="${open} not sent yet"><span class="dr-pending"></span>${open}</span>`
    : "";
}

function personRowHtml(p: PersonGroup): string {
  return (
    `<button type="button" class="dr-person" data-person="${escapeHtml(p.key)}"` +
      `${p.relationship ? ` title="${escapeHtml(p.relationship)}"` : ""}>` +
      avatarHtml(p.name, true) +
      `<span class="dr-person-text"><span class="dr-person-name">${escapeHtml(p.name)}</span></span>` +
      countHtml(p.open) +
    `</button>`
  );
}

function placeRowHtml(x: PlatformGroup): string {
  return (
    `<button type="button" class="dr-person" data-person="${escapeHtml(x.key)}">` +
      glyphHtml(x.name, true) +
      `<span class="dr-person-text"><span class="dr-person-name">${escapeHtml(x.name)}</span></span>` +
      countHtml(x.open) +
    `</button>`
  );
}

/** Ticket id, what the newest comment is about, then who it went to. */
function ticketRowHtml(t: TicketGroup): string {
  const faces = t.people.slice(0, 3).map((n) => avatarHtml(n)).join("");
  return (
    `<button type="button" class="dr-person dr-ticket" data-ticket="${escapeHtml(t.key)}" title="${escapeHtml(t.people.join(", "))}">` +
      `<span class="dr-glyph lg" aria-hidden="true"><i class="ph ph-ticket"></i></span>` +
      `<span class="dr-ticket-id">${escapeHtml(t.ticket ?? "No ticket")}</span>` +
      `<span class="dr-ticket-label">${t.ticket ? escapeHtml(t.label) : ""}</span>` +
      (faces ? `<span class="dr-faces">${faces}</span>` : "") +
      countHtml(t.open) +
    `</button>`
  );
}

/** Header for a person, place or ticket view; the eye sits on its right. */
function headHtml(ctx: RenderCtx, lead: string, title: string, sub: string, anyDone: boolean): string {
  return (
    `<div class="dr-head">` +
      `<button type="button" class="icon-btn-sq dr-icon" data-list title="Back to drafts"><i class="ph ph-arrow-left"></i></button>` +
      lead +
      `<span class="dr-person-text">` +
        `<span class="dr-title">${escapeHtml(title)}</span>` +
        (sub ? `<span class="dr-person-sub">${escapeHtml(sub)}</span>` : "") +
      `</span>` +
      eyeHtml(ctx, anyDone) +
    `</div>`
  );
}

/** Open drafts as cards, then, with the eye on, the done ones as lines. */
function draftsHtml(ctx: RenderCtx, drafts: MessageDraft[], opts: CardOpts): string {
  const now = Date.now();
  const open = drafts.filter((d) => isOpen(d, now));
  const done = drafts.filter((d) => !isOpen(d, now));
  return (
    `<div class="dr-gap"></div>` +
    (open.length ? open.map((d) => cardHtml(ctx, d, opts)).join("") : `<p class="dr-none">Nothing open.</p>`) +
    quietHtml(ctx, done.map((d) => lineHtml(ctx, d, opts)))
  );
}

export function personHtml(ctx: RenderCtx, key: string): string {
  const g = groups(ctx);
  const p = g.people.find((x) => x.key === key);
  const x = p ? undefined : g.places.find((y) => y.key === key);
  if (!p && !x) {
    // The last draft for this person went away underneath us.
    ctx.toList();
    return listHtml(ctx);
  }
  const now = Date.now();
  const drafts = (p ?? x)!.drafts;
  const anyDone = drafts.some((d) => !isOpen(d, now));
  const head = p
    ? headHtml(ctx, avatarHtml(p.name, true), p.name, p.personId ? p.relationship : "Not in your vault", anyDone)
    : headHtml(ctx, glyphHtml(x!.name, true), x!.name, "", anyDone);
  return head + draftsHtml(ctx, drafts, { groupKey: key });
}

export function ticketHtml(ctx: RenderCtx, key: string): string {
  const t = groups(ctx).trackers.flatMap((k) => k.tickets).find((x) => x.key === key);
  if (!t) {
    ctx.toList();
    return listHtml(ctx);
  }
  const anyDone = t.drafts.some((d) => !isOpen(d, Date.now()));
  const lead = `<span class="dr-glyph lg" aria-hidden="true"><i class="ph ph-ticket"></i></span>`;
  return headHtml(ctx, lead, t.ticket ?? "No ticket", t.people.join(", "), anyDone) +
    draftsHtml(ctx, t.drafts, { face: true, ticket: t.ticket, tracker: t.tracker });
}

/** A ticket view's lines say who each went to; a ticket-wide comment shows
 *  its platform instead of a face. */
function faceHtml(ctx: RenderCtx, d: MessageDraft, opts: CardOpts): string {
  const v = variantOf(d, opts);
  if (!v) return "";
  if (v.platform && groupKeyOf(v).startsWith("x:")) return glyphHtml(v.platform);
  const vault = v.person ? ctx.people.find((p) => p.id === v.person) : undefined;
  return avatarHtml(vault?.name ?? v.person ?? v.recipient);
}

/** The variant a row speaks for: the person's or place's in their view,
 *  the one posted on the tracker in a ticket view, else the first. */
function variantOf(d: MessageDraft, opts: CardOpts) {
  if (opts.groupKey) return variantFor(d, opts.groupKey);
  if (opts.tracker) return variantOn(d, opts.tracker);
  return d.variants[0];
}

function marks(d: MessageDraft, opts: CardOpts): { edited: string; state: string } {
  const variant = variantOf(d, opts);
  const mark = (icon: string, label: string) =>
    `<i class="ph ${icon} dr-mark" title="${label}" aria-label="${label}"></i>`;
  const edited = variant && currentVersion(variant)?.author === "user" ? mark("ph-pencil-simple", "Your edit") : "";
  // A done draft says why it is done: sent, put away, or left unsent a week.
  const state = d.state === "archived" ? mark("ph-archive", "Archived")
    : d.state === "copied" ? mark("ph-paper-plane-tilt", "Sent")
    : isOpen(d, Date.now()) ? "" : mark("ph-hourglass-simple", "Outdated: a week untouched, never sent");
  return { edited, state };
}

function titleOf(ctx: RenderCtx, d: MessageDraft): string {
  const who = d.variants.map((v) => v.recipient).join(", ");
  const from = d.origin_session_id === ctx.sessionId ? "" : ` - from ${d.origin_label}`;
  return escapeHtml(`To ${who}${from}`);
}

/** One line: topic, state marks, date. Who it is for lives in the hover
 *  title, since a person's own view already says who. `groupKey` picks
 *  whose variant counts as "your edit" on a multi-person card. */
function cardHtml(ctx: RenderCtx, d: MessageDraft, opts: CardOpts = {}): string {
  const { edited, state } = marks(d, opts);
  const topic = opts.ticket !== undefined ? withoutTicket(d.topic, opts.ticket) : d.topic;
  return (
    `<button type="button" class="dr-card" data-open="${escapeHtml(d.id)}" title="${titleOf(ctx, d)}">` +
      `<span class="dr-card-top">` +
        (d.state === "needs-you" ? `<span class="dr-pending" title="Not sent yet"></span>` : "") +
        (opts.face ? faceHtml(ctx, d, opts) : "") +
        `<span class="dr-topic">${escapeHtml(topic)}</span>` +
        edited +
        state +
        `<span class="dr-when">${shortDate(d.updated_at, Date.now())}</span>` +
      `</span>` +
    `</button>`
  );
}

/** A done draft revealed by the eye: no card, one small grey line. */
function lineHtml(ctx: RenderCtx, d: MessageDraft, opts: CardOpts): string {
  const { edited, state } = marks(d, opts);
  const topic = opts.ticket !== undefined ? withoutTicket(d.topic, opts.ticket) : d.topic;
  return (
    `<button type="button" class="dr-line" data-open="${escapeHtml(d.id)}" title="${titleOf(ctx, d)}">` +
      (opts.face ? faceHtml(ctx, d, opts) : "") +
      `<span class="dr-line-topic">${escapeHtml(topic)}</span>` +
      edited +
      state +
      `<span class="dr-when">${shortDate(d.updated_at, Date.now())}</span>` +
    `</button>`
  );
}
