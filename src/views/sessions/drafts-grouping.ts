// How the Drafts panel sorts a project's drafts into "From this chat", one row
// per person, one row per place (Standup, Prompts...), and one tab per ticket
// tracker with one row per ticket. Pure data, no DOM, so the rules are
// testable on their own; drafts-panel.ts only renders what this returns.

import type { DraftVariant, MessageDraft, Person } from "../../types/ipc.generated";

/** A draft nobody has touched for a week stops counting as open: before this,
 *  14 of one project's drafts sat in "Needs you" for weeks because only Copy
 *  ever retired one. */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function isOpen(d: MessageDraft, now: number): boolean {
  if (d.state === "copied" || d.state === "archived") return false;
  const touched = Date.parse(d.updated_at);
  return Number.isNaN(touched) || now - touched < STALE_MS;
}

/** Platforms whose drafts are comments ON a ticket. Each gets its own tab once
 *  a project has drafts there, because one project's ticket comments outnumber
 *  everything else it drafts. */
export const TRACKERS = ["Shortcut", "Linear"] as const;

export interface PersonGroup {
  key: string;
  /** Vault id, or null for a plain-name recipient the vault doesn't know. */
  personId: string | null;
  name: string;
  relationship: string;
  drafts: MessageDraft[];
  open: number;
  /** Most recent `updated_at`, ms. */
  latest: number;
}

export interface PlatformGroup {
  key: string;
  name: string;
  drafts: MessageDraft[];
  open: number;
  latest: number;
}

export interface TicketGroup {
  key: string;
  /** "Shortcut", "Linear". */
  tracker: string;
  /** "sc-56160", "REV-7345", or null for comments that name no ticket. */
  ticket: string | null;
  /** The newest draft's topic with the ticket id taken out. */
  label: string;
  /** Who the comments went to, newest first; a ticket-wide comment adds no one. */
  people: string[];
  drafts: MessageDraft[];
  open: number;
  latest: number;
}

export interface TrackerGroup {
  key: string;
  name: string;
  tickets: TicketGroup[];
  open: number;
}

export interface DraftGroups {
  mine: MessageDraft[];
  /** Everyone, people with something open first, then newest first. */
  people: PersonGroup[];
  /** Platforms that are not trackers, same order. */
  places: PlatformGroup[];
  /** Trackers with drafts, in `TRACKERS` order. A tracker comment to a person
   *  is ALSO under that person: one draft, two ways in. */
  trackers: TrackerGroup[];
}

const norm = (s: string): string => s.trim().toLowerCase();

/** A recipient label that names the ticket rather than a person:
 *  "Shortcut ticket sc-56117", "sc-56117 comment", "REV-7345". */
const TICKET_LABEL = /shortcut|linear|ticket|comment|\bsc-\d/i;
const LINEAR_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;

/** Where one variant belongs on the People tab. A vault person wins; a variant
 *  with no person goes to its platform; a bare name with neither still reads
 *  as a person. So does a bare name on a tracker ("Johanna", a Shortcut comment
 *  the daemon recognised from its text): only a label naming the ticket makes
 *  a tracker variant ticket-wide. */
export function groupKeyOf(v: DraftVariant): string {
  if (v.person) return `p:${v.person}`;
  const namesTicket = TICKET_LABEL.test(v.recipient) || LINEAR_ID.test(v.recipient);
  if (v.platform && (!trackerOf(v) || namesTicket)) return `x:${norm(v.platform)}`;
  return `n:${norm(v.recipient)}`;
}

function trackerOf(v: DraftVariant): string | null {
  const p = v.platform ? norm(v.platform) : "";
  return TRACKERS.find((t) => norm(t) === p) ?? null;
}

/** The ticket a tracker draft is about, from its topic, else its recipient
 *  label. A Shortcut topic often leads with the bare number ("56159 two-drafts
 *  repro"); a Linear id is always prefixed ("REV-7345"). */
export function ticketOf(d: MessageDraft, tracker: string): string | null {
  for (const text of [d.topic, ...d.variants.map((v) => v.recipient)]) {
    if (tracker === "Shortcut") {
      const m = text.match(/\bsc-(\d+)\b/i) ?? (text === d.topic ? text.match(/^(\d{4,6})\b/) : null);
      if (m) return `sc-${m[1]}`;
    } else {
      const m = text.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/** "sc-56157 retest note" -> "retest note". The bare number goes too, since
 *  Shortcut topics often carry the id without its prefix. */
export function withoutTicket(topic: string, ticket: string | null): string {
  if (!ticket) return topic;
  const num = ticket.replace(/^sc-/i, "");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = topic
    .replace(new RegExp(`\\b${esc(ticket)}\\b`, "gi"), "")
    .replace(new RegExp(`\\b${esc(num)}\\b`, "g"), "")
    .replace(/^[\s,:+-]+|[\s,:+-]+$/g, "")
    .replace(/\s{2,}/g, " ");
  return out || topic;
}

function stamp(d: MessageDraft | undefined): number {
  if (!d) return 0;
  const t = Date.parse(d.updated_at);
  return Number.isNaN(t) ? 0 : t;
}

const newestFirst = (a: MessageDraft, b: MessageDraft): number => stamp(b) - stamp(a);
const liveFirst = (a: { open: number; latest: number }, b: { open: number; latest: number }): number =>
  Number(b.open > 0) - Number(a.open > 0) || b.latest - a.latest;

/** Adds `d` once, keeping the open count and newest stamp in step. */
function take(g: { drafts: MessageDraft[]; open: number; latest: number }, d: MessageDraft, now: number): void {
  if (g.drafts.includes(d)) return;
  g.drafts.push(d);
  if (isOpen(d, now)) g.open++;
  g.latest = Math.max(g.latest, stamp(d));
}

export function groupDrafts(
  drafts: MessageDraft[],
  people: Person[],
  sessionId: string | null,
  now: number,
): DraftGroups {
  const byId = new Map(people.map((p) => [p.id, p]));
  const persons = new Map<string, PersonGroup>();
  const places = new Map<string, PlatformGroup>();
  const tickets = new Map<string, Map<string, TicketGroup>>();

  for (const d of drafts) {
    for (const v of d.variants) {
      const key = groupKeyOf(v);
      const tracker = trackerOf(v);
      const vault = v.person ? byId.get(v.person) : undefined;
      if (tracker) {
        const ticket = ticketOf(d, tracker);
        const tkey = `t:${norm(tracker)}:${ticket ?? ""}`;
        const byTicket = tickets.get(tracker) ?? new Map<string, TicketGroup>();
        const t = byTicket.get(tkey) ?? { key: tkey, tracker, ticket, label: "", people: [], drafts: [], open: 0, latest: 0 };
        take(t, d, now);
        if (!key.startsWith("x:")) {
          const who = vault?.name ?? v.person ?? v.recipient;
          if (!t.people.includes(who)) t.people.push(who);
        }
        byTicket.set(tkey, t);
        tickets.set(tracker, byTicket);
        // A ticket-wide comment lives only under its ticket.
        if (key.startsWith("x:")) continue;
      }
      if (key.startsWith("x:")) {
        const g = places.get(key) ?? { key, name: v.platform!.trim(), drafts: [], open: 0, latest: 0 };
        take(g, d, now);
        places.set(key, g);
        continue;
      }
      const g = persons.get(key) ?? {
        key,
        personId: v.person ?? null,
        name: vault?.name ?? v.person ?? v.recipient,
        relationship: vault?.relationship ?? "",
        drafts: [],
        open: 0,
        latest: 0,
      };
      take(g, d, now);
      persons.set(key, g);
    }
  }

  const all = [...persons.values()];
  for (const g of all) g.drafts.sort(newestFirst);
  const sections = [...places.values()];
  for (const g of sections) g.drafts.sort(newestFirst);
  const trackers: TrackerGroup[] = [];
  for (const name of TRACKERS) {
    const byTicket = tickets.get(name);
    if (!byTicket) continue;
    const rows = [...byTicket.values()];
    for (const t of rows) {
      t.drafts.sort(newestFirst);
      t.label = withoutTicket(t.drafts[0]?.topic ?? "", t.ticket);
    }
    trackers.push({ key: `k:${norm(name)}`, name, tickets: rows.sort(liveFirst), open: rows.reduce((n, t) => n + t.open, 0) });
  }

  return {
    mine: drafts.filter((d) => d.origin_session_id === sessionId && isOpen(d, now)).sort(newestFirst),
    people: all.sort(liveFirst),
    places: sections.sort(liveFirst),
    trackers,
  };
}

/** The variant a person's view should show for this draft: theirs if the
 *  card has several recipients, else the only one. */
export function variantFor(d: MessageDraft, groupKey: string): DraftVariant | undefined {
  return d.variants.find((v) => groupKeyOf(v) === groupKey) ?? d.variants[0];
}

/** The variant a ticket view should show: the one posted on that tracker,
 *  since one card can hold an email to one person and a Shortcut comment to
 *  another. */
export function variantOn(d: MessageDraft, tracker: string): DraftVariant | undefined {
  return d.variants.find((v) => trackerOf(v) === tracker) ?? d.variants[0];
}
